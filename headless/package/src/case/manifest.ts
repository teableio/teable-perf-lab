import { z } from 'zod';

import { BenchError } from '../errors';
import { canonicalJson, sha256Hex } from './canonicalJson';

export type BenchBackend = 'pglite' | 'postgres';
export type BenchWriteValue =
  | { kind: 'literal'; value: unknown }
  | { kind: 'number-increment'; start: number; step: number }
  | { kind: 'text-suffix'; prefix: string }
  | { kind: 'select-cycle'; choices: ReadonlyArray<string> }
  | { kind: 'link-targets'; table: string; indices: ReadonlyArray<number> };
export type BenchQuery = {
  filter?: unknown;
  sort?: ReadonlyArray<{ fieldId: string; order: 'asc' | 'desc' }>;
  groupBy?: ReadonlyArray<string>;
  projection?: ReadonlyArray<string>;
  limit?: number;
  offset?: number;
  cursor?: string | { fromOperation: string };
  includeTotal?: boolean;
  viewId?: string;
};
export type BenchWorkloadStep =
  | {
      key: string;
      kind: 'query-core';
      table: string;
      query: BenchQuery;
    }
  | {
      key: string;
      kind: 'query-structured';
      definition: unknown;
      parameters?: Readonly<Record<string, unknown>>;
    }
  | {
      key: string;
      kind: 'write-create';
      table: string;
      rows: number;
      batchSize: number;
      typecast: boolean;
    }
  | {
      key: string;
      kind: 'write-update';
      table: string;
      field: string;
      rows: number;
      batchSize: number;
      typecast: boolean;
      selection?: 'first' | 'random';
      value: BenchWriteValue;
    }
  | {
      key: string;
      kind: 'write-delete';
      table: string;
      rows: number;
      batchSize: number;
      selection?: 'first' | 'random';
    }
  | { key: string; kind: 'flush-computed' }
  | { key: string; kind: 'checkpoint'; check: BenchCheckpointCheck }
  | {
      key: string;
      kind: 'expect-error';
      checkId?: string;
      description?: string;
      obligationIds?: ReadonlyArray<string>;
      expectedCode: string;
      unchanged?: {
        table: string;
        field: string;
        selection: 'first';
        rows: number;
      };
      step: BenchExpectErrorStep;
    };
export type FullRecomputeReuse = 'identical-state';

/** A state assertion at its declared position in the workload sequence. */
export type BenchCheckpointCheck = {
  checkId: string;
  description: string;
  obligationIds: ReadonlyArray<string>;
} & (
  | { kind: 'row-count'; table: string; expected: number }
  | { kind: 'field-values'; table: string; field?: string; expected: unknown }
  | {
      kind: 'full-recompute';
      tables: ReadonlyArray<string>;
      maxRows?: number;
      reuse?: FullRecomputeReuse;
    }
  | {
      kind: 'query-record-ids';
      operations: ReadonlyArray<string>;
      expectedTotal?: number;
      table?: string;
    }
  | {
      kind: 'query-values';
      operations: ReadonlyArray<string>;
      expected: unknown;
      ordered?: boolean;
    }
);
export type BenchExpectErrorStep =
  | {
      kind: 'query-core';
      table: string;
      query: BenchQuery;
    }
  | {
      kind: 'write-create';
      table: string;
      rows: number;
      batchSize: number;
      typecast: boolean;
    }
  | {
      kind: 'write-update';
      table: string;
      field: string;
      rows: number;
      batchSize: number;
      typecast: boolean;
      selection?: 'first' | 'random';
      value: BenchWriteValue;
    };
export type BenchOracleMetadata = {
  readonly checkId?: string;
  readonly description?: string;
  readonly obligationIds?: ReadonlyArray<string>;
};
export type BenchInvariantCheck = BenchOracleMetadata &
  (
    | { type: 'row-count'; table: string; expected: number }
    | { type: 'unique-primary'; table: string }
    | { type: 'link-count'; table: string; field: string; expected: number }
    | { type: 'computed-not-null'; table: string; fields: ReadonlyArray<string> }
  );
export type BenchOracle =
  | (BenchOracleMetadata & { key: string; kind: 'expected-json'; path: string })
  | (BenchOracleMetadata & {
      key: string;
      kind: 'invariant';
      checks: ReadonlyArray<BenchInvariantCheck>;
    })
  | (BenchOracleMetadata & {
      key: string;
      kind: 'full-recompute';
      tables: ReadonlyArray<string>;
      maxRows?: number;
      reuse?: FullRecomputeReuse;
    });
export type BenchDatasetRecipe = {
  readonly tables: Readonly<
    Record<
      string,
      {
        readonly fields: Readonly<
          Record<
            string,
            {
              readonly nullFraction?: number;
              readonly distribution?: 'uniform' | 'zipf' | 'constant' | 'clustered';
              readonly cardinality?: number;
              readonly min?: number;
              readonly max?: number;
              readonly width?: number;
              readonly choices?: ReadonlyArray<string>;
              readonly link?: {
                readonly table: string;
                readonly fanout?: number;
                readonly relationship: 'manyOne' | 'manyMany';
              };
            }
          >
        >;
      }
    >
  >;
};
export type BenchCaseManifest = {
  readonly caseId: string;
  readonly specVersion: 1;
  readonly generatorVersion: string;
  readonly title: string;
  readonly dimensions?: Readonly<Record<string, unknown>>;
  readonly source: { readonly tea: string; readonly dataMode: 'materialized' | 'recipe' };
  readonly dataset: {
    readonly rows: Readonly<Record<string, number>>;
    readonly seed: {
      readonly schema: number;
      readonly data: number;
      readonly query: number;
      readonly schedule: number;
    };
    readonly recipe?: BenchDatasetRecipe;
    readonly dataHash?: string;
  };
  readonly run: {
    readonly backend: BenchBackend;
    readonly samples: number;
    readonly warmup: number;
    readonly repetitions: number;
    readonly seedBatchSize: number;
    readonly actorId: string;
  };
  readonly workload: ReadonlyArray<BenchWorkloadStep>;
  readonly oracle: ReadonlyArray<BenchOracle>;
  readonly budgets?: {
    readonly maxScanRows?: number;
    readonly maxDirtyRows?: number;
    /** Legacy one-limit policy; retained only for existing manifests. */
    readonly sloP95Ms?: number | null;
    readonly sloSource?: string;
    readonly budgetModelVersion?: string | null;
    readonly performance?: {
      readonly modelVersion: 'tea-bench-budget/1';
      readonly source: string;
      /** Maximum p95 for the sum of one complete workload sample. */
      readonly maxP95Ms: number;
      /** Every measured workload operation requires its own p95 budget. */
      readonly operations: Readonly<
        Record<string, { readonly maxP95Ms: number; readonly weight?: number }>
      >;
    };
  };
  readonly links?: {
    readonly perfLabCaseId?: string;
    readonly requirementIds?: ReadonlyArray<string>;
    readonly issueIds?: ReadonlyArray<string>;
  };
};

const writeValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.unknown() }),
  z.object({ kind: z.literal('number-increment'), start: z.number(), step: z.number() }),
  z.object({ kind: z.literal('text-suffix'), prefix: z.string() }),
  z.object({ kind: z.literal('select-cycle'), choices: z.array(z.string()) }),
  z.object({
    kind: z.literal('link-targets'),
    table: z.string().min(1),
    indices: z.array(z.number().int().nonnegative()),
  }),
]);
const querySchema = z
  .object({
    filter: z.unknown().optional(),
    sort: z.array(z.object({ fieldId: z.string(), order: z.enum(['asc', 'desc']) })).optional(),
    groupBy: z.array(z.string()).optional(),
    projection: z.array(z.string()).optional(),
    limit: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
    cursor: z.union([z.string().min(1), z.object({ fromOperation: z.string().min(1) })]).optional(),
    includeTotal: z.boolean().optional(),
    viewId: z.string().optional(),
  })
  .superRefine((query, context) => {
    if (query.cursor !== undefined && query.offset !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'bench.query.cursor_with_offset',
        path: ['cursor'],
      });
    }
  });
const writeUpdateSchema = z.object({
  kind: z.literal('write-update'),
  table: z.string(),
  field: z.string(),
  rows: z.number().int().nonnegative(),
  batchSize: z.number().int().positive(),
  typecast: z.boolean(),
  selection: z.enum(['first', 'random']).optional(),
  value: writeValueSchema,
});
const writeCreateSchema = z.object({
  kind: z.literal('write-create'),
  table: z.string(),
  rows: z.number().int().nonnegative(),
  batchSize: z.number().int().positive(),
  typecast: z.boolean(),
});
const queryCoreSchema = z.object({
  kind: z.literal('query-core'),
  table: z.string(),
  query: querySchema,
});
const workloadSchema = z.discriminatedUnion('kind', [
  z.object({ key: z.string(), ...queryCoreSchema.shape }),
  z.object({
    key: z.string(),
    kind: z.literal('query-structured'),
    definition: z.unknown(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ key: z.string(), ...writeCreateSchema.shape }),
  z.object({ key: z.string(), ...writeUpdateSchema.shape }),
  z.object({
    key: z.string(),
    kind: z.literal('write-delete'),
    table: z.string(),
    rows: z.number().int().nonnegative(),
    batchSize: z.number().int().positive(),
    selection: z.enum(['first', 'random']).optional(),
  }),
  z.object({ key: z.string(), kind: z.literal('flush-computed') }),
  z.object({
    key: z.string(),
    kind: z.literal('checkpoint'),
    check: z.discriminatedUnion('kind', [
      z.object({
        checkId: z.string().min(1),
        description: z.string().min(1),
        obligationIds: z.array(z.string()),
        kind: z.literal('row-count'),
        table: z.string().min(1),
        expected: z.number().int().nonnegative(),
      }),
      z.object({
        checkId: z.string().min(1),
        description: z.string().min(1),
        obligationIds: z.array(z.string()),
        kind: z.literal('field-values'),
        table: z.string().min(1),
        field: z.string().optional(),
        expected: z.unknown(),
      }),
      z.object({
        checkId: z.string().min(1),
        description: z.string().min(1),
        obligationIds: z.array(z.string()),
        kind: z.literal('full-recompute'),
        tables: z.array(z.string().min(1)).min(1),
        maxRows: z.number().int().positive().optional(),
        reuse: z.literal('identical-state').optional(),
      }),
      z.object({
        checkId: z.string().min(1),
        description: z.string().min(1),
        obligationIds: z.array(z.string()),
        kind: z.literal('query-record-ids'),
        operations: z.array(z.string().min(1)).min(1),
        expectedTotal: z.number().int().nonnegative().optional(),
        table: z.string().min(1).optional(),
      }),
      z.object({
        checkId: z.string().min(1),
        description: z.string().min(1),
        obligationIds: z.array(z.string()),
        kind: z.literal('query-values'),
        operations: z.array(z.string().min(1)).min(1),
        expected: z.unknown(),
        ordered: z.boolean().optional(),
      }),
    ]),
  }),
  z.object({
    key: z.string(),
    kind: z.literal('expect-error'),
    checkId: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    obligationIds: z.array(z.string()).optional(),
    expectedCode: z.string().min(1),
    unchanged: z
      .object({
        table: z.string(),
        field: z.string(),
        selection: z.literal('first'),
        rows: z.number().int().positive(),
      })
      .optional(),
    step: z.discriminatedUnion('kind', [queryCoreSchema, writeCreateSchema, writeUpdateSchema]),
  }),
]);
const oracleMetadataSchema = {
  checkId: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  obligationIds: z.array(z.string().min(1)).optional(),
};
const invariantSchema = z.discriminatedUnion('type', [
  z.object({
    ...oracleMetadataSchema,
    type: z.literal('row-count'),
    table: z.string(),
    expected: z.number().int().nonnegative(),
  }),
  z.object({ ...oracleMetadataSchema, type: z.literal('unique-primary'), table: z.string() }),
  z.object({
    ...oracleMetadataSchema,
    type: z.literal('link-count'),
    table: z.string(),
    field: z.string(),
    expected: z.number().int().nonnegative(),
  }),
  z.object({
    ...oracleMetadataSchema,
    type: z.literal('computed-not-null'),
    table: z.string(),
    fields: z.array(z.string()),
  }),
]);
const oracleSchema = z.discriminatedUnion('kind', [
  z.object({
    ...oracleMetadataSchema,
    key: z.string(),
    kind: z.literal('expected-json'),
    path: z.string(),
  }),
  z.object({
    ...oracleMetadataSchema,
    key: z.string(),
    kind: z.literal('invariant'),
    checks: z.array(invariantSchema),
  }),
  z.object({
    ...oracleMetadataSchema,
    key: z.string(),
    kind: z.literal('full-recompute'),
    tables: z.array(z.string()),
    maxRows: z.number().int().positive().optional(),
    reuse: z.literal('identical-state').optional(),
  }),
]);
const fieldRecipeSchema = z.object({
  nullFraction: z.number().min(0).max(1).optional(),
  distribution: z.enum(['uniform', 'zipf', 'constant', 'clustered']).optional(),
  cardinality: z.number().int().positive().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  width: z.number().int().positive().optional(),
  choices: z.array(z.string()).optional(),
  link: z
    .object({
      table: z.string(),
      fanout: z.number().int().positive().optional(),
      relationship: z.enum(['manyOne', 'manyMany']),
    })
    .optional(),
});
const defaultRun = {
  backend: 'pglite' as const,
  samples: 5,
  warmup: 2,
  repetitions: 1,
  seedBatchSize: 1000,
  actorId: 'usr_headless',
};

export const benchCaseManifestSchema = z
  .object({
    caseId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    specVersion: z.literal(1),
    generatorVersion: z.string(),
    title: z.string(),
    dimensions: z.record(z.string(), z.unknown()).optional(),
    source: z.object({ tea: z.string(), dataMode: z.enum(['materialized', 'recipe']) }),
    dataset: z.object({
      rows: z.record(z.string(), z.number().int().nonnegative()),
      seed: z.object({
        schema: z.number(),
        data: z.number(),
        query: z.number(),
        schedule: z.number(),
      }),
      recipe: z
        .object({
          tables: z.record(
            z.string(),
            z.object({ fields: z.record(z.string(), fieldRecipeSchema) })
          ),
        })
        .optional(),
      dataHash: z.string().optional(),
    }),
    run: z
      .object({
        backend: z.enum(['pglite', 'postgres']),
        samples: z.number().int().positive(),
        warmup: z.number().int().nonnegative(),
        repetitions: z.number().int().positive(),
        seedBatchSize: z.number().int().positive(),
        actorId: z.string(),
      })
      .default(defaultRun),
    workload: z.array(workloadSchema).min(1),
    oracle: z.array(oracleSchema).min(1),
    budgets: z
      .object({
        maxScanRows: z.number().optional(),
        maxDirtyRows: z.number().optional(),
        sloP95Ms: z.number().nullable().optional(),
        sloSource: z.string().optional(),
        budgetModelVersion: z.string().nullable().optional(),
        performance: z
          .object({
            modelVersion: z.literal('tea-bench-budget/1'),
            source: z.string().trim().min(1),
            maxP95Ms: z.number().finite().positive(),
            operations: z.record(
              z.string().min(1),
              z.object({
                maxP95Ms: z.number().finite().positive(),
                weight: z.number().finite().positive().optional(),
              })
            ),
          })
          .optional(),
      })
      .optional(),
    links: z
      .object({
        perfLabCaseId: z.string().optional(),
        requirementIds: z.array(z.string()).optional(),
        issueIds: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const entries of [manifest.workload, manifest.oracle]) {
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.key))
          context.addIssue({
            code: 'custom',
            message: 'bench.manifest.duplicate_key',
            path: [entries === manifest.workload ? 'workload' : 'oracle', entry.key],
          });
        seen.add(entry.key);
      }
    }
  });

export function parseBenchCaseManifest(input: unknown): BenchCaseManifest {
  return benchCaseManifestSchema.parse(input) as BenchCaseManifest;
}

export function computeCaseId(input: {
  specVersion: 1;
  generatorVersion: string;
  schemaHash: string;
  datasetHash: string;
  workload: ReadonlyArray<BenchWorkloadStep>;
  oracle: ReadonlyArray<BenchOracle>;
}): string {
  return `sha256:${sha256Hex(canonicalJson(input))}`;
}

export function computeDatasetHash(input: {
  dataMode: BenchCaseManifest['source']['dataMode'];
  rows: BenchCaseManifest['dataset']['rows'];
  seed: BenchCaseManifest['dataset']['seed'];
  recipe?: BenchDatasetRecipe;
  csvByEntry?: ReadonlyMap<string, string>;
}): string {
  if (input.dataMode === 'recipe') {
    return sha256Hex(canonicalJson({ rows: input.rows, recipe: input.recipe, seed: input.seed }));
  }
  if (!input.csvByEntry) {
    throw new BenchError(
      'bench.case.dataset_contents_missing',
      'Materialized dataset identity requires the archive CSV entries'
    );
  }
  const csvEntries = [...input.csvByEntry.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return sha256Hex(canonicalJson({ rows: input.rows, seed: input.seed, csvEntries }));
}

export function verifyCaseId(
  manifest: BenchCaseManifest,
  schemaHash: string,
  csvByEntry?: ReadonlyMap<string, string>
): void {
  if (!manifest.dataset.dataHash && manifest.source.dataMode === 'materialized') {
    throw new BenchError(
      'bench.case.data_hash_missing',
      'Materialized data requires dataset.dataHash'
    );
  }
  const datasetHash = computeDatasetHash({
    dataMode: manifest.source.dataMode,
    rows: manifest.dataset.rows,
    seed: manifest.dataset.seed,
    recipe: manifest.dataset.recipe,
    csvByEntry,
  });
  if (manifest.dataset.dataHash && manifest.dataset.dataHash !== datasetHash) {
    throw new BenchError(
      'bench.case.data_hash_mismatch',
      'Manifest dataset.dataHash does not match its canonical contents',
      { expected: datasetHash, actual: manifest.dataset.dataHash }
    );
  }
  const expected = computeCaseId({
    specVersion: manifest.specVersion,
    generatorVersion: manifest.generatorVersion,
    schemaHash,
    datasetHash,
    workload: manifest.workload,
    oracle: manifest.oracle,
  });
  if (manifest.caseId !== expected)
    throw new BenchError(
      'bench.case.id_mismatch',
      'Manifest caseId does not match its canonical contents',
      { expected, actual: manifest.caseId }
    );
}
