import {
  computeCaseId,
  computeDatasetHash,
  parseBenchCaseManifest,
  verifyCaseId,
  type BenchCaseManifest,
} from './manifest';

const base = {
  caseId: `sha256:${'0'.repeat(64)}`,
  specVersion: 1 as const,
  generatorVersion: 'test/1',
  title: 'Example',
  source: { tea: 'fixture.tea', dataMode: 'recipe' as const },
  dataset: {
    rows: { Orders: 10 },
    seed: { schema: 1, data: 2, query: 3, schedule: 4 },
    recipe: { tables: {} },
  },
  workload: [{ key: 'list', kind: 'query-core' as const, table: 'Orders', query: { limit: 10 } }],
  oracle: [
    {
      key: 'rows',
      kind: 'invariant' as const,
      checks: [{ type: 'row-count' as const, table: 'Orders', expected: 10 }],
    },
  ],
};

function signedManifest(
  dataset: BenchCaseManifest['dataset'],
  dataMode: BenchCaseManifest['source']['dataMode'] = 'recipe'
): BenchCaseManifest {
  const datasetHash = computeDatasetHash({
    dataMode,
    rows: dataset.rows,
    seed: dataset.seed,
    recipe: dataset.recipe,
    csvByEntry:
      dataMode === 'materialized' ? new Map([['tables/orders.csv', 'Title\nA\n']]) : undefined,
  });
  return parseBenchCaseManifest({
    ...base,
    source: { ...base.source, dataMode },
    dataset: { ...dataset, dataHash: datasetHash },
    caseId: computeCaseId({
      specVersion: 1,
      generatorVersion: base.generatorVersion,
      schemaHash: 'schema',
      datasetHash,
      workload: base.workload,
      oracle: base.oracle,
    }),
  });
}

describe('manifest', () => {
  it('parses a valid manifest and supplies run defaults', () => {
    expect(parseBenchCaseManifest(base).run).toEqual({
      backend: 'pglite',
      samples: 5,
      warmup: 2,
      repetitions: 1,
      seedBatchSize: 1000,
      actorId: 'usr_headless',
    });
  });
  it('rejects unknown top-level keys', () =>
    expect(() => parseBenchCaseManifest({ ...base, surprise: true })).toThrow());
  it('requires workload entries', () =>
    expect(() => parseBenchCaseManifest({ ...base, workload: [] })).toThrow());
  it('rejects duplicate workload keys with the stable code', () => {
    try {
      parseBenchCaseManifest({ ...base, workload: [...base.workload, ...base.workload] });
    } catch (error) {
      expect(String(error)).toContain('bench.manifest.duplicate_key');
      return;
    }
    throw new Error('expected duplicate rejection');
  });
  it('is stable across object key order', () => {
    const input = {
      specVersion: 1 as const,
      generatorVersion: 'v1',
      schemaHash: 'schema',
      datasetHash: 'data',
      workload: base.workload,
      oracle: base.oracle,
    };
    const reordered = {
      oracle: base.oracle,
      workload: base.workload,
      datasetHash: 'data',
      schemaHash: 'schema',
      generatorVersion: 'v1',
      specVersion: 1 as const,
    };
    expect(computeCaseId(input)).toBe(computeCaseId(reordered));
  });
  it('changes when workload changes', () => {
    const common = {
      specVersion: 1 as const,
      generatorVersion: 'v1',
      schemaHash: 'schema',
      datasetHash: 'data',
      oracle: base.oracle,
    };
    expect(computeCaseId({ ...common, workload: base.workload })).not.toBe(
      computeCaseId({ ...common, workload: [{ ...base.workload[0], query: { limit: 11 } }] })
    );
  });

  it('binds explicit full-recompute reference reuse into case identity', () => {
    const common = {
      specVersion: 1 as const,
      generatorVersion: 'v1',
      schemaHash: 'schema',
      datasetHash: 'data',
      oracle: base.oracle,
    };
    const workload = [
      {
        key: 'proof',
        kind: 'checkpoint' as const,
        check: {
          checkId: 'proof',
          description: 'proof',
          obligationIds: [],
          kind: 'full-recompute' as const,
          tables: ['Orders'],
        },
      },
    ];
    expect(computeCaseId({ ...common, workload })).not.toBe(
      computeCaseId({
        ...common,
        workload: [
          {
            ...workload[0]!,
            check: { ...workload[0]!.check, reuse: 'identical-state' as const },
          },
        ],
      })
    );
  });

  it('binds recipe identity to rows, full seeds, and recipe contents', () => {
    const manifest = signedManifest(base.dataset);
    verifyCaseId(manifest, 'schema');

    const changes: BenchCaseManifest['dataset'][] = [
      { ...manifest.dataset, rows: { Orders: 11 } },
      { ...manifest.dataset, seed: { ...manifest.dataset.seed, schedule: 99 } },
      {
        ...manifest.dataset,
        recipe: { tables: { Orders: { fields: { Amount: { min: 3 } } } } },
      },
    ];
    for (const dataset of changes) {
      expect(() => verifyCaseId({ ...manifest, dataset }, 'schema')).toThrowError(
        /bench\.case\.data_hash_mismatch/
      );
    }
  });

  it('keeps dataset hashes stable across canonical object key order', () => {
    const first = computeDatasetHash({
      dataMode: 'recipe',
      rows: { Orders: 10, Customers: 2 },
      seed: { schema: 1, data: 2, query: 3, schedule: 4 },
      recipe: {
        tables: {
          Orders: { fields: { Amount: { min: 1, max: 10 } } },
        },
      },
    });
    const reordered = computeDatasetHash({
      dataMode: 'recipe',
      rows: { Customers: 2, Orders: 10 },
      seed: { schedule: 4, query: 3, data: 2, schema: 1 },
      recipe: {
        tables: {
          Orders: { fields: { Amount: { max: 10, min: 1 } } },
        },
      },
    });
    expect(reordered).toBe(first);
  });

  it('binds materialized identity to sorted CSV entries, rows, and seeds', () => {
    const csv = new Map([
      ['tables/z.csv', 'Name\nZ\n'],
      ['tables/a.csv', 'Name\nA\n'],
    ]);
    const dataset = { rows: { Orders: 2 }, seed: base.dataset.seed };
    const datasetHash = computeDatasetHash({
      dataMode: 'materialized',
      ...dataset,
      csvByEntry: csv,
    });
    const manifest = parseBenchCaseManifest({
      ...base,
      source: { ...base.source, dataMode: 'materialized' },
      dataset: { ...dataset, dataHash: datasetHash },
      caseId: computeCaseId({
        specVersion: 1,
        generatorVersion: base.generatorVersion,
        schemaHash: 'schema',
        datasetHash,
        workload: base.workload,
        oracle: base.oracle,
      }),
    });

    verifyCaseId(manifest, 'schema', new Map([...csv].reverse()));
    expect(() =>
      verifyCaseId(
        manifest,
        'schema',
        new Map([...csv, ['tables/a.csv', 'Name\nTampered\n'] as const])
      )
    ).toThrowError(/bench\.case\.data_hash_mismatch/);
    for (const dataset of [
      { ...manifest.dataset, rows: { Orders: 3 } },
      { ...manifest.dataset, seed: { ...manifest.dataset.seed, data: 99 } },
    ]) {
      expect(() => verifyCaseId({ ...manifest, dataset }, 'schema', csv)).toThrowError(
        /bench\.case\.data_hash_mismatch/
      );
    }
  });
});

describe('sequence primitives', () => {
  const manifest = (workload: unknown[]) => ({
    caseId: `sha256:${'a'.repeat(64)}`,
    specVersion: 1,
    generatorVersion: 'test',
    title: 'Sequence',
    source: { tea: 'case.tea', dataMode: 'recipe' },
    dataset: {
      rows: { Orders: 1 },
      seed: { schema: 1, data: 2, query: 3, schedule: 4 },
    },
    workload,
    oracle: [
      {
        key: 'invariants',
        kind: 'invariant',
        checks: [{ type: 'row-count', table: 'Orders', expected: 1 }],
      },
    ],
  });

  it('accepts checkpoint, expect-error, link-targets and fromOperation cursors', () => {
    const parsed = parseBenchCaseManifest(
      manifest([
        {
          key: 'update',
          kind: 'write-update',
          table: 'Orders',
          field: 'Customer',
          rows: 1,
          batchSize: 1,
          typecast: false,
          value: { kind: 'link-targets', table: 'Customers', indices: [] },
        },
        {
          key: 'check',
          kind: 'checkpoint',
          check: {
            checkId: 'rows',
            description: 'one order',
            obligationIds: ['obl'],
            kind: 'row-count',
            table: 'Orders',
            expected: 1,
          },
        },
        {
          key: 'reject',
          kind: 'expect-error',
          expectedCode: 'validation.field.invalid_value',
          step: {
            kind: 'query-core',
            table: 'Orders',
            query: { limit: 1, cursor: { fromOperation: 'page' } },
          },
        },
      ])
    );
    expect(parsed.workload.map((step) => step.kind)).toEqual([
      'write-update',
      'checkpoint',
      'expect-error',
    ]);
    const queryValues = parseBenchCaseManifest(
      manifest([
        {
          key: 'check-values',
          kind: 'checkpoint',
          check: {
            checkId: 'values',
            description: 'ordered rows',
            obligationIds: ['obl'],
            kind: 'query-values',
            operations: ['page'],
            ordered: true,
            expected: [{ Amount: 1 }],
          },
        },
      ])
    );
    expect(queryValues.workload[0]).toMatchObject({
      kind: 'checkpoint',
      check: { kind: 'query-values', ordered: true },
    });
  });

  it('parses explicit full-recompute reuse and leaves omitted checks unchanged', () => {
    const parsed = parseBenchCaseManifest({
      ...manifest([
        {
          key: 'checkpoint-reused',
          kind: 'checkpoint',
          check: {
            checkId: 'checkpoint-reused',
            description: 'reused checkpoint',
            obligationIds: [],
            kind: 'full-recompute',
            tables: ['Orders'],
            reuse: 'identical-state',
          },
        },
        { key: 'flush', kind: 'flush-computed' },
      ]),
      oracle: [
        {
          key: 'reused',
          kind: 'full-recompute',
          tables: ['Orders'],
          reuse: 'identical-state',
        },
        { key: 'fresh', kind: 'full-recompute', tables: ['Orders'] },
      ],
    });
    expect(parsed.oracle[0]).toMatchObject({ reuse: 'identical-state' });
    expect(parsed.workload[0]).toMatchObject({
      kind: 'checkpoint',
      check: { kind: 'full-recompute', reuse: 'identical-state' },
    });
    expect(parsed.oracle[1]).not.toHaveProperty('reuse');
  });

  it('rejects a cursor combined with an offset', () => {
    expect(() =>
      parseBenchCaseManifest(
        manifest([
          {
            key: 'page',
            kind: 'query-core',
            table: 'Orders',
            query: { limit: 1, offset: 1, cursor: 'abc' },
          },
        ])
      )
    ).toThrowError(/bench\.query\.cursor_with_offset/);
  });
});
