import { duplicateField } from "@teable/openapi";
import {
  deleteField,
  getFields,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs } from "../env";
import { measureAsync, roundMetric } from "../metrics";
import {
  buildSeedCacheInfo,
  buildSeedTableName,
  type SeedCacheInfo,
} from "../seed-cache";
import { withPerfTraceStep } from "../trace-collector";
import type {
  FieldDuplicateCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import { PerfRunDiagnosticError } from "../types";
import {
  assertConditionalLookupSeedReady,
  buildConditionalLookupSeedFixture,
  createConditionalLookupField,
  waitForConditionalLookupFullScan,
  type ConditionalLookupSeedFixture,
} from "./conditional-lookup.runner";

type Measurement<T> = {
  name: string;
  durationMs: number;
  result: T;
};

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
  routing: {
    requestedEngine: string;
    expectedXTeableV2: string;
    actualXTeableV2: string;
    routeMatched: boolean;
    xTeableV2Feature: string;
    xTeableV2Reason: string;
  };
};

const getResponseHeader = (headers: Record<string, unknown>, name: string) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0]) : String(value ?? "");
};

const pickResponseHeaders = (headers: Record<string, unknown>) => ({
  "x-teable-v2": getResponseHeader(headers, "x-teable-v2"),
  "x-teable-v2-feature": getResponseHeader(headers, "x-teable-v2-feature"),
  "x-teable-v2-reason": getResponseHeader(headers, "x-teable-v2-reason"),
  traceparent: getResponseHeader(headers, "traceparent"),
});

const assertExpectedRouting = (
  context: PerfRunContext,
  responseHeaders: Record<string, string>,
) => {
  const expectedXTeableV2 = context.engine === "v2" ? "true" : "false";
  const actualXTeableV2 = responseHeaders["x-teable-v2"];
  if (actualXTeableV2 !== expectedXTeableV2) {
    throw new Error(
      `Field duplicate did not use expected ${context.engine.toUpperCase()} route; expected x-teable-v2=${expectedXTeableV2}, got ${actualXTeableV2}; headers=${JSON.stringify(
        responseHeaders,
      )}`,
    );
  }

  return {
    requestedEngine: context.engine,
    expectedXTeableV2,
    actualXTeableV2,
    routeMatched: true,
    xTeableV2Feature: responseHeaders["x-teable-v2-feature"],
    xTeableV2Reason: responseHeaders["x-teable-v2-reason"],
  };
};

const getConditionalLookupSeedConfig = (config: FieldDuplicateCaseConfig) => ({
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
  const config = perfCase.config as FieldDuplicateCaseConfig;
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
  const config = perfCase.config as FieldDuplicateCaseConfig;
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
  config: FieldDuplicateCaseConfig;
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

export const seedFieldDuplicateCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FieldDuplicateCaseConfig;
  const seedCacheInfo = await buildFieldDuplicateSeedCacheInfo(perfCase);
  const seedFixture = await createSeedFixture(perfCase, context, seedCacheInfo);
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    assertConditionalLookupSeedReady(
      seedFixture.sourceTableId,
      seedFixture.hostTableId,
      seedFixture.sourceFields,
      seedFixture.hostFields,
      config,
      seedFixture.sampleRecords,
    ),
  );

  return buildFieldDuplicateResult({
    config,
    seedFixture,
    seedReadyMeasurement,
    seedCacheInfo,
  });
};

export const runFieldDuplicateCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FieldDuplicateCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const seedCacheInfo = await buildFieldDuplicateSeedCacheInfo(perfCase);
  let seedFixture: FieldDuplicateSeedFixture | undefined;
  let duplicatedFieldId = "";

  try {
    seedFixture = await createSeedFixture(perfCase, context, seedCacheInfo);

    let seedReadyMeasurement:
      | Measurement<
          Awaited<ReturnType<typeof assertConditionalLookupSeedReady>>
        >
      | undefined;
    let duplicateFieldMeasurement:
      | Measurement<FieldDuplicatePrimaryResult>
      | undefined;

    try {
      seedReadyMeasurement = await measureAsync("seedReady", () =>
        assertConditionalLookupSeedReady(
          seedFixture.sourceTableId,
          seedFixture.hostTableId,
          seedFixture.sourceFields,
          seedFixture.hostFields,
          config,
          seedFixture.sampleRecords,
        ),
      );

      duplicateFieldMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        "duplicateField",
        () =>
          measureAsync("duplicateField", async () => {
            const response = await duplicateField(
              seedFixture.hostTableId,
              seedFixture.sourceLookupFieldId,
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
      duplicatedFieldId = duplicateFieldMeasurement.result.field.id;

      const duplicatedLookupScanReadyMeasurement = await measureAsync(
        "duplicatedLookupScanReady",
        () =>
          waitForConditionalLookupFullScan(
            seedFixture.hostTableId,
            duplicatedFieldId,
            config,
            seedFixture.hostFields,
          ),
      );

      return buildFieldDuplicateResult({
        config,
        seedFixture,
        seedReadyMeasurement,
        duplicateFieldMeasurement,
        duplicatedLookupScanReadyMeasurement,
        seedCacheInfo,
      });
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildFieldDuplicateResult({
          config,
          seedFixture,
          seedReadyMeasurement,
          duplicateFieldMeasurement,
          seedCacheInfo,
          error,
        }),
      );
    }
  } finally {
    if (seedFixture?.reusable) {
      if (duplicatedFieldId) {
        try {
          await deleteField(seedFixture.hostTableId, duplicatedFieldId);
        } catch (error) {
          console.warn(
            `Failed to cleanup duplicated lookup field ${duplicatedFieldId}`,
            error,
          );
        }
      }
    } else if (seedFixture) {
      for (const tableId of [
        seedFixture.hostTableId,
        seedFixture.sourceTableId,
      ]) {
        if (tableId) {
          try {
            await permanentDeleteTable(baseId, tableId);
          } catch (error) {
            console.warn(`Failed to cleanup perf table ${tableId}`, error);
          }
        }
      }
    }
  }
};
