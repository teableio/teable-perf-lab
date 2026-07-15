import { FieldKeyType, FieldType, type IFieldRo } from "@teable/core";
import { createField as apiCreateField } from "@teable/openapi";
import {
  getFields,
  getRecords,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, roundMetric, type Measurement } from "../metrics";
import { pollUntilReady } from "../readiness";
import { forEachRecordPage } from "../record-page-scan";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  ConditionalRollupCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  assertConditionalLookupSeedReady,
  cleanupConditionalComputedFields,
  getExpectedValue,
  getSourceRowNumberForHostRow,
  parseConditionalSeedRowNumber,
  prepareConditionalComputedSeedFixture,
  type ConditionalLookupSeedFixture,
} from "./conditional-lookup.runner";
import {
  runFieldAddLifecycle,
  seedFieldAddLifecycle,
  type FieldAddLifecycleSpec,
} from "./field-add-lifecycle";

type ConditionalRollupFieldCreation = {
  field: { id: string };
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
};

type ConditionalRollupFullScan = {
  scannedRecords: number;
  pageSize: number;
  pageCount: number;
  verifiedSamples: Array<{
    rowOffset: number;
    rowNumber: number;
    sourceRowNumber: number;
    recordId: string;
    actual: unknown;
    expected: string;
  }>;
};

type ConditionalRollupPrimary = {
  createRollupFieldMeasurement: Measurement<ConditionalRollupFieldCreation>;
  fullRollupScanReadyMeasurement: Measurement<ConditionalRollupFullScan>;
};

type ConditionalRollupSeedReadyResult = Awaited<
  ReturnType<typeof assertConditionalLookupSeedReady>
>;

const createEmptyMeasurement = <T>(
  name: string,
  result: T,
): Measurement<T> => ({
  name,
  durationMs: 0,
  result,
});

const buildConditionalRollupFieldInput = (
  fixture: ConditionalLookupSeedFixture,
  config: ConditionalRollupCaseConfig,
): IFieldRo => ({
  name: config.rollup.name,
  type: FieldType.ConditionalRollup,
  options: {
    foreignTableId: fixture.sourceTableId,
    lookupFieldId: fixture.sourceFields.valueFieldId,
    expression: config.rollup.expression,
    filter: {
      conjunction: "and",
      filterSet: [
        {
          fieldId: fixture.sourceFields.keyFieldId,
          operator: "is",
          value: {
            type: "field",
            fieldId: fixture.hostFields.lookupKeyFieldId,
          },
        },
      ],
    },
    limit: config.rollup.limit,
  },
});

const createConditionalRollupField = async (
  context: PerfRunContext,
  fixture: ConditionalLookupSeedFixture,
  config: ConditionalRollupCaseConfig,
): Promise<ConditionalRollupFieldCreation> => {
  const response = await apiCreateField(
    fixture.hostTableId,
    buildConditionalRollupFieldInput(fixture, config),
  );
  expect(response.status).toBe(201);
  const responseHeaders = pickRoutingResponseHeaders(
    response.headers as Record<string, unknown>,
  );
  const routing = assertEngineRouting(context, responseHeaders, {
    feature: "createField",
    operation: "Conditional rollup field create",
  });
  return {
    field: response.data as { id: string },
    responseHeaders,
    routing,
  };
};

const assertConditionalRollupFullScan = async (
  fixture: ConditionalLookupSeedFixture,
  rollupFieldId: string,
  config: ConditionalRollupCaseConfig,
): Promise<ConditionalRollupFullScan> => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleRowOffsets = new Set(config.verify.sampleRows);
  const verifiedSamples: ConditionalRollupFullScan["verifiedSamples"] = [];
  const seenRowNumbers = new Set<number>();

  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.recordCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(fixture.hostTableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: [
            fixture.hostFields.keyFieldId,
            fixture.hostFields.lookupKeyFieldId,
            rollupFieldId,
          ],
          skip,
          take,
        }),
    },
    (record) => {
      const hostRowNumber = parseConditionalSeedRowNumber(
        record.fields[fixture.hostFields.keyFieldId],
        config.generator.hostKeyPrefix,
      );
      if (seenRowNumbers.has(hostRowNumber)) {
        throw new Error(
          `Duplicate host row number in conditional rollup full scan: ${hostRowNumber}`,
        );
      }
      seenRowNumbers.add(hostRowNumber);

      const sourceRowNumber = getSourceRowNumberForHostRow(
        hostRowNumber,
        config,
      );
      const expected = getExpectedValue(sourceRowNumber, config);
      const actual = record.fields[rollupFieldId];
      if (actual !== expected) {
        throw new Error(
          `Conditional rollup full scan mismatch at host row ${hostRowNumber}: expected ${JSON.stringify(
            expected,
          )}, actual ${JSON.stringify(actual)}`,
        );
      }

      const rowOffset = hostRowNumber - 1;
      if (sampleRowOffsets.has(rowOffset)) {
        verifiedSamples.push({
          rowOffset,
          rowNumber: hostRowNumber,
          sourceRowNumber,
          recordId: record.id,
          actual,
          expected,
        });
      }
    },
  );

  if (
    scannedRecords !== config.recordCount ||
    seenRowNumbers.size !== config.recordCount
  ) {
    throw new Error(
      `Conditional rollup full scan count mismatch: expected ${config.recordCount}, scanned=${scannedRecords}, unique=${seenRowNumbers.size}`,
    );
  }

  return {
    scannedRecords,
    pageSize,
    pageCount,
    verifiedSamples: verifiedSamples.sort(
      (left, right) => left.rowOffset - right.rowOffset,
    ),
  };
};

const waitForConditionalRollupFullScan = (
  fixture: ConditionalLookupSeedFixture,
  rollupFieldId: string,
  config: ConditionalRollupCaseConfig,
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 60_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 500,
      description: "full conditional rollup scan",
    },
    () => assertConditionalRollupFullScan(fixture, rollupFieldId, config),
  );

const buildConditionalRollupCaseResult = ({
  config,
  fixture,
  seedReadyMeasurement,
  primary,
  error,
}: {
  config: ConditionalRollupCaseConfig;
  fixture?: ConditionalLookupSeedFixture;
  seedReadyMeasurement?: Measurement<ConditionalRollupSeedReadyResult>;
  primary?: ConditionalRollupPrimary;
  error?: unknown;
}): PerfRunResult => {
  const createTablesMeasurement =
    fixture?.createTablesMeasurement ??
    createEmptyMeasurement("seedBuildSkipped", undefined);
  const seedSourceMeasurement =
    fixture?.seedSourceMeasurement ??
    createEmptyMeasurement("seedSourceBuildSkipped", undefined);
  const seedHostMeasurement =
    fixture?.seedHostMeasurement ??
    createEmptyMeasurement("seedHostBuildSkipped", undefined);
  const createRollupFieldMeasurement = primary?.createRollupFieldMeasurement;
  const fullRollupScanReadyMeasurement =
    primary?.fullRollupScanReadyMeasurement;
  const rollupFieldId = createRollupFieldMeasurement?.result.field.id;

  return {
    metrics: {
      ...(fixture?.seedCacheInfo
        ? {
            seedCacheHit: fixture.seedCacheHit ? 1 : 0,
            seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
            ...(fixture.seedCacheHit
              ? { seedRestoreMs: createTablesMeasurement.durationMs }
              : fixture.seedCacheInfo.enabled
                ? {
                    seedBuildMs: roundMetric(
                      createTablesMeasurement.durationMs +
                        seedSourceMeasurement.durationMs +
                        seedHostMeasurement.durationMs,
                    ),
                  }
                : {}),
          }
        : {}),
      createTablesMs: createTablesMeasurement.durationMs,
      seedSourceRecordsMs: seedSourceMeasurement.durationMs,
      seedHostRecordsMs: seedHostMeasurement.durationMs,
      ...(seedReadyMeasurement
        ? { seedReadyMs: seedReadyMeasurement.durationMs }
        : {}),
      ...(createRollupFieldMeasurement
        ? { createRollupFieldMs: createRollupFieldMeasurement.durationMs }
        : {}),
      ...(fullRollupScanReadyMeasurement
        ? {
            fullRollupScanReadyMs: fullRollupScanReadyMeasurement.durationMs,
            conditionalRollupReadyMs: roundMetric(
              (createRollupFieldMeasurement?.durationMs ?? 0) +
                fullRollupScanReadyMeasurement.durationMs,
            ),
          }
        : {}),
      maxSeedBatchMs: roundMetric(
        Math.max(
          ...(fixture?.sourceBatchDurations ?? [0]),
          ...(fixture?.hostBatchDurations ?? [0]),
        ),
      ),
    },
    thresholds: fullRollupScanReadyMeasurement
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
        name: createTablesMeasurement.name,
        durationMs: createTablesMeasurement.durationMs,
      },
      {
        name: seedSourceMeasurement.name,
        durationMs: seedSourceMeasurement.durationMs,
      },
      {
        name: seedHostMeasurement.name,
        durationMs: seedHostMeasurement.durationMs,
      },
      ...(seedReadyMeasurement
        ? [
            {
              name: seedReadyMeasurement.name,
              durationMs: seedReadyMeasurement.durationMs,
            },
          ]
        : []),
      ...(createRollupFieldMeasurement
        ? [
            {
              name: createRollupFieldMeasurement.name,
              durationMs: createRollupFieldMeasurement.durationMs,
            },
          ]
        : []),
      ...(fullRollupScanReadyMeasurement
        ? [
            {
              name: fullRollupScanReadyMeasurement.name,
              durationMs: fullRollupScanReadyMeasurement.durationMs,
            },
          ]
        : []),
    ],
    details: {
      seed: fixture?.seedCacheInfo
        ? {
            enabled: fixture.seedCacheInfo.enabled,
            seedHash: fixture.seedCacheInfo.seedHash,
            seedHashShort: fixture.seedCacheInfo.seedHashShort,
            seedNamePrefix: fixture.seedCacheInfo.seedNamePrefix,
            sourceTableName: fixture.sourceTableName,
            hostTableName: fixture.hostTableName,
            schemaSignature: fixture.seedCacheInfo.schemaSignature,
            cacheHit: fixture.seedCacheHit,
            reusable: fixture.reusable,
          }
        : undefined,
      sourceTableId: fixture?.sourceTableId,
      sourceTableName: fixture?.sourceTableName,
      hostTableId: fixture?.hostTableId,
      hostTableName: fixture?.hostTableName,
      recordCount: config.recordCount,
      batchSize: config.batchSize,
      sourceFields: fixture?.sourceFields,
      hostFields: fixture?.hostFields,
      sampleRecords: fixture?.sampleRecords,
      verifiedSeedSamples: seedReadyMeasurement?.result.verifiedSamples,
      rollup: {
        fieldId: rollupFieldId,
        name: config.rollup.name,
        expression: config.rollup.expression,
        limit: config.rollup.limit,
        responseHeaders: createRollupFieldMeasurement?.result.responseHeaders,
        routing: createRollupFieldMeasurement?.result.routing,
      },
      fullScan: fullRollupScanReadyMeasurement?.result
        ? {
            scannedRecords:
              fullRollupScanReadyMeasurement.result.scannedRecords,
            pageSize: fullRollupScanReadyMeasurement.result.pageSize,
            pageCount: fullRollupScanReadyMeasurement.result.pageCount,
          }
        : undefined,
      verifiedSamples: fullRollupScanReadyMeasurement?.result.verifiedSamples,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
            }
          : undefined,
    },
  };
};

const conditionalRollupFieldAddSpec: FieldAddLifecycleSpec<
  ConditionalRollupCaseConfig,
  ConditionalLookupSeedFixture,
  ConditionalRollupSeedReadyResult,
  ConditionalRollupPrimary
> = {
  prepareFixture: prepareConditionalComputedSeedFixture,
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
    const createRollupFieldMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      "createRollupField",
      () =>
        measureAsync("createRollupField", () =>
          createConditionalRollupField(context, fixture, config),
        ),
    );
    const fullRollupScanReadyMeasurement = await measureAsync(
      "fullRollupScanReady",
      () =>
        waitForConditionalRollupFullScan(
          fixture,
          createRollupFieldMeasurement.result.field.id,
          config,
        ),
    );
    return {
      createRollupFieldMeasurement,
      fullRollupScanReadyMeasurement,
    };
  },
  buildResult: buildConditionalRollupCaseResult,
  cleanup: async ({ baseId, fixture }) => {
    if (isExecuteDbIsolated() || !fixture) {
      return;
    }
    if (fixture.reusable) {
      try {
        await cleanupConditionalComputedFields(
          fixture.hostTableId,
          await getFields(fixture.hostTableId),
        );
      } catch (error) {
        console.warn(
          `Failed to cleanup perf conditional rollup field on ${fixture.hostTableId}`,
          error,
        );
      }
      return;
    }
    for (const tableId of [fixture.hostTableId, fixture.sourceTableId]) {
      try {
        await permanentDeleteTable(baseId, tableId);
      } catch (error) {
        console.warn(`Failed to cleanup perf table ${tableId}`, error);
      }
    }
  },
};

export const seedConditionalRollupCase = (
  perfCase: PerfCaseFor<"conditional-rollup">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedFieldAddLifecycle(perfCase, context, conditionalRollupFieldAddSpec);

export const runConditionalRollupCase = (
  perfCase: PerfCaseFor<"conditional-rollup">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runFieldAddLifecycle(perfCase, context, conditionalRollupFieldAddSpec);
