import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import { parseBenchCaseManifest, verifyCaseId } from '../case/manifest';
import { readTeaArchive } from '../tea/teaZip';
import { pairLabel } from './coveringArray';
import type { GeneratorSpec, GeneratorTemplate } from './generate';
import { generateCases } from './generate';

const tables = {
  customers: `tbl${'c'.repeat(16)}`,
  orders: `tbl${'o'.repeat(16)}`,
};
const fields = {
  name: `fld${'n'.repeat(16)}`,
  tier: `fld${'t'.repeat(16)}`,
  title: `fld${'i'.repeat(16)}`,
  amount: `fld${'a'.repeat(16)}`,
  customer: `fld${'l'.repeat(16)}`,
  customerName: `fld${'u'.repeat(16)}`,
  tierLookup: `fld${'z'.repeat(16)}`,
  tax: `fld${'x'.repeat(16)}`,
  taxLabel: `fld${'y'.repeat(16)}`,
};

const customersStructure = {
  tables: [
    {
      id: tables.customers,
      name: 'Customers',
      fields: [
        { id: fields.name, name: 'Name', type: 'singleLineText', isPrimary: true },
        {
          id: fields.tier,
          name: 'Tier',
          type: 'singleSelect',
          options: {
            choices: [
              { id: 'choTierA', name: 'A' },
              { id: 'choTierB', name: 'B' },
            ],
          },
        },
      ],
    },
  ],
};

function template(input: {
  id: string;
  customers: { tables: ReadonlyArray<unknown> };
  ordersFields: ReadonlyArray<unknown>;
}): GeneratorTemplate {
  return {
    id: input.id,
    rootTable: 'Orders',
    structure: {
      tables: [
        ...input.customers.tables,
        {
          id: tables.orders,
          name: 'Orders',
          fields: [
            { id: fields.title, name: 'Title', type: 'singleLineText', isPrimary: true },
            { id: fields.amount, name: 'Amount', type: 'number' },
            ...input.ordersFields,
            {
              id: fields.tax,
              name: 'Tax',
              type: 'formula',
              options: { expression: `{${fields.amount}}*0.1` },
            },
            {
              id: fields.taxLabel,
              name: 'TaxLabel',
              type: 'formula',
              options: { expression: `{${fields.tax}}*2` },
            },
          ],
        },
      ],
    },
    dataset: {
      tables: {
        Orders: { fields: { Amount: { distribution: 'uniform', min: 1, max: 100 } } },
      },
    },
    workload: [
      {
        key: 'orders-page',
        kind: 'query-core',
        table: 'Orders',
        query: { limit: 50 },
      },
      {
        key: 'amount-update',
        kind: 'write-update',
        table: 'Orders',
        field: 'Amount',
        rows: 5,
        batchSize: 5,
        typecast: false,
        value: { kind: 'number-increment', start: 1, step: 1 },
      },
      { key: 'drain', kind: 'flush-computed' },
    ],
    oracle: [
      {
        key: 'invariants',
        kind: 'invariant',
        checks: [
          { type: 'row-count', table: 'Customers', expected: 1 },
          { type: 'row-count', table: 'Orders', expected: 1 },
          { type: 'computed-not-null', table: 'Orders', fields: ['Tax', 'TaxLabel'] },
        ],
      },
    ],
  };
}

const formulaLookupTemplate = template({
  id: 'formula-lookup-formula',
  customers: customersStructure,
  ordersFields: [
    {
      id: fields.customer,
      name: 'Customer',
      type: 'link',
      options: {
        relationship: 'manyOne',
        foreignTableId: tables.customers,
        lookupFieldId: fields.name,
      },
    },
    {
      id: fields.customerName,
      name: 'CustomerName',
      type: 'lookup',
      lookupOptions: {
        foreignTableId: tables.customers,
        linkFieldId: fields.customer,
        lookupFieldId: fields.name,
      },
    },
  ],
});

const selectLookupTemplate = template({
  id: 'select-lookup-formula',
  customers: customersStructure,
  ordersFields: [
    {
      id: fields.customer,
      name: 'Customer',
      type: 'link',
      options: {
        relationship: 'manyOne',
        foreignTableId: tables.customers,
        lookupFieldId: fields.name,
      },
    },
    {
      id: fields.tierLookup,
      name: 'CustomerTier',
      type: 'lookup',
      lookupOptions: {
        foreignTableId: tables.customers,
        linkFieldId: fields.customer,
        lookupFieldId: fields.tier,
      },
    },
  ],
});

function spec(outDir: string): GeneratorSpec {
  return {
    generatorVersion: 'tea-bench/1',
    seed: 11,
    outDir,
    strength: 2,
    templates: [formulaLookupTemplate, selectLookupTemplate],
    dimensions: {
      motif: ['formula-lookup-formula', 'select-lookup-formula'],
      rows: [10, 100],
      typecast: [false, true],
    },
  };
}

const createdDirs: string[] = [];

afterEach(async () => {
  const dirs = createdDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('generateCases', () => {
  it('covers every declared catalog pair with valid case identities and propagation workloads', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'bench-catalog-'));
    createdDirs.push(outDir);
    const catalog = JSON.parse(
      await readFile(new URL('../../fixtures/catalog.generator.json', import.meta.url), 'utf8')
    ) as GeneratorSpec;
    const result = await generateCases({ ...catalog, outDir });

    expect(result.cases).toHaveLength(17);
    expect(result.coverage).toMatchObject({
      totalPairs: 53,
      coveredPairs: 53,
      uncoveredPairs: [],
      receipt: {
        rawPairCount: 53,
        completable: 53,
        nonCompletable: 0,
        unknown: 0,
        covered: 53,
        truncated: false,
      },
    });
    const dimensions = Object.entries(catalog.dimensions);
    const coveredPairs = new Set<string>();
    for (const generated of result.cases) {
      const manifest = parseBenchCaseManifest(
        JSON.parse(await readFile(generated.manifestPath, 'utf8'))
      );
      const archive = readTeaArchive(await readFile(generated.teaPath));
      verifyCaseId(manifest, sha256Hex(canonicalJson(archive.structure)));
      expect(manifest.caseId).toBe(generated.caseId);
      expect(manifest.run.samples).toBe(5);
      expect(manifest.workload.some((step) => step.kind === 'flush-computed')).toBe(true);
      expect(manifest.oracle.some((entry) => entry.kind === 'full-recompute')).toBe(true);
      for (const step of manifest.workload) {
        if (step.kind !== 'write-update') continue;
        expect(step.typecast).toBe(manifest.dimensions?.typecast);
        expect(step.batchSize).toBe(manifest.dimensions?.batchSize);
        expect(step.rows).toBeLessThanOrEqual(manifest.dataset.rows[step.table]!);
      }
      for (const oracle of manifest.oracle) {
        if (oracle.kind !== 'invariant') continue;
        for (const check of oracle.checks) {
          if (check.type === 'row-count') {
            expect(check.expected).toBe(manifest.dataset.rows[check.table]);
          }
        }
      }
      const motif = manifest.dimensions?.motif;
      if (
        motif === 'lookup-of-formula' ||
        motif === 'lookup-of-select' ||
        motif === 'conditional-lookup'
      ) {
        expect(manifest.workload).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'write-update', table: 'Customers' }),
            expect.objectContaining({ kind: 'query-core', table: 'Orders' }),
          ])
        );
      }
      if (motif === 'rollup-manyone') {
        expect(manifest.workload).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'write-update', table: 'Orders' }),
            expect.objectContaining({ kind: 'query-core', table: 'Customers' }),
          ])
        );
      }
      for (let left = 0; left < dimensions.length; left += 1) {
        for (let right = left + 1; right < dimensions.length; right += 1) {
          const leftName = dimensions[left]![0];
          const rightName = dimensions[right]![0];
          coveredPairs.add(
            pairLabel(
              leftName,
              manifest.dimensions?.[leftName],
              rightName,
              manifest.dimensions?.[rightName]
            )
          );
        }
      }
    }
    for (let left = 0; left < dimensions.length; left += 1) {
      for (let right = left + 1; right < dimensions.length; right += 1) {
        const [leftName, leftValues] = dimensions[left]!;
        const [rightName, rightValues] = dimensions[right]!;
        for (const leftValue of leftValues) {
          for (const rightValue of rightValues) {
            expect(coveredPairs.has(pairLabel(leftName, leftValue, rightName, rightValue))).toBe(
              true
            );
          }
        }
      }
    }
  });
  it('uses complete explicit table row counts for a bounded business fixture', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'bench-explicit-rows-'));
    createdDirs.push(outDir);
    const reference = JSON.parse(
      await readFile(
        new URL('../../fixtures/reference-business-operations.generator.json', import.meta.url),
        'utf8'
      )
    ) as GeneratorSpec;
    const result = await generateCases({ ...reference, outDir });
    expect(result.cases).toHaveLength(1);
    const manifest = parseBenchCaseManifest(
      JSON.parse(await readFile(result.cases[0]!.manifestPath, 'utf8'))
    );
    expect(manifest.dataset.rows).toEqual({
      Accounts: 20,
      Projects: 80,
      ['Work Items']: 400,
      ['Time Entries']: 1200,
    });
    expect(manifest.workload.findLast((step) => step.kind.startsWith('write-'))?.kind).toBe(
      'write-delete'
    );
  });

  it('generates deterministic pairwise cases with readable fixtures and verifiable identities', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'bench-generator-'));
    createdDirs.push(outDir);
    const first = await generateCases(spec(outDir));

    expect(first.cases).toHaveLength(4);
    expect(first.coverage.uncoveredPairs).toEqual([]);
    expect(first.coverage.coveredPairs).toBe(first.coverage.totalPairs);
    expect(first.coverage.totalPairs).toBeGreaterThan(0);

    for (const generated of first.cases) {
      const archive = readTeaArchive(await readFile(generated.teaPath));
      const structure = archive.structure;
      if (
        typeof structure !== 'object' ||
        structure === null ||
        !('tables' in structure) ||
        !Array.isArray(structure.tables)
      ) {
        throw new Error('generated tea structure is invalid');
      }
      expect(structure.tables).toHaveLength(2);

      const manifest = parseBenchCaseManifest(
        JSON.parse(await readFile(generated.manifestPath, 'utf8'))
      );
      verifyCaseId(manifest, sha256Hex(canonicalJson(structure)));
      const rowsValue = manifest.dimensions?.rows;
      if (typeof rowsValue !== 'number') throw new Error('generated rows dimension is invalid');
      expect(manifest.dataset.rows.Orders).toBe(rowsValue);
      expect(manifest.dataset.rows.Customers).toBe(Math.max(1, Math.round(rowsValue / 10)));
      expect(manifest.dataset.dataHash).toBeTruthy();

      const update = manifest.workload.find((step) => step.kind === 'write-update');
      expect(update).toBeDefined();
      if (update?.kind === 'write-update') {
        expect(update.typecast).toBe(manifest.dimensions?.typecast);
        expect(update.rows).toBe(5);
      }
      const rowCount = manifest.oracle.find((entry) => entry.kind === 'invariant');
      expect(rowCount).toBeDefined();
      if (rowCount?.kind === 'invariant') {
        for (const check of rowCount.checks) {
          if (check.type === 'row-count') {
            expect(check.expected).toBe(manifest.dataset.rows[check.table]);
          }
        }
      }
    }

    const secondDir = await mkdtemp(join(tmpdir(), 'bench-generator-'));
    createdDirs.push(secondDir);
    const second = await generateCases(spec(secondDir));
    expect(second.cases.map((entry) => entry.caseId)).toEqual(
      first.cases.map((entry) => entry.caseId)
    );
  });

  it('keeps backend variants in distinct directories without changing case identity', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'bench-generator-'));
    createdDirs.push(outDir);
    const result = await generateCases({
      ...spec(outDir),
      dimensions: {
        motif: ['formula-lookup-formula'],
        rows: [10],
        typecast: [false],
        backend: ['pglite', 'postgres'],
      },
    });

    expect(result.cases).toHaveLength(2);
    expect(new Set(result.cases.map((entry) => entry.caseId)).size).toBe(1);
    expect(new Set(result.cases.map((entry) => entry.dir)).size).toBe(2);
    const caseId = result.cases[0]!.caseId;
    expect(result.cases.map((entry) => entry.dir).sort()).toEqual(
      [join(outDir, caseId, 'pglite'), join(outDir, caseId, 'postgres')].sort()
    );
    const manifests = await Promise.all(
      result.cases.map(async (entry) =>
        parseBenchCaseManifest(JSON.parse(await readFile(entry.manifestPath, 'utf8')))
      )
    );
    expect(manifests.map((manifest) => manifest.run.backend).sort()).toEqual([
      'pglite',
      'postgres',
    ]);
  });

  it('rewrites row-count invariants for one complete fresh-sample workload', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'bench-generator-'));
    createdDirs.push(outDir);
    const writeTemplate: GeneratorTemplate = {
      ...formulaLookupTemplate,
      workload: [
        {
          key: 'create-orders',
          kind: 'write-create',
          table: 'Orders',
          rows: 2,
          batchSize: 2,
          typecast: false,
        },
        {
          key: 'delete-orders',
          kind: 'write-delete',
          table: 'Orders',
          rows: 1,
          batchSize: 1,
        },
      ],
    };
    const result = await generateCases({
      ...spec(outDir),
      templates: [writeTemplate],
      dimensions: { motif: [writeTemplate.id], rows: [10], typecast: [false] },
    });
    const manifest = parseBenchCaseManifest(
      JSON.parse(await readFile(result.cases[0]!.manifestPath, 'utf8'))
    );
    const invariant = manifest.oracle.find((entry) => entry.kind === 'invariant');
    const ordersCount =
      invariant?.kind === 'invariant'
        ? invariant.checks.find((check) => check.type === 'row-count' && check.table === 'Orders')
        : undefined;
    expect(ordersCount).toEqual({ type: 'row-count', table: 'Orders', expected: 11 });
  });

  it('accepts deletes that fit one fresh sample even when all samples cumulatively would not', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'bench-generator-'));
    createdDirs.push(outDir);
    const destructiveTemplate: GeneratorTemplate = {
      ...formulaLookupTemplate,
      workload: [
        { key: 'delete-orders', kind: 'write-delete', table: 'Orders', rows: 3, batchSize: 3 },
      ],
    };
    const result = await generateCases({
      ...spec(outDir),
      templates: [destructiveTemplate],
      dimensions: { motif: [destructiveTemplate.id], rows: [10], typecast: [false] },
    });
    const manifest = parseBenchCaseManifest(
      JSON.parse(await readFile(result.cases[0]!.manifestPath, 'utf8'))
    );
    const invariant = manifest.oracle.find((entry) => entry.kind === 'invariant');
    const ordersCount =
      invariant?.kind === 'invariant'
        ? invariant.checks.find((check) => check.type === 'row-count' && check.table === 'Orders')
        : undefined;
    expect(ordersCount).toEqual({ type: 'row-count', table: 'Orders', expected: 7 });
  });

  it('requires a motif dimension', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'bench-generator-'));
    createdDirs.push(outDir);
    await expect(
      generateCases({
        ...spec(outDir),
        dimensions: { rows: [10] },
      })
    ).rejects.toThrowError(/bench\.generator\.motif_missing/);
  });
});
