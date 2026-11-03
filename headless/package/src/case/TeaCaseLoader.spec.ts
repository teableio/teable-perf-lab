import { readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { DotTeaSchemaProfile } from '@teable/v2-complexity';
import { schemaFromDotTeaStructure } from '@teable/v2-complexity';
import { ActorId, ListTableRecordsQuery, type ListTableRecordsResult } from '@teable/v2-core';
import type { Result } from 'neverthrow';

import { writeTeaArchive } from '../tea/teaZip';
import { canonicalJson, sha256Hex } from './canonicalJson';
import {
  computeCaseId,
  computeDatasetHash,
  type BenchCaseManifest,
  type BenchWorkloadStep,
} from './manifest';
import { buildCaseComplexity, loadCase } from './TeaCaseLoader';

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

const manifestFor = (input: {
  structure: unknown;
  recipe?: NonNullable<BenchCaseManifest['dataset']['recipe']>;
  rows: Readonly<Record<string, number>>;
  dataMode?: BenchCaseManifest['source']['dataMode'];
  csvByEntry?: ReadonlyMap<string, string>;
}): BenchCaseManifest => {
  const workload: BenchCaseManifest['workload'] = [
    { key: 'list', kind: 'query-core', table: Object.keys(input.rows)[0]!, query: { limit: 1 } },
  ];
  const oracle: BenchCaseManifest['oracle'] = [{ key: 'rows', kind: 'invariant', checks: [] }];
  const seed = { schema: 1, data: 2, query: 3, schedule: 4 };
  const dataMode = input.dataMode ?? 'recipe';
  const datasetHash = computeDatasetHash({
    dataMode,
    rows: input.rows,
    seed,
    recipe: input.recipe,
    csvByEntry: input.csvByEntry,
  });
  return {
    caseId: computeCaseId({
      specVersion: 1,
      generatorVersion: 'test/1',
      schemaHash: sha256Hex(canonicalJson(input.structure)),
      datasetHash,
      workload,
      oracle,
    }),
    specVersion: 1,
    generatorVersion: 'test/1',
    title: 'Loader validation test',
    source: { tea: 'loader-validation.tea', dataMode },
    dataset: {
      rows: input.rows,
      seed,
      ...(input.recipe ? { recipe: input.recipe } : {}),
      dataHash: datasetHash,
    },
    run: {
      backend: 'pglite',
      samples: 3,
      warmup: 0,
      repetitions: 1,
      seedBatchSize: 25,
      actorId: 'usr_headless',
    },
    workload,
    oracle,
  };
};

const nullablePrimaryStructure = (notNull = false) => ({
  tables: [
    {
      id: 'tblnullableprimary1',
      name: 'Items',
      fields: [
        {
          id: 'fldnullableprimary1',
          name: 'Category',
          type: 'singleSelect',
          isPrimary: true,
          ...(notNull ? { notNull: true } : {}),
          options: { choices: [] },
        },
        {
          id: 'fldratingmaximumone',
          name: 'OneStar',
          type: 'rating',
          options: { max: 1, icon: 'star', color: 'yellowBright' },
        },
        {
          id: 'fldratingmaximumtri',
          name: 'ThreeStars',
          type: 'rating',
          options: { max: 3, icon: 'star', color: 'yellowBright' },
        },
      ],
      views: [{ id: 'viwnullableprimary1', type: 'grid', name: 'Grid' }],
    },
  ],
});

const nullablePrimaryRecipe: NonNullable<BenchCaseManifest['dataset']['recipe']> = {
  tables: { Items: { fields: { Category: {}, OneStar: {}, ThreeStars: {} } } },
};

describe('buildCaseComplexity', () => {
  it('keeps a missing change rate unknown and labels an explicit manifest assumption', () => {
    const generated = manifestFor({
      structure: { tables: [] },
      rows: { Customers: 5, Orders: 20 },
      recipe: {
        tables: {
          Customers: { fields: { Amount: { min: 0, max: 100 } } },
          Orders: {
            fields: {
              Customer: {
                link: { table: 'Customers', relationship: 'manyOne', fanout: 2 },
              },
            },
          },
        },
      },
    });
    const caseManifest: BenchCaseManifest = {
      ...generated,
      workload: [
        {
          key: 'update-customer-amount',
          kind: 'write-update',
          table: 'Customers',
          field: 'Amount',
          rows: 2,
          batchSize: 2,
          typecast: false,
          value: { kind: 'number-increment', start: 10, step: 1 },
        },
        { key: 'flush', kind: 'flush-computed' },
      ],
    };
    const profile: DotTeaSchemaProfile = {
      fields: [
        { id: 'fldCustomerAmount', tableId: 'tblCustomers', type: 'number', isComputed: false },
        { id: 'fldOrderCustomer', tableId: 'tblOrders', type: 'link', isComputed: false },
        { id: 'fldOrderAmount', tableId: 'tblOrders', type: 'lookup', isComputed: true },
      ],
      edges: [
        {
          fromFieldId: 'fldCustomerAmount',
          toFieldId: 'fldOrderAmount',
          fromTableId: 'tblCustomers',
          toTableId: 'tblOrders',
          kind: 'cross_record',
          linkFieldId: 'fldOrderCustomer',
        },
      ],
      warnings: [],
      completeness: 'complete',
      tableNames: new Map([
        ['tblCustomers', 'Customers'],
        ['tblOrders', 'Orders'],
      ]),
      fieldNames: new Map([
        ['fldCustomerAmount', 'Amount'],
        ['fldOrderCustomer', 'Customer'],
        ['fldOrderAmount', 'Amount lookup'],
      ]),
    };

    const first = buildCaseComplexity(caseManifest, profile);
    const second = buildCaseComplexity(caseManifest, profile);
    const actual = first.assessments['update-customer-amount']!;

    expect(first).toEqual(second);
    expect(actual.score).toBeNull();
    expect(actual.components.dataWork).toBeNull();
    expect(actual.scoreProvenance).toEqual({
      kind: 'incomplete-input',
      missingAssumption: 'changeRate',
    });
    expect(actual.simulation.kind).toBe('workload-operation');
    if (actual.simulation.kind !== 'workload-operation') throw new Error('unexpected schema-only');
    expect(actual.simulation.operation).toEqual({
      kind: 'update',
      tableId: 'tblCustomers',
      changedFieldIds: ['fldCustomerAmount'],
    });
    expect(actual.simulation.assumptions).toEqual({
      rowCounts: { tblCustomers: 5, tblOrders: 20 },
      seedRecordCount: 2,
      linkFanout: {
        fldOrderCustomer: { mean: 2, p50: 2, p95: 2, max: 2 },
      },
    });
    expect(Object.hasOwn(actual.simulation.assumptions, 'changeRate')).toBe(false);
    expect(actual.simulation.provenance).toEqual({
      rowCounts: {
        source: 'manifest.dataset.rows',
        tableNamesById: { tblCustomers: 'Customers', tblOrders: 'Orders' },
      },
      seedRecordCount: {
        source: 'manifest.workload.rows',
        operationKey: 'update-customer-amount',
      },
      linkFanout: {
        fldOrderCustomer: {
          source: 'manifest.dataset.recipe.link.fanout',
          value: 2,
        },
      },
      changeRate: {
        source: 'unavailable',
        value: null,
        reason: 'no-explicit-manifest-assumption-or-deterministic-proof',
      },
    });

    const assumed = buildCaseComplexity(
      {
        ...caseManifest,
        dimensions: {
          complexityAssumptions: {
            changeRateByOperation: {
              ['update-customer-amount']: {
                value: 1,
                source: 'calibration-plan-conservative-upper-bound',
                evidence: 'Declared bound: score calibration assumes every dirty output changes.',
              },
            },
          },
        },
      },
      profile
    ).assessments['update-customer-amount']!;
    expect(assumed.score).not.toBeNull();
    expect(assumed.scoreProvenance).toEqual({
      kind: 'assumption-backed',
      assumption: 'changeRate',
      source: 'manifest.dimensions.complexityAssumptions.changeRateByOperation',
      declaredSource: 'calibration-plan-conservative-upper-bound',
      evidence: 'Declared bound: score calibration assumes every dirty output changes.',
    });
    expect(assumed.simulation.kind).toBe('workload-operation');
    if (assumed.simulation.kind !== 'workload-operation') throw new Error('unexpected schema-only');
    expect(assumed.simulation.assumptions.changeRate).toBe(1);
    expect(assumed.simulation.provenance.changeRate).toEqual({
      source: 'manifest.dimensions.complexityAssumptions.changeRateByOperation',
      value: 1,
      declaredSource: 'calibration-plan-conservative-upper-bound',
      evidence: 'Declared bound: score calibration assumes every dirty output changes.',
    });
  });

  it('rejects a malformed manifest change-rate assumption instead of defaulting it', () => {
    const generated = manifestFor({
      structure: { tables: [] },
      rows: { Records: 1 },
      recipe: { tables: { Records: { fields: { Amount: { min: 0, max: 1 } } } } },
    });
    const caseManifest: BenchCaseManifest = {
      ...generated,
      dimensions: {
        complexityAssumptions: {
          changeRateByOperation: {
            update: { value: 2, source: 'invalid-test', evidence: 'Outside the unit interval.' },
          },
        },
      },
      workload: [
        {
          key: 'update',
          kind: 'write-update',
          table: 'Records',
          field: 'Amount',
          rows: 1,
          batchSize: 1,
          typecast: false,
          value: { kind: 'literal', value: 1 },
        },
      ],
    };
    const profile: DotTeaSchemaProfile = {
      fields: [{ id: 'fldAmount', tableId: 'tblRecords', type: 'number', isComputed: false }],
      edges: [],
      warnings: [],
      completeness: 'complete',
      tableNames: new Map([['tblRecords', 'Records']]),
      fieldNames: new Map([['fldAmount', 'Amount']]),
    };

    expect(() => buildCaseComplexity(caseManifest, profile)).toThrow(
      'Invalid change-rate assumption for update'
    );
  });

  it('derives inbound degree from preceding one-way manyOne writes, not outbound cardinality', () => {
    const structure = {
      tables: [
        {
          id: 'tblSource',
          name: 'Sources',
          fields: [
            { id: 'fldTitle', name: 'Title', type: 'singleLineText', isPrimary: true },
            { id: 'fldAmount', name: 'Amount', type: 'number' },
          ],
        },
        {
          id: 'tblTargets',
          name: 'Targets',
          fields: [
            {
              id: 'fldParent',
              name: 'Parent',
              type: 'link',
              options: {
                relationship: 'manyOne',
                foreignTableId: 'tblSource',
                lookupFieldId: 'fldTitle',
                isOneWay: true,
              },
            },
            {
              id: 'fldLookup',
              name: 'Amount lookup',
              type: 'lookup',
              lookupOptions: {
                foreignTableId: 'tblSource',
                lookupFieldId: 'fldAmount',
                linkFieldId: 'fldParent',
              },
            },
          ],
        },
      ],
    };
    const profile = schemaFromDotTeaStructure(structure);
    const crossRecordEdges = profile.edges.filter((edge) => edge.kind === 'cross_record');
    expect(profile.completeness).toBe('complete');
    expect(crossRecordEdges).toHaveLength(2);
    expect([...new Set(crossRecordEdges.map((edge) => edge.linkFieldId))]).toEqual(['fldParent']);
    const generated = manifestFor({
      structure,
      rows: { Sources: 2, Targets: 100 },
      recipe: { tables: { Sources: { fields: {} }, Targets: { fields: {} } } },
    });
    const sourceUpdate: Extract<BenchWorkloadStep, { kind: 'write-update' }> = {
      key: 'update-source',
      kind: 'write-update',
      table: 'Sources',
      field: 'Amount',
      rows: 1,
      batchSize: 1,
      typecast: false,
      value: { kind: 'literal', value: 11 },
    };
    const setup: Extract<BenchWorkloadStep, { kind: 'write-update' }> = {
      key: 'setup-links',
      kind: 'write-update',
      table: 'Targets',
      field: 'Parent',
      rows: 80,
      batchSize: 80,
      typecast: false,
      value: { kind: 'link-targets', table: 'Sources', indices: [0] },
    };
    const caseManifest: BenchCaseManifest = {
      ...generated,
      dimensions: {
        complexityAssumptions: {
          changeRateByOperation: {
            [sourceUpdate.key]: {
              value: 1,
              source: 'test-declared-upper-bound',
              evidence: 'Assume each dirty computed value changes; not an observation.',
            },
          },
        },
      },
      workload: [setup, { key: 'drain-setup', kind: 'flush-computed' }, sourceUpdate],
    };
    const high = buildCaseComplexity(caseManifest, profile, structure).assessments[
      sourceUpdate.key
    ]!;
    const low = buildCaseComplexity(
      { ...caseManifest, workload: [{ ...setup, rows: 1 }, sourceUpdate] },
      profile,
      structure
    ).assessments[sourceUpdate.key]!;

    expect(high.score).not.toBeNull();
    expect(high.score).toBeGreaterThan(low.score!);
    expect(high.simulation).toMatchObject({
      assumptions: { linkFanout: { fldParent: { mean: 80, p50: 80, p95: 80, max: 80 } } },
      provenance: {
        linkFanout: {
          fldParent: {
            source: 'deterministic-workload-link-state',
            value: 80,
            direction: 'inbound-to-selected-source',
            initialState: 'recipe-without-link-config-is-empty',
            sourceTableId: 'tblSource',
            targetTableId: 'tblTargets',
            sourceIndices: [0],
            setupOperationKeys: ['setup-links'],
          },
        },
      },
    });

    for (const unsupportedSetup of [
      { ...setup, selection: 'random' as const },
      { ...setup, value: { kind: 'link-targets' as const, table: 'Sources', indices: [1] } },
    ]) {
      const result = buildCaseComplexity(
        { ...caseManifest, workload: [unsupportedSetup, sourceUpdate] },
        profile,
        structure
      ).assessments[sourceUpdate.key]!;
      if (unsupportedSetup.selection === 'random') {
        expect(result.score).toBeNull();
        expect(result.simulation).toMatchObject({ assumptions: { linkFanout: {} } });
      } else {
        expect(result.simulation).toMatchObject({
          assumptions: { linkFanout: { fldParent: { mean: 0 } } },
        });
      }
    }
    expect(
      buildCaseComplexity(caseManifest, profile).assessments[sourceUpdate.key]!.score
    ).toBeNull();
    const manyMany = {
      tables: [
        structure.tables[0],
        {
          ...structure.tables[1],
          fields: [
            {
              ...structure.tables[1]!.fields[0],
              options: {
                relationship: 'manyMany',
                foreignTableId: 'tblSource',
                isOneWay: true,
              },
            },
            structure.tables[1]!.fields[1],
          ],
        },
      ],
    };
    expect(
      buildCaseComplexity(caseManifest, profile, manyMany).assessments[sourceUpdate.key]!.score
    ).toBeNull();
    expect(
      buildCaseComplexity(
        caseManifest,
        { ...profile, edges: [...profile.edges, ...profile.edges] },
        structure
      ).assessments[sourceUpdate.key]!.score
    ).toBeNull();
    const afterClear = buildCaseComplexity(
      {
        ...caseManifest,
        workload: [
          setup,
          {
            ...setup,
            key: 'clear-first-thirty',
            rows: 30,
            value: { kind: 'link-targets', table: 'Sources', indices: [] },
          },
          sourceUpdate,
        ],
      },
      profile,
      structure
    ).assessments[sourceUpdate.key]!;
    expect(afterClear.simulation).toMatchObject({
      assumptions: { linkFanout: { fldParent: { mean: 50 } } },
      provenance: {
        linkFanout: {
          fldParent: { setupOperationKeys: ['setup-links', 'clear-first-thirty'] },
        },
      },
    });
  });
});

describe('loadCase', () => {
  it('imports, resolves regenerated ids, seeds links, and flushes formulas on PGlite', async () => {
    const fixture = JSON.parse(
      await readFile(resolve(process.cwd(), 'fixtures/smoke.generator.json'), 'utf8')
    ) as {
      templates: Array<{
        structure: unknown;
        dataset: NonNullable<BenchCaseManifest['dataset']['recipe']>;
      }>;
    };
    const structure = structuredClone(fixture.templates[0]!.structure) as {
      tables: Array<{
        id: string;
        name: string;
        fields: Array<{
          id: string;
          name: string;
          type: string;
          isPrimary?: boolean;
          options?: {
            relationship: 'manyOne' | 'manyMany';
            foreignTableId: string;
            lookupFieldId: string;
            isOneWay?: boolean;
          };
        }>;
        views: Array<{ id?: string; name: string; type: string }>;
      }>;
    };
    const customersStructure = structure.tables.find((table) => table.name === 'Customers')!;
    const ordersStructure = structure.tables.find((table) => table.name === 'Orders')!;
    customersStructure.views[0]!.id = 'viwcustformula00001';
    ordersStructure.views[0]!.id = 'viwordformula000001';
    ordersStructure.fields.push({
      id: 'fldordnameformula01',
      name: 'Name',
      type: 'singleLineText',
    });
    ordersStructure.fields.push({
      id: 'fldordcustomersmany',
      name: 'RelatedCustomers',
      type: 'link',
      options: {
        relationship: 'manyMany',
        foreignTableId: customersStructure.id,
        lookupFieldId: 'fldcustnameformula1',
        isOneWay: true,
      },
    });
    const teaPath = resolve(process.cwd(), 'fixtures/loader-test.tea');
    await writeFile(teaPath, writeTeaArchive(structure));
    const workload: BenchCaseManifest['workload'] = [
      {
        key: 'update-amount',
        kind: 'write-update',
        table: 'Orders',
        field: 'Amount',
        rows: 10,
        batchSize: 10,
        typecast: false,
        value: { kind: 'number-increment', start: 1, step: 1 },
      },
      { key: 'flush', kind: 'flush-computed' },
    ];
    const oracle: BenchCaseManifest['oracle'] = [
      {
        key: 'invariants',
        kind: 'invariant',
        checks: [
          { type: 'row-count', table: 'Customers', expected: 10 },
          { type: 'row-count', table: 'Orders', expected: 100 },
          { type: 'computed-not-null', table: 'Orders', fields: ['Tax', 'TaxLabel'] },
        ],
      },
    ];
    const originalRecipe = fixture.templates[0]!.dataset;
    const recipe = {
      ...originalRecipe,
      tables: {
        ...originalRecipe.tables,
        Orders: {
          fields: {
            ...originalRecipe.tables.Orders!.fields,
            RelatedCustomers: {
              link: { table: 'Customers', relationship: 'manyMany' as const, fanout: 2 },
            },
          },
        },
      },
    };
    const datasetHash = computeDatasetHash({
      dataMode: 'recipe',
      rows: { Customers: 10, Orders: 100 },
      seed: { schema: 1, data: 2, query: 3, schedule: 4 },
      recipe,
    });
    const schemaHash = sha256Hex(canonicalJson(structure));
    const manifest: BenchCaseManifest = {
      caseId: computeCaseId({
        specVersion: 1,
        generatorVersion: 'test/1',
        schemaHash,
        datasetHash,
        workload,
        oracle,
      }),
      specVersion: 1,
      generatorVersion: 'test/1',
      title: 'Loader test',
      source: { tea: 'loader-test.tea', dataMode: 'recipe' },
      dataset: {
        rows: { Customers: 10, Orders: 100 },
        seed: { schema: 1, data: 2, query: 3, schedule: 4 },
        recipe,
        dataHash: datasetHash,
      },
      run: {
        backend: 'pglite',
        samples: 3,
        warmup: 0,
        repetitions: 1,
        seedBatchSize: 25,
        actorId: 'usr_headless',
      },
      workload,
      oracle,
    };
    try {
      const loaded = await loadCase({ teaPath, manifest });
      try {
        expect(loaded.recordsByTable.get('Customers')).toHaveLength(10);
        expect(loaded.recordsByTable.get('Orders')).toHaveLength(100);
        expect(loaded.setup.totalRows).toBe(110);
        const orders = loaded.tables.get('Orders')!;
        const customer = orders.fields.get('Customer')!;
        const tax = orders.fields.get('Tax')!;
        const taxLabel = orders.fields.get('TaxLabel')!;
        const relatedCustomers = orders.fields.get('RelatedCustomers')!;
        expect(customer.link).toEqual({ table: 'Customers', relationship: 'manyOne' });
        expect(relatedCustomers.link).toEqual({ table: 'Customers', relationship: 'manyMany' });
        expect(relatedCustomers.isMultiple).toBe(true);
        expect(loaded.tables.get('Customers')!.fields.get('Name')!.declaredId).toBe(
          'fldcustnameformula1'
        );
        expect(orders.fields.get('Name')!.declaredId).toBe('fldordnameformula01');
        expect(orders.views?.get('Grid')).toMatchObject({
          name: 'Grid',
          declaredId: 'viwordformula000001',
        });
        const actorId = unwrap(ActorId.create('usr_headless'));
        const result = unwrap<ListTableRecordsResult, unknown>(
          await loaded.runtime.queryBus.execute(
            { actorId },
            unwrap(
              ListTableRecordsQuery.create({
                tableId: orders.id,
                fieldKeyType: 'id',
                projection: [customer.id, relatedCustomers.id, tax.id, taxLabel.id],
                limit: 100,
              })
            )
          )
        );
        expect(result.records.every((record) => record.fields[customer.id] != null)).toBe(true);
        const customerIds = new Set(
          loaded.recordsByTable.get('Customers')!.map((record) => record.id)
        );
        for (const record of result.records) {
          const links: unknown = record.fields[relatedCustomers.id];
          expect(Array.isArray(links)).toBe(true);
          if (!Array.isArray(links)) throw new Error('Expected many-many link array');
          expect(links).toHaveLength(2);
          expect(
            links.every(
              (link: unknown) =>
                typeof link === 'object' &&
                link !== null &&
                'id' in link &&
                typeof link.id === 'string' &&
                customerIds.has(link.id)
            )
          ).toBe(true);
        }
        expect(result.records.every((record) => record.fields[tax.id] != null)).toBe(true);
        expect(result.records.every((record) => record.fields[taxLabel.id] != null)).toBe(true);
      } finally {
        await loaded.close();
      }
      const renamedWorkload: BenchCaseManifest['workload'] = [
        { ...workload[0]!, table: 'Missing' } as (typeof workload)[number],
        workload[1]!,
      ];
      const renamed: BenchCaseManifest = {
        ...manifest,
        workload: renamedWorkload,
        caseId: computeCaseId({
          specVersion: 1,
          generatorVersion: manifest.generatorVersion,
          schemaHash,
          datasetHash,
          workload: renamedWorkload,
          oracle: manifest.oracle,
        }),
      };
      await expect(loadCase({ teaPath, manifest: renamed })).rejects.toMatchObject({
        code: 'bench.table.unknown',
      });
    } finally {
      await unlink(teaPath).catch(() => undefined);
    }
  });

  it('rejects recipe fields that are absent from their imported table', async () => {
    const fixture = JSON.parse(
      await readFile(resolve(process.cwd(), 'fixtures/smoke.generator.json'), 'utf8')
    ) as {
      templates: Array<{
        structure: unknown;
        dataset: NonNullable<BenchCaseManifest['dataset']['recipe']>;
      }>;
    };
    const structure = fixture.templates[0]!.structure;
    const recipe = structuredClone(fixture.templates[0]!.dataset);
    (recipe.tables.Orders!.fields as Record<string, { min?: number; max?: number }>).Missing = {
      min: 1,
      max: 2,
    };
    const teaPath = resolve(process.cwd(), 'fixtures/loader-invalid-recipe.tea');
    await writeFile(teaPath, writeTeaArchive(structure));
    try {
      await expect(
        loadCase({
          teaPath,
          manifest: manifestFor({ structure, recipe, rows: { Customers: 1, Orders: 1 } }),
        })
      ).rejects.toMatchObject({ code: 'bench.field.unknown' });
    } finally {
      await unlink(teaPath).catch(() => undefined);
    }
  });

  it.each(['singleSelect', 'multipleSelect'] as const)(
    'generates %s values from imported field choices',
    async (selectType) => {
      const fixture = JSON.parse(
        await readFile(resolve(process.cwd(), 'fixtures/smoke.generator.json'), 'utf8')
      ) as {
        templates: Array<{
          structure: {
            tables: Array<{
              name: string;
              fields: Array<{
                name: string;
                type: string;
                options?: { choices?: Array<{ name: string; color?: string }> };
              }>;
            }>;
          };
          dataset: NonNullable<BenchCaseManifest['dataset']['recipe']>;
        }>;
      };
      const template = fixture.templates[1]!;
      const structure = structuredClone(template.structure);
      const tier = structure.tables
        .find((table) => table.name === 'Customers')!
        .fields.find((field) => field.name === 'Tier')!;
      tier.type = selectType;
      tier.options!.choices = [
        { name: 'Imported-A', color: 'blueLight1' },
        { name: 'Imported-B', color: 'greenLight1' },
      ];
      const recipe = structuredClone(template.dataset);
      (recipe.tables.Customers!.fields as Record<string, unknown>).Tier = {};
      const teaPath = resolve(process.cwd(), 'fixtures/loader-select-choices.tea');
      await writeFile(teaPath, writeTeaArchive(structure));
      const manifest = manifestFor({ structure, recipe, rows: { Customers: 32, Orders: 1 } });
      try {
        const loaded = await loadCase({ teaPath, manifest });
        try {
          const customers = loaded.tables.get('Customers')!;
          const tierField = customers.fields.get('Tier')!;
          expect(tierField.choices).toEqual(['Imported-A', 'Imported-B']);
          expect(tierField.type).toBe(selectType);
          expect(tierField.isMultiple).toBe(selectType === 'multipleSelect');
          expect(customers.fields.get('Name')!.choices).toBeUndefined();
          expect(loaded.tables.get('Orders')!.fields.get('TierLookup')!.choices).toBeUndefined();
          const result = unwrap<ListTableRecordsResult, unknown>(
            await loaded.runtime.queryBus.execute(
              { actorId: unwrap(ActorId.create(manifest.run.actorId)) },
              unwrap(
                ListTableRecordsQuery.create({
                  tableId: customers.id,
                  fieldKeyType: 'id',
                  projection: [tierField.id],
                  limit: 40,
                })
              )
            )
          );
          const tiers = result.records.map((record) => record.fields[tierField.id]);
          expect(tiers.length).toBeGreaterThan(0);
          const values = selectType === 'multipleSelect' ? tiers.flat() : tiers;
          expect(values.every((value) => value === 'Imported-A' || value === 'Imported-B')).toBe(
            true
          );
        } finally {
          await loaded.close();
        }
      } finally {
        await unlink(teaPath).catch(() => undefined);
      }
    }
  );

  it('seeds nullable select primaries and honors imported rating maxima', async () => {
    const structure = nullablePrimaryStructure();
    const teaPath = resolve(process.cwd(), 'fixtures/loader-nullable-primary.tea');
    await writeFile(teaPath, writeTeaArchive(structure));
    const manifest = manifestFor({
      structure,
      recipe: nullablePrimaryRecipe,
      rows: { Items: 64 },
    });
    try {
      const loaded = await loadCase({ teaPath, manifest });
      try {
        const table = loaded.tables.get('Items')!;
        const category = table.fields.get('Category')!;
        const oneStar = table.fields.get('OneStar')!;
        const threeStars = table.fields.get('ThreeStars')!;
        expect(oneStar.ratingMax).toBe(1);
        expect(threeStars.ratingMax).toBe(3);
        expect(loaded.recordsByTable.get('Items')!.every((record) => record.primary == null)).toBe(
          true
        );
        const result = unwrap<ListTableRecordsResult, unknown>(
          await loaded.runtime.queryBus.execute(
            { actorId: unwrap(ActorId.create(manifest.run.actorId)) },
            unwrap(
              ListTableRecordsQuery.create({
                tableId: table.id,
                fieldKeyType: 'id',
                projection: [category.id, oneStar.id, threeStars.id],
                limit: 100,
              })
            )
          )
        );
        expect(result.records.every((record) => record.fields[category.id] == null)).toBe(true);
        expect(result.records.every((record) => record.fields[oneStar.id] === 1)).toBe(true);
        expect(
          result.records.every((record) => {
            const value = record.fields[threeStars.id];
            return typeof value === 'number' && value >= 1 && value <= 3;
          })
        ).toBe(true);
      } finally {
        await loaded.close();
      }
    } finally {
      await unlink(teaPath).catch(() => undefined);
    }
  });

  it('preserves a materialized null primary and uses record ids as row identity', async () => {
    const structure = nullablePrimaryStructure();
    const table = structure.tables[0]!;
    const csvEntry = `tables/${table.id}.csv`;
    const csv = `${table.fields[0]!.id},${table.fields[1]!.id},${table.fields[2]!.id}\n,1,3\n,1,2\n`;
    const csvByEntry = new Map([[csvEntry, csv]]);
    const teaPath = resolve(process.cwd(), 'fixtures/loader-materialized-null-primary.tea');
    await writeFile(teaPath, writeTeaArchive(structure, Object.fromEntries(csvByEntry)));
    const manifest = manifestFor({
      structure,
      rows: { Items: 2 },
      dataMode: 'materialized',
      csvByEntry,
    });
    try {
      const loaded = await loadCase({ teaPath, manifest });
      try {
        const records = loaded.recordsByTable.get('Items')!;
        expect(records).toHaveLength(2);
        expect(records.every((record) => record.primary == null)).toBe(true);
        expect(new Set(records.map((record) => record.id)).size).toBe(2);
      } finally {
        await loaded.close();
      }
    } finally {
      await unlink(teaPath).catch(() => undefined);
    }
  });

  it('keeps explicit notNull enforcement in the core create path', async () => {
    const structure = nullablePrimaryStructure(true);
    const teaPath = resolve(process.cwd(), 'fixtures/loader-required-empty-select.tea');
    await writeFile(teaPath, writeTeaArchive(structure));
    try {
      await expect(
        loadCase({
          teaPath,
          manifest: manifestFor({
            structure,
            recipe: nullablePrimaryRecipe,
            rows: { Items: 1 },
          }),
        })
      ).rejects.toMatchObject({ code: 'bench.dataset.create_failed' });
    } finally {
      await unlink(teaPath).catch(() => undefined);
    }
  });

  it('rejects duplicate imported table names', async () => {
    const structure = {
      tables: [
        {
          id: 'tblduplicatename001',
          name: 'Duplicate',
          fields: [
            {
              id: 'fldduplicateone0001',
              name: 'Name',
              type: 'singleLineText',
              isPrimary: true,
            },
          ],
          views: [{ type: 'grid', name: 'Grid' }],
        },
        {
          id: 'tblduplicatename002',
          name: 'Duplicate',
          fields: [
            {
              id: 'fldduplicatetwo0001',
              name: 'Name',
              type: 'singleLineText',
              isPrimary: true,
            },
          ],
          views: [{ type: 'grid', name: 'Grid' }],
        },
      ],
    };
    const recipe: NonNullable<BenchCaseManifest['dataset']['recipe']> = { tables: {} };
    const teaPath = resolve(process.cwd(), 'fixtures/loader-duplicate-tables.tea');
    await writeFile(teaPath, writeTeaArchive(structure));
    try {
      await expect(
        loadCase({
          teaPath,
          manifest: manifestFor({ structure, recipe, rows: { Duplicate: 1 } }),
        })
      ).rejects.toMatchObject({ code: 'bench.table.ambiguous' });
    } finally {
      await unlink(teaPath).catch(() => undefined);
    }
  });
});
