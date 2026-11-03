import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ActorId,
  ListTableRecordsQuery,
  type ListTableRecordsResult,
  UpdateRecordCommand,
} from '@teable/v2-core';
import type { Result } from 'neverthrow';

import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import {
  computeCaseId,
  computeDatasetHash,
  type BenchCaseManifest,
  type BenchDatasetRecipe,
  type BenchOracle,
} from '../case/manifest';
import { loadCase } from '../case/TeaCaseLoader';
import type { LoadedCase } from '../case/types';
import { writeTeaArchive } from '../tea/teaZip';

import type { FullRecomputeReferenceStore } from './fullRecompute';
import { runOracles } from './types';

const unwrap = <T>(result: Result<T, unknown>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

const ids = {
  customers: `tbl${'c'.repeat(16)}`,
  customerName: `fld${'n'.repeat(16)}`,
  customerTier: `fld${'s'.repeat(16)}`,
  orders: `tbl${'o'.repeat(16)}`,
  orderTitle: `fld${'t'.repeat(16)}`,
  amount: `fld${'a'.repeat(16)}`,
  customer: `fld${'l'.repeat(16)}`,
  tierLookup: `fld${'u'.repeat(16)}`,
  tax: `fld${'x'.repeat(16)}`,
};

const structure = {
  tables: [
    {
      id: ids.customers,
      name: 'Customers',
      fields: [
        { id: ids.customerName, name: 'Name', type: 'singleLineText', isPrimary: true },
        {
          id: ids.customerTier,
          name: 'Tier',
          type: 'singleSelect',
          options: {
            choices: [
              { name: 'A', color: 'blueLight1' },
              { name: 'B', color: 'grayLight1' },
            ],
          },
        },
      ],
      views: [{ type: 'grid', name: 'Grid' }],
    },
    {
      id: ids.orders,
      name: 'Orders',
      fields: [
        { id: ids.orderTitle, name: 'Title', type: 'singleLineText', isPrimary: true },
        { id: ids.amount, name: 'Amount', type: 'number' },
        {
          id: ids.customer,
          name: 'Customer',
          type: 'link',
          options: {
            relationship: 'manyOne',
            foreignTableId: ids.customers,
            lookupFieldId: ids.customerName,
            isOneWay: true,
          },
        },
        {
          id: ids.tierLookup,
          name: 'TierLookup',
          type: 'lookup',
          lookupOptions: {
            linkFieldId: ids.customer,
            foreignTableId: ids.customers,
            lookupFieldId: ids.customerTier,
          },
        },
        {
          id: ids.tax,
          name: 'Tax',
          type: 'formula',
          cellValueType: 'number',
          options: { expression: `{${ids.amount}}*0.1` },
        },
      ],
      views: [{ type: 'grid', name: 'Grid' }],
    },
  ],
};

const numericPrimaryStructure = {
  ...structure,
  tables: structure.tables.map((table) =>
    table.name === 'Customers'
      ? {
          ...table,
          fields: table.fields.map((field) =>
            field.id === ids.customerName ? { ...field, type: 'number' } : field
          ),
        }
      : table
  ),
};

const nullablePrimaryIds = {
  table: `tbl${'p'.repeat(16)}`,
  primary: `fld${'p'.repeat(16)}`,
  amount: `fld${'a'.repeat(16)}`,
  doubled: `fld${'d'.repeat(16)}`,
};

const nullablePrimaryStructure = {
  tables: [
    {
      id: nullablePrimaryIds.table,
      name: 'Items',
      fields: [
        {
          id: nullablePrimaryIds.primary,
          name: 'Category',
          type: 'singleSelect',
          isPrimary: true,
          options: { choices: [] },
        },
        { id: nullablePrimaryIds.amount, name: 'Amount', type: 'number' },
        {
          id: nullablePrimaryIds.doubled,
          name: 'Doubled',
          type: 'formula',
          cellValueType: 'number',
          options: { expression: `{${nullablePrimaryIds.amount}}*2` },
        },
      ],
      views: [{ type: 'grid', name: 'Grid' }],
    },
  ],
};

const nullablePrimaryRecipe: BenchDatasetRecipe = {
  tables: { Items: { fields: { Category: {}, Amount: { min: 1, max: 10 } } } },
};

const defaultRecipe: BenchDatasetRecipe = {
  tables: {
    Customers: { fields: { Tier: { choices: ['A', 'B'] } } },
    Orders: {
      fields: {
        Amount: { distribution: 'constant', min: 10 },
        Customer: { link: { table: 'Customers', relationship: 'manyOne' } },
      },
    },
  },
};

const buildManifest = (
  oracle: ReadonlyArray<BenchOracle>,
  fixtureStructure: unknown = structure,
  recipe: BenchDatasetRecipe = defaultRecipe,
  rows: Readonly<Record<string, number>> = { Customers: 2, Orders: 2 }
): BenchCaseManifest => {
  const workload = [{ key: 'flush', kind: 'flush-computed' as const }];
  const seed = { schema: 1, data: 2, query: 3, schedule: 4 };
  const schemaHash = sha256Hex(canonicalJson(fixtureStructure));
  const datasetHash = computeDatasetHash({ dataMode: 'recipe', rows, seed, recipe });
  return {
    caseId: computeCaseId({
      specVersion: 1,
      generatorVersion: 'oracle-test/1',
      schemaHash,
      datasetHash,
      workload,
      oracle,
    }),
    specVersion: 1,
    generatorVersion: 'oracle-test/1',
    title: 'Oracle fixture',
    source: { tea: 'fixture.tea', dataMode: 'recipe' },
    dataset: { rows, seed, recipe },
    run: {
      backend: 'pglite',
      samples: 3,
      warmup: 0,
      repetitions: 1,
      seedBatchSize: 10,
      actorId: 'usr_oracle',
    },
    workload,
    oracle,
  };
};

const withLoadedCase = async (
  oracle: ReadonlyArray<BenchOracle>,
  body: (input: { loaded: LoadedCase; teaPath: string; dir: string }) => Promise<void>,
  options: {
    readonly structure?: unknown;
    readonly recipe?: BenchDatasetRecipe;
    readonly rows?: Readonly<Record<string, number>>;
  } = {}
): Promise<void> => {
  const fixtureStructure = options.structure ?? structure;
  const recipe = options.recipe ?? defaultRecipe;
  const rows = options.rows ?? { Customers: 2, Orders: 2 };
  const dir = await mkdtemp(join(tmpdir(), 'headless-bench-oracle-'));
  const teaPath = join(dir, 'fixture.tea');
  await writeFile(teaPath, writeTeaArchive(fixtureStructure));
  const loaded = await loadCase({
    teaPath,
    manifest: buildManifest(oracle, fixtureStructure, recipe, rows),
  });
  try {
    await body({ loaded, teaPath, dir });
  } finally {
    await loaded.close();
    await rm(dir, { recursive: true, force: true });
  }
};

const listRecords = async (
  loaded: LoadedCase,
  tableName: string
): Promise<ListTableRecordsResult> => {
  const table = loaded.tables.get(tableName)!;
  return unwrap(
    await loaded.runtime.queryBus.execute(
      { actorId: unwrap(ActorId.create(loaded.manifest.run.actorId)) },
      unwrap(ListTableRecordsQuery.create({ tableId: table.id, fieldKeyType: 'id', limit: 100 }))
    )
  );
};

const corruptFieldReads = (loaded: LoadedCase, fieldId: string, corrupted: unknown): void => {
  const queryBus = loaded.runtime.queryBus as unknown as {
    execute: (...args: unknown[]) => Promise<Result<unknown, unknown>>;
  };
  const execute = queryBus.execute.bind(queryBus);
  queryBus.execute = async (...args: unknown[]): Promise<Result<unknown, unknown>> => {
    const result = await execute(...args);
    return result.map((value) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('records' in value) ||
        !Array.isArray(value.records)
      ) {
        return value;
      }
      return {
        ...value,
        records: value.records.map((record) => {
          if (
            typeof record !== 'object' ||
            record === null ||
            !('fields' in record) ||
            typeof record.fields !== 'object' ||
            record.fields === null ||
            !Object.hasOwn(record.fields, fieldId)
          ) {
            return record;
          }
          return {
            ...record,
            fields: { ...record.fields, [fieldId]: corrupted },
          };
        }),
      };
    });
  };
};

describe('runOracles', () => {
  it('passes matching expected JSON and fails after a formula value changes', async () => {
    const oracle = [{ key: 'expected', kind: 'expected-json' as const, path: 'expected.json' }];
    await withLoadedCase(oracle, async ({ loaded, teaPath, dir }) => {
      const table = loaded.tables.get('Orders')!;
      const title = table.fields.get('Title')!;
      const tax = table.fields.get('Tax')!;
      const records = await listRecords(loaded, 'Orders');
      const expected = records.records.map((record) => ({
        Title: record.fields[title.id],
        Tax: record.fields[tax.id],
      }));
      await writeFile(
        join(dir, 'expected.json'),
        JSON.stringify({ tables: { Orders: { keys: ['Title'], rows: expected } } })
      );

      expect((await runOracles({ loaded, teaPath })).status).toBe('pass');
      const changed = JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8'));
      changed.tables.Orders.rows[0].Tax = 999;
      await writeFile(join(dir, 'expected.json'), JSON.stringify(changed));
      expect((await runOracles({ loaded, teaPath })).status).toBe('fail');
    });
  });

  it('reports row-count invariant success and failure', async () => {
    const oracle = [
      {
        key: 'invariants',
        kind: 'invariant' as const,
        checks: [
          { type: 'row-count' as const, table: 'Orders', expected: 2 },
          { type: 'row-count' as const, table: 'Customers', expected: 99 },
        ],
      },
    ];
    await withLoadedCase(oracle, async ({ loaded, teaPath }) => {
      const result = await runOracles({ loaded, teaPath });
      expect(result.status).toBe('fail');
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: 'pass', expected: 2, actual: 2 }),
          expect.objectContaining({ status: 'fail', expected: 99, actual: 2 }),
        ])
      );
    });
  });

  it('retains passing check evidence and rejects vacuous computed coverage', async () => {
    const oracle = [
      {
        key: 'details',
        kind: 'invariant' as const,
        checks: [
          {
            checkId: 'orders-tax-not-null',
            description: '订单税额有实际行且非空',
            obligationIds: ['obl-tax'],
            type: 'computed-not-null' as const,
            table: 'Orders',
            fields: ['Tax'],
          },
        ],
      },
    ];
    await withLoadedCase(
      oracle,
      async ({ loaded, teaPath }) => {
        const result = await runOracles({ loaded, teaPath });
        expect(result.checks[0]).toMatchObject({
          checkId: 'orders-tax-not-null',
          description: '订单税额有实际行且非空',
          obligationIds: ['obl-tax'],
          status: 'fail',
          rowsMatched: 0,
          method: 'computed-non-null-scan',
        });
      },
      { rows: { Customers: 0, Orders: 0 } }
    );
  });

  it('records bounded full-recompute counts without dumping customer values on success', async () => {
    const oracle = [
      {
        key: 'recompute-detail',
        checkId: 'recompute-orders',
        obligationIds: ['obl-recompute'],
        kind: 'full-recompute' as const,
        tables: ['Orders'],
      },
    ];
    await withLoadedCase(oracle, async ({ loaded, teaPath }) => {
      const result = await runOracles({ loaded, teaPath });
      expect(result.checks[0]).toMatchObject({
        checkId: 'recompute-orders',
        status: 'pass',
        obligationIds: ['obl-recompute'],
        method: 'fresh-runtime-full-recompute',
        details: { copiedRows: 4, comparedRows: 2, comparedFields: 2, copiedTables: 2 },
      });
      expect(result.checks[0]?.details).not.toHaveProperty('source');
      expect(result.checks[0]?.details).not.toHaveProperty('target');
    });
  });

  it('full-recomputes distinct rows whose nullable primary values are all null', async () => {
    const oracle = [{ key: 'recompute', kind: 'full-recompute' as const, tables: ['Items'] }];
    await withLoadedCase(
      oracle,
      async ({ loaded, teaPath }) => {
        const seeded = loaded.recordsByTable.get('Items')!;
        expect(seeded).toHaveLength(2);
        expect(seeded.every((record) => record.primary == null)).toBe(true);
        expect(new Set(seeded.map((record) => record.id)).size).toBe(2);
        const result = await runOracles({ loaded, teaPath });
        expect(result.checks[0]).toMatchObject({
          status: 'pass',
          method: 'fresh-runtime-full-recompute',
          rowsMatched: 2,
          details: { copiedRows: 2, comparedRows: 2, comparedFields: 1 },
        });
      },
      {
        structure: nullablePrimaryStructure,
        recipe: nullablePrimaryRecipe,
        rows: { Items: 2 },
      }
    );
  });

  it('normalizes fresh record identities and rejects corrupted computed values in a later sample', async () => {
    const oracle = [
      {
        key: 'recompute',
        checkId: 'recompute',
        kind: 'full-recompute' as const,
        tables: ['Orders'],
        reuse: 'identical-state' as const,
      },
    ];
    await withLoadedCase(oracle, async ({ loaded, teaPath }) => {
      const references: FullRecomputeReferenceStore = new Map();
      const proof = await runOracles({ loaded, teaPath, fullRecomputeReferences: references });
      expect(proof.checks[0]).toMatchObject({
        status: 'pass',
        method: 'fresh-runtime-full-recompute',
        details: { establishedReference: true },
      });

      const equivalent = await loadCase({ teaPath, manifest: loaded.manifest });
      try {
        const comparison = await runOracles({
          loaded: equivalent,
          teaPath,
          fullRecomputeReferences: references,
        });
        expect(comparison.checks[0]).toMatchObject({
          status: 'pass',
          method: 'verified-reference-state-comparison',
          details: { referenceCheckId: 'recompute' },
        });
        expect(comparison.checks[0]?.details).not.toHaveProperty('copiedRows');
      } finally {
        await equivalent.close();
      }

      const corrupted = await loadCase({ teaPath, manifest: loaded.manifest });
      try {
        const tax = corrupted.tables.get('Orders')!.fields.get('Tax')!;
        corruptFieldReads(corrupted, tax.id, 999);
        const comparison = await runOracles({
          loaded: corrupted,
          teaPath,
          fullRecomputeReferences: references,
        });
        expect(comparison.checks[0]).toMatchObject({
          status: 'fail',
          method: 'verified-reference-state-comparison',
          actual: { equal: false },
        });
      } finally {
        await corrupted.close();
      }
    });
  });

  it('rejects changed source inputs and relationships against the verified reference', async () => {
    const oracle = [
      {
        key: 'recompute',
        checkId: 'recompute',
        kind: 'full-recompute' as const,
        tables: ['Orders'],
        reuse: 'identical-state' as const,
      },
    ];
    await withLoadedCase(oracle, async ({ loaded, teaPath }) => {
      const references: FullRecomputeReferenceStore = new Map();
      expect(
        (await runOracles({ loaded, teaPath, fullRecomputeReferences: references })).status
      ).toBe('pass');

      const changedSource = await loadCase({ teaPath, manifest: loaded.manifest });
      try {
        const customers = changedSource.tables.get('Customers')!;
        const name = customers.fields.get('Name')!;
        const records = await listRecords(changedSource, 'Customers');
        unwrap(
          await changedSource.runtime.commandBus.execute(
            { actorId: unwrap(ActorId.create(changedSource.manifest.run.actorId)) },
            unwrap(
              UpdateRecordCommand.create({
                tableId: customers.id,
                recordId: records.records[0]!.id,
                fieldKeyType: 'id',
                fields: { [name.id]: 'changed-source' },
                typecast: false,
              })
            )
          )
        );
        await changedSource.runtime.flushComputed();
        const comparison = await runOracles({
          loaded: changedSource,
          teaPath,
          fullRecomputeReferences: references,
        });
        expect(comparison.checks[0]).toMatchObject({
          status: 'fail',
          method: 'verified-reference-state-comparison',
        });
      } finally {
        await changedSource.close();
      }

      const changedRelationship = await loadCase({ teaPath, manifest: loaded.manifest });
      try {
        const orders = changedRelationship.tables.get('Orders')!;
        const customer = orders.fields.get('Customer')!;
        const records = await listRecords(changedRelationship, 'Orders');
        unwrap(
          await changedRelationship.runtime.commandBus.execute(
            { actorId: unwrap(ActorId.create(changedRelationship.manifest.run.actorId)) },
            unwrap(
              UpdateRecordCommand.create({
                tableId: orders.id,
                recordId: records.records[0]!.id,
                fieldKeyType: 'id',
                fields: { [customer.id]: [] },
                typecast: false,
              })
            )
          )
        );
        await changedRelationship.runtime.flushComputed();
        const comparison = await runOracles({
          loaded: changedRelationship,
          teaPath,
          fullRecomputeReferences: references,
        });
        expect(comparison.checks[0]).toMatchObject({
          status: 'fail',
          method: 'verified-reference-state-comparison',
        });
      } finally {
        await changedRelationship.close();
      }
    });
  });

  it('rejects sub-tolerance source changes whose stale computed value hides amplification', async () => {
    const oracle = [
      {
        key: 'recompute',
        kind: 'full-recompute' as const,
        tables: ['Orders'],
        reuse: 'identical-state' as const,
      },
    ];
    const amplifiedStructure = {
      ...structure,
      tables: structure.tables.map((table) => ({
        ...table,
        fields: table.fields.map((field) =>
          field.id === ids.tax
            ? { ...field, options: { expression: `{${ids.amount}}*100000000` } }
            : field
        ),
      })),
    };
    await withLoadedCase(
      oracle,
      async ({ loaded, teaPath }) => {
        const references: FullRecomputeReferenceStore = new Map();
        expect(
          (await runOracles({ loaded, teaPath, fullRecomputeReferences: references })).status
        ).toBe('pass');
        const laterSample = await loadCase({ teaPath, manifest: loaded.manifest });
        try {
          const orders = laterSample.tables.get('Orders')!;
          const amount = orders.fields.get('Amount')!;
          const tax = orders.fields.get('Tax')!;
          const record = laterSample.recordsByTable.get('Orders')![0]!;
          unwrap(
            await laterSample.runtime.commandBus.execute(
              { actorId: unwrap(ActorId.create(laterSample.manifest.run.actorId)) },
              unwrap(
                UpdateRecordCommand.create({
                  tableId: orders.id,
                  recordId: record.id,
                  fieldKeyType: 'id',
                  fields: { [amount.id]: 1.0000001 },
                  typecast: false,
                })
              )
            )
          );
          corruptFieldReads(laterSample, tax.id, 100000000);
          const stale = await listRecords(laterSample, 'Orders');
          expect(stale.records.find((row) => row.id === record.id)?.fields[tax.id]).toBe(100000000);
          const comparison = await runOracles({
            loaded: laterSample,
            teaPath,
            fullRecomputeReferences: references,
          });
          expect(comparison.checks[0]).toMatchObject({
            status: 'fail',
            method: 'verified-reference-state-comparison',
          });
          expect((await runOracles({ loaded: laterSample, teaPath })).status).toBe('fail');
        } finally {
          await laterSample.close();
        }
      },
      {
        structure: amplifiedStructure,
        recipe: {
          ...defaultRecipe,
          tables: {
            ...defaultRecipe.tables,
            Orders: {
              fields: {
                ...defaultRecipe.tables.Orders!.fields,
                Amount: { distribution: 'constant', min: 1, max: 1 },
              },
            },
          },
        },
      }
    );
  });

  it('preserves source array ordering even when normalized computed arrays remain equal', async () => {
    const oracle = [
      {
        key: 'recompute',
        kind: 'full-recompute' as const,
        tables: ['Orders'],
        reuse: 'identical-state' as const,
      },
    ];
    const arrayStructure = {
      ...structure,
      tables: structure.tables.map((table) => ({
        ...table,
        fields: table.fields.map((field) =>
          field.id === ids.customerTier ? { ...field, type: 'multipleSelect' } : field
        ),
      })),
    };
    await withLoadedCase(
      oracle,
      async ({ loaded, teaPath }) => {
        const customers = loaded.tables.get('Customers')!;
        const tier = customers.fields.get('Tier')!;
        for (const record of loaded.recordsByTable.get('Customers')!) {
          unwrap(
            await loaded.runtime.commandBus.execute(
              { actorId: unwrap(ActorId.create(loaded.manifest.run.actorId)) },
              unwrap(
                UpdateRecordCommand.create({
                  tableId: customers.id,
                  recordId: record.id,
                  fieldKeyType: 'id',
                  fields: { [tier.id]: ['A', 'B'] },
                  typecast: false,
                })
              )
            )
          );
        }
        await loaded.runtime.flushComputed();
        const references: FullRecomputeReferenceStore = new Map();
        expect(
          (await runOracles({ loaded, teaPath, fullRecomputeReferences: references })).status
        ).toBe('pass');
        corruptFieldReads(loaded, tier.id, ['B', 'A']);
        const comparison = await runOracles({
          loaded,
          teaPath,
          fullRecomputeReferences: references,
        });
        expect(comparison.checks[0]).toMatchObject({
          status: 'fail',
          method: 'verified-reference-state-comparison',
        });
      },
      { structure: arrayStructure }
    );
  });

  it('preserves relationship target order in the reference equivalence proof', async () => {
    const oracle = [
      {
        key: 'recompute',
        kind: 'full-recompute' as const,
        tables: ['Orders'],
        reuse: 'identical-state' as const,
      },
    ];
    const orderedLinksStructure = {
      ...structure,
      tables: structure.tables.map((table) => ({
        ...table,
        fields: table.fields.map((field) =>
          field.id === ids.customer
            ? {
                ...field,
                options: {
                  relationship: 'manyMany',
                  foreignTableId: ids.customers,
                  lookupFieldId: ids.customerName,
                  isOneWay: true,
                },
              }
            : field
        ),
      })),
    };
    await withLoadedCase(
      oracle,
      async ({ loaded, teaPath }) => {
        const orders = loaded.tables.get('Orders')!;
        const customer = orders.fields.get('Customer')!;
        const targets = loaded.recordsByTable
          .get('Customers')!
          .map((record) => ({ id: record.id }));
        for (const record of loaded.recordsByTable.get('Orders')!) {
          unwrap(
            await loaded.runtime.commandBus.execute(
              { actorId: unwrap(ActorId.create(loaded.manifest.run.actorId)) },
              unwrap(
                UpdateRecordCommand.create({
                  tableId: orders.id,
                  recordId: record.id,
                  fieldKeyType: 'id',
                  fields: { [customer.id]: targets },
                  typecast: false,
                })
              )
            )
          );
        }
        await loaded.runtime.flushComputed();
        const stored = await listRecords(loaded, 'Orders');
        const storedLinks = stored.records[0]!.fields[customer.id];
        if (!Array.isArray(storedLinks)) throw new Error('Expected ordered relationship targets');
        const references: FullRecomputeReferenceStore = new Map();
        expect(
          (await runOracles({ loaded, teaPath, fullRecomputeReferences: references })).status
        ).toBe('pass');
        corruptFieldReads(loaded, customer.id, [...storedLinks].reverse());
        const comparison = await runOracles({
          loaded,
          teaPath,
          fullRecomputeReferences: references,
        });
        expect(comparison.checks[0]).toMatchObject({
          status: 'fail',
          method: 'verified-reference-state-comparison',
        });
      },
      {
        structure: orderedLinksStructure,
        recipe: {
          ...defaultRecipe,
          tables: {
            ...defaultRecipe.tables,
            Orders: {
              fields: {
                ...defaultRecipe.tables.Orders!.fields,
                Customer: { link: { table: 'Customers', relationship: 'manyMany' } },
              },
            },
          },
        },
      }
    );
  });

  it('does not establish a reference from zero-row obligation coverage', async () => {
    const oracle = [
      {
        key: 'recompute',
        kind: 'full-recompute' as const,
        tables: ['Orders'],
        obligationIds: ['orders-computed'],
        reuse: 'identical-state' as const,
      },
    ];
    await withLoadedCase(
      oracle,
      async ({ loaded, teaPath }) => {
        const references: FullRecomputeReferenceStore = new Map();
        const result = await runOracles({
          loaded,
          teaPath,
          fullRecomputeReferences: references,
        });
        expect(result.checks[0]).toMatchObject({
          status: 'fail',
          method: 'fresh-runtime-full-recompute',
          rowsMatched: 0,
        });
        expect(references.size).toBe(0);
      },
      { rows: { Customers: 0, Orders: 0 } }
    );
  });

  it('passes full recompute after an update and fails after a target update without drain', async () => {
    const oracle = [{ key: 'recompute', kind: 'full-recompute' as const, tables: ['Orders'] }];
    await withLoadedCase(oracle, async ({ loaded, teaPath }) => {
      const customers = loaded.tables.get('Customers')!;
      const tier = customers.fields.get('Tier')!;
      const records = await listRecords(loaded, 'Customers');
      unwrap(
        await loaded.runtime.commandBus.execute(
          { actorId: unwrap(ActorId.create(loaded.manifest.run.actorId)) },
          unwrap(
            UpdateRecordCommand.create({
              tableId: customers.id,
              recordId: records.records[0]!.id,
              fieldKeyType: 'id',
              fields: { [tier.id]: 'B' },
              typecast: true,
            })
          )
        )
      );
      await loaded.runtime.flushComputed();
      expect((await runOracles({ loaded, teaPath })).status).toBe('pass');

      unwrap(
        await loaded.runtime.commandBus.execute(
          { actorId: unwrap(ActorId.create(loaded.manifest.run.actorId)) },
          unwrap(
            UpdateRecordCommand.create({
              tableId: customers.id,
              recordId: records.records[0]!.id,
              fieldKeyType: 'id',
              fields: { [tier.id]: 'A' },
              typecast: true,
            })
          )
        )
      );
      expect((await runOracles({ loaded, teaPath })).status).toBe('fail');
    });
  });

  it('reports duplicate primary values through the explicit uniqueness invariant', async () => {
    const oracle = [
      {
        key: 'unique',
        kind: 'invariant' as const,
        checks: [{ type: 'unique-primary' as const, table: 'Customers' }],
      },
    ];
    await withLoadedCase(oracle, async ({ loaded, teaPath }) => {
      const customers = loaded.tables.get('Customers')!;
      const primary = customers.fields.get('Name')!;
      const records = await listRecords(loaded, 'Customers');
      for (const record of records.records) {
        unwrap(
          await loaded.runtime.commandBus.execute(
            { actorId: unwrap(ActorId.create(loaded.manifest.run.actorId)) },
            unwrap(
              UpdateRecordCommand.create({
                tableId: customers.id,
                recordId: record.id,
                fieldKeyType: 'id',
                fields: { [primary.id]: 'duplicate' },
                typecast: true,
              })
            )
          )
        );
      }
      expect((await runOracles({ loaded, teaPath })).status).toBe('fail');
    });
  });

  it('preserves duplicate-primary relationship identity across fresh samples', async () => {
    const oracle = [
      {
        key: 'recompute',
        kind: 'full-recompute' as const,
        tables: ['Orders'],
        reuse: 'identical-state' as const,
      },
    ];
    await withLoadedCase(
      oracle,
      async ({ loaded, teaPath }) => {
        const applyDuplicateState = async (target: LoadedCase): Promise<void> => {
          const customers = target.tables.get('Customers')!;
          const orders = target.tables.get('Orders')!;
          const customerName = customers.fields.get('Name')!;
          const tier = customers.fields.get('Tier')!;
          const customerLink = orders.fields.get('Customer')!;
          const customerRecords = target.recordsByTable.get('Customers')!;
          const orderRecords = target.recordsByTable.get('Orders')!;
          const actor = { actorId: unwrap(ActorId.create(target.manifest.run.actorId)) };

          for (const [index, record] of customerRecords.entries()) {
            unwrap(
              await target.runtime.commandBus.execute(
                actor,
                unwrap(
                  UpdateRecordCommand.create({
                    tableId: customers.id,
                    recordId: record.id,
                    fieldKeyType: 'id',
                    fields: { [customerName.id]: 7, [tier.id]: index === 0 ? 'A' : 'B' },
                    typecast: true,
                  })
                )
              )
            );
          }
          for (const [index, order] of orderRecords.entries()) {
            unwrap(
              await target.runtime.commandBus.execute(
                actor,
                unwrap(
                  UpdateRecordCommand.create({
                    tableId: orders.id,
                    recordId: order.id,
                    fieldKeyType: 'id',
                    fields: {
                      [customerLink.id]: [{ id: customerRecords[index % 2]!.id }],
                    },
                    typecast: true,
                  })
                )
              )
            );
          }
          await target.runtime.flushComputed();
        };

        const references: FullRecomputeReferenceStore = new Map();
        await applyDuplicateState(loaded);
        expect(
          (await runOracles({ loaded, teaPath, fullRecomputeReferences: references })).status
        ).toBe('pass');

        const equivalent = await loadCase({ teaPath, manifest: loaded.manifest });
        try {
          await applyDuplicateState(equivalent);
          const comparison = await runOracles({
            loaded: equivalent,
            teaPath,
            fullRecomputeReferences: references,
          });
          expect(comparison.checks[0]).toMatchObject({
            status: 'pass',
            method: 'verified-reference-state-comparison',
          });
        } finally {
          await equivalent.close();
        }
      },
      { structure: numericPrimaryStructure }
    );
  });

  it('applies maxRows to a large unselected table copied into the fresh runtime', async () => {
    const oracle = [
      { key: 'recompute', kind: 'full-recompute' as const, tables: ['Orders'], maxRows: 1 },
    ];
    await withLoadedCase(
      oracle,
      async ({ loaded, teaPath }) => {
        await expect(runOracles({ loaded, teaPath })).rejects.toThrow(
          'bench.oracle.full_recompute_too_large'
        );
      },
      { rows: { Customers: 100, Orders: 1 } }
    );
  });
});
