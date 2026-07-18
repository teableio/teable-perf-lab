import { duplicateField } from "@teable/openapi";
import {
  deleteField,
  getFields,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, roundMetric, type Measurement } from "../metrics";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import {
  buildSeedCacheInfo,
  buildSeedTableName,
  type SeedCacheInfo,
} from "../seed-cache";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  ConditionalLookupFieldDuplicateCaseConfig,
  FieldDuplicateCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  ScalarFieldDuplicateCaseConfig,
} from "../types";
import {
  assertConditionalLookupSeedReady,
  buildConditionalLookupSeedFixture,
  createConditionalLookupField,
  waitForConditionalLookupFullScan,
  type ConditionalLookupSeedFixture,
} from "./conditional-lookup.runner";
import {
  runFieldAddLifecycle,
  seedFieldAddLifecycle,
  type FieldAddLifecycleSpec,
} from "./field-add-lifecycle";
import {
  runScalarFieldDuplicateCase,
  seedScalarFieldDuplicateCase,
} from "./field-duplicate-scalar.runner";

const FIELD_DUPLICATE_FIXTURE_VERSION = "field-duplicate-v1";

type FieldDuplicateSeedFixture = ConditionalLookupSeedFixture & {
  sourceLookupFieldId: string;
  sourceLookupFieldName: string;
  createSourceLookupFieldMeasurement: Measurement<{ id: string }>;
  sourceLookupScanReadyMeasurement: Measurement<
    Awaited<ReturnType<typeof waitForConditionalLookupFullScan>>
  >;
};

type FieldDuplicatePrimaryResult = {
  field: {
    id: string;
    name: string;
  };
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
};

const pickResponseHeaders = pickRoutingResponseHeaders;

const assertExpectedRouting = (
  context: PerfRunContext,
  responseHeaders: Record<string, string>,
) =>
  assertEngineRouting(context, responseHeaders, {
    feature: "duplicateField",
    operation: "Field duplicate",
  });

const getConditionalLookupSeedConfig = (
  config: ConditionalLookupFieldDuplicateCaseConfig,
) => ({
  baseId: config.baseId,
  sourceTableNamePrefix: config.sourceTableNamePrefix,
  hostTableNamePrefix: config.hostTableNamePrefix,
  recordCount: config.recordCount,
  batchSize: config.batchSize,
  generator: config.generator,
  lookup: config.lookup,
  duplicate: config.duplicate,
  verifySampleRows: config.verify.sampleRows,
  verifyFullScanPageSize: config.verify.fullScanPageSize,
  fixtureVersion: FIELD_DUPLICATE_FIXTURE_VERSION,
});

const buildFieldDuplicateSeedCacheInfo = (perfCase: PerfCase) => {
  const config = perfCase.config as ConditionalLookupFieldDuplicateCaseConfig;
  return buildSeedCacheInfo({
    perfCase,
    runner: "field-duplicate",
    fixtureVersion: FIELD_DUPLICATE_FIXTURE_VERSION,
    seedConfig: getConditionalLookupSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("./conditional-lookup.runner.ts", import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
};

const createSeedFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  seedCacheInfo: SeedCacheInfo,
): Promise<FieldDuplicateSeedFixture> => {
  const config = perfCase.config as ConditionalLookupFieldDuplicateCaseConfig;
  const timestamp = Date.now();
  const baseId = globalThis.testConfig.baseId;
  const sourceTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "source")
    : `${config.sourceTableNamePrefix}-${timestamp}`;
  const hostTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "host")
    : `${config.hostTableNamePrefix}-${timestamp}`;

  const seedFixture = await buildConditionalLookupSeedFixture(
    perfCase,
    context,
    baseId,
    sourceTableName,
    hostTableName,
    config,
    seedCacheInfo,
    { cleanupHostLookupFields: false },
  );
  const existingLookupField = (
    (await getFields(seedFixture.hostTableId)) as Array<{
      id: string;
      name: string;
    }>
  ).find((field) => field.name === config.lookup.name);
  const createSourceLookupFieldMeasurement = existingLookupField
    ? {
        name: "sourceLookupFieldCached",
        durationMs: 0,
        result: existingLookupField,
      }
    : await withPerfTraceStep(
        context,
        perfCase,
        "seedBuild:createLookupField",
        () =>
          measureAsync("seedBuild:createLookupField", () =>
            createConditionalLookupField(
              seedFixture.hostTableId,
              seedFixture.sourceTableId,
              seedFixture.sourceFields,
              seedFixture.hostFields,
              config,
            ),
          ),
      );
  const sourceLookupScanReadyMeasurement = await measureAsync(
    existingLookupField
      ? "sourceLookupScanReadyCached"
      : "seedBuild:sourceLookupScanReady",
    () =>
      waitForConditionalLookupFullScan(
        seedFixture.hostTableId,
        createSourceLookupFieldMeasurement.result.id,
        config,
        seedFixture.hostFields,
      ),
  );

  return {
    ...seedFixture,
    sourceLookupFieldId: createSourceLookupFieldMeasurement.result.id,
    sourceLookupFieldName: createSourceLookupFieldMeasurement.result.name,
    createSourceLookupFieldMeasurement,
    sourceLookupScanReadyMeasurement,
  };
};

const buildFieldDuplicateResult = ({
  config,
  seedFixture,
  seedReadyMeasurement,
  duplicateFieldMeasurement,
  duplicatedLookupScanReadyMeasurement,
  seedCacheInfo,
  error,
}: {
  config: ConditionalLookupFieldDuplicateCaseConfig;
  seedFixture: FieldDuplicateSeedFixture;
  seedReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertConditionalLookupSeedReady>>
  >;
  duplicateFieldMeasurement?: Measurement<FieldDuplicatePrimaryResult>;
  duplicatedLookupScanReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof waitForConditionalLookupFullScan>>
  >;
  seedCacheInfo: SeedCacheInfo;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    seedCacheHit: seedFixture.seedCacheHit ? 1 : 0,
    seedCacheEnabled: seedCacheInfo.enabled ? 1 : 0,
    ...(seedFixture.seedCacheHit
      ? { seedRestoreMs: seedFixture.createTablesMeasurement.durationMs }
      : seedCacheInfo.enabled
        ? {
            seedBuildMs: roundMetric(
              seedFixture.createTablesMeasurement.durationMs +
                seedFixture.seedSourceMeasurement.durationMs +
                seedFixture.seedHostMeasurement.durationMs +
                seedFixture.createSourceLookupFieldMeasurement.durationMs +
                seedFixture.sourceLookupScanReadyMeasurement.durationMs,
            ),
          }
        : {}),
    createTablesMs: seedFixture.createTablesMeasurement.durationMs,
    seedSourceRecordsMs: seedFixture.seedSourceMeasurement.durationMs,
    seedHostRecordsMs: seedFixture.seedHostMeasurement.durationMs,
    maxSeedBatchMs: roundMetric(
      Math.max(
        ...seedFixture.sourceBatchDurations,
        ...seedFixture.hostBatchDurations,
      ),
    ),
    ...(seedReadyMeasurement
      ? { seedReadyMs: seedReadyMeasurement.durationMs }
      : {}),
    createSourceLookupFieldMs:
      seedFixture.createSourceLookupFieldMeasurement.durationMs,
    sourceLookupScanReadyMs:
      seedFixture.sourceLookupScanReadyMeasurement.durationMs,
    ...(duplicateFieldMeasurement
      ? { duplicateFieldMs: duplicateFieldMeasurement.durationMs }
      : {}),
    ...(duplicatedLookupScanReadyMeasurement
      ? {
          duplicatedLookupScanReadyMs:
            duplicatedLookupScanReadyMeasurement.durationMs,
        }
      : {}),
    ...(duplicateFieldMeasurement
      ? {
          conditionalLookupDuplicateReadyMs:
            duplicateFieldMeasurement.durationMs,
        }
      : {}),
  },
  thresholds: duplicatedLookupScanReadyMeasurement
    ? [
        {
          metric: config.threshold.metric,
          max: getPrimaryThresholdMs(config.threshold.maxMs),
          unit: "ms",
        },
      ]
    : [],
  phases: [
    {
      name: seedFixture.createTablesMeasurement.name,
      durationMs: seedFixture.createTablesMeasurement.durationMs,
    },
    {
      name: seedFixture.seedSourceMeasurement.name,
      durationMs: seedFixture.seedSourceMeasurement.durationMs,
    },
    {
      name: seedFixture.seedHostMeasurement.name,
      durationMs: seedFixture.seedHostMeasurement.durationMs,
    },
    ...(seedReadyMeasurement
      ? [
          {
            name: seedReadyMeasurement.name,
            durationMs: seedReadyMeasurement.durationMs,
          },
        ]
      : []),
    {
      name: seedFixture.createSourceLookupFieldMeasurement.name,
      durationMs: seedFixture.createSourceLookupFieldMeasurement.durationMs,
    },
    {
      name: seedFixture.sourceLookupScanReadyMeasurement.name,
      durationMs: seedFixture.sourceLookupScanReadyMeasurement.durationMs,
    },
    ...(duplicateFieldMeasurement
      ? [
          {
            name: duplicateFieldMeasurement.name,
            durationMs: duplicateFieldMeasurement.durationMs,
          },
        ]
      : []),
    ...(duplicatedLookupScanReadyMeasurement
      ? [
          {
            name: duplicatedLookupScanReadyMeasurement.name,
            durationMs: duplicatedLookupScanReadyMeasurement.durationMs,
          },
        ]
      : []),
  ],
  details: {
    seed: {
      enabled: seedCacheInfo.enabled,
      seedHash: seedCacheInfo.seedHash,
      seedHashShort: seedCacheInfo.seedHashShort,
      seedNamePrefix: seedCacheInfo.seedNamePrefix,
      sourceTableName: seedFixture.sourceTableName,
      hostTableName: seedFixture.hostTableName,
      schemaSignature: seedCacheInfo.schemaSignature,
      cacheHit: seedFixture.seedCacheHit,
      reusable: seedFixture.reusable,
    },
    sourceTableId: seedFixture.sourceTableId,
    sourceTableName: seedFixture.sourceTableName,
    hostTableId: seedFixture.hostTableId,
    hostTableName: seedFixture.hostTableName,
    recordCount: config.recordCount,
    batchSize: config.batchSize,
    sourceFields: seedFixture.sourceFields,
    hostFields: seedFixture.hostFields,
    sampleRecords: seedFixture.sampleRecords,
    verifiedSeedSamples: seedReadyMeasurement?.result.verifiedSamples,
    sourceLookupField: {
      fieldId: seedFixture.sourceLookupFieldId,
      name: seedFixture.sourceLookupFieldName,
      limit: config.lookup.limit,
    },
    duplicatedLookupField: {
      fieldId: duplicateFieldMeasurement?.result.field.id,
      name:
        duplicateFieldMeasurement?.result.field.name ?? config.duplicate.name,
      responseHeaders: duplicateFieldMeasurement?.result.responseHeaders,
      routing: duplicateFieldMeasurement?.result.routing,
    },
    fullScan: duplicatedLookupScanReadyMeasurement?.result
      ? {
          scannedRecords:
            duplicatedLookupScanReadyMeasurement.result.scannedRecords,
          pageSize: duplicatedLookupScanReadyMeasurement.result.pageSize,
          pageCount: duplicatedLookupScanReadyMeasurement.result.pageCount,
        }
      : undefined,
    verifiedSamples:
      duplicatedLookupScanReadyMeasurement?.result.verifiedSamples,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
          }
        : undefined,
  },
});

type FieldDuplicateSeedReadyResult = Awaited<
  ReturnType<typeof assertConditionalLookupSeedReady>
>;

type FieldDuplicatePrimary = {
  duplicateFieldMeasurement: Measurement<FieldDuplicatePrimaryResult>;
  duplicatedLookupScanReadyMeasurement: Measurement<
    Awaited<ReturnType<typeof waitForConditionalLookupFullScan>>
  >;
};

// field-duplicate rides the field-add lifecycle as the second member: its prepare
// builds the conditional-lookup source + host seed AND adds the source lookup
// field that will be duplicated (all seed-build phases), its measured op
// duplicates that field and waits for the copy to backfill, and its cleanup
// removes only the duplicated field — the source lookup field stays as part of
// the reusable seed. The driver owns the seedReady phase, the diagnostic
// wrapping, and the cleanup invocation.
const fieldDuplicateFieldAddSpec: FieldAddLifecycleSpec<
  ConditionalLookupFieldDuplicateCaseConfig,
  FieldDuplicateSeedFixture,
  FieldDuplicateSeedReadyResult,
  FieldDuplicatePrimary
> = {
  prepareFixture: async ({ perfCase, context }) => {
    const seedCacheInfo = await buildFieldDuplicateSeedCacheInfo(perfCase);
    return createSeedFixture(perfCase, context, seedCacheInfo);
  },
  assertSeedReady: ({ fixture, config }) =>
    assertConditionalLookupSeedReady(
      fixture.sourceTableId,
      fixture.hostTableId,
      fixture.sourceFields,
      fixture.hostFields,
      config,
      fixture.sampleRecords,
    ),
  runPrimary: async ({ perfCase, context, fixture, config }) => {
    const duplicateFieldMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      "duplicateField",
      () =>
        measureAsync("duplicateField", async () => {
          const response = await duplicateField(
            fixture.hostTableId,
            fixture.sourceLookupFieldId,
            {
              name: config.duplicate.name,
            },
          );
          const responseHeaders = pickResponseHeaders(response.headers);
          return {
            field: response.data,
            responseHeaders,
            routing: assertExpectedRouting(context, responseHeaders),
          };
        }),
    );
    const duplicatedLookupScanReadyMeasurement = await measureAsync(
      "duplicatedLookupScanReady",
      () =>
        waitForConditionalLookupFullScan(
          fixture.hostTableId,
          duplicateFieldMeasurement.result.field.id,
          config,
          fixture.hostFields,
        ),
    );
    return { duplicateFieldMeasurement, duplicatedLookupScanReadyMeasurement };
  },
  buildResult: ({ config, fixture, seedReadyMeasurement, primary, error }) => {
    if (!fixture) {
      throw new Error(
        "field-duplicate buildResult invoked without a fixture; the driver only calls it after prepare succeeds",
      );
    }
    return buildFieldDuplicateResult({
      config,
      seedFixture: fixture,
      seedReadyMeasurement,
      duplicateFieldMeasurement: primary?.duplicateFieldMeasurement,
      duplicatedLookupScanReadyMeasurement:
        primary?.duplicatedLookupScanReadyMeasurement,
      seedCacheInfo: fixture.seedCacheInfo,
      error,
    });
  },
  cleanup: async ({ baseId, fixture, config }) => {
    // CI execute jobs run on a disposable restored DB copy; cleanup that only
    // tidies the durable database is skipped there. A missing fixture means
    // prepare failed before any table existed (it self-cleans on the way out).
    if (isExecuteDbIsolated() || !fixture) {
      return;
    }
    if (fixture.reusable) {
      // Restore the reusable seed by removing ONLY the duplicated field
      // (config.duplicate.name). The source lookup field it was duplicated from
      // is part of the seed and must stay. Re-resolve by name — idempotent, and
      // a no-op when the duplicate failed before creating anything.
      try {
        const duplicatedField = (
          (await getFields(fixture.hostTableId)) as Array<{
            id: string;
            name: string;
          }>
        ).find((field) => field.name === config.duplicate.name);
        if (duplicatedField) {
          await deleteField(fixture.hostTableId, duplicatedField.id);
        }
      } catch (error) {
        console.warn(
          `Failed to cleanup duplicated lookup field on ${fixture.hostTableId}`,
          error,
        );
      }
      return;
    }
    for (const tableId of [fixture.hostTableId, fixture.sourceTableId]) {
      if (tableId) {
        try {
          await permanentDeleteTable(baseId, tableId);
        } catch (error) {
          console.warn(`Failed to cleanup perf table ${tableId}`, error);
        }
      }
    }
  },
};

const isScalarFieldDuplicateConfig = (
  config: FieldDuplicateCaseConfig,
): config is ScalarFieldDuplicateCaseConfig =>
  "mode" in config && config.mode === "scalar";

export const seedFieldDuplicateCase = (
  perfCase: PerfCaseFor<"field-duplicate">,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FieldDuplicateCaseConfig;
  return isScalarFieldDuplicateConfig(config)
    ? seedScalarFieldDuplicateCase(perfCase, context)
    : seedFieldAddLifecycle(perfCase, context, fieldDuplicateFieldAddSpec);
};

export const runFieldDuplicateCase = (
  perfCase: PerfCaseFor<"field-duplicate">,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FieldDuplicateCaseConfig;
  return isScalarFieldDuplicateConfig(config)
    ? runScalarFieldDuplicateCase(perfCase, context)
    : runFieldAddLifecycle(perfCase, context, fieldDuplicateFieldAddSpec);
};
