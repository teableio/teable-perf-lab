import { axios, X_CANARY_HEADER } from "@teable/openapi";
import type {
  IDuplicateSelectionStreamDoneEvent,
  IDuplicateSelectionStreamErrorEvent,
  IDuplicateSelectionStreamEvent,
  IDuplicateSelectionStreamProgressEvent,
} from "@teable/openapi";
import { permanentDeleteTable } from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync } from "../metrics";
import { assertEngineRouting } from "../routing";
import { perfStreamSse } from "../sse";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  SelectionDuplicateCaseConfig,
} from "../types";
import { PerfRunDiagnosticError } from "../types";
import {
  assertDuplicatedRecordsMatchSource,
  assertDuplicateSourceReady,
  assertRecordCount,
  deleteRecordsInBatches,
  type DuplicateRecordFixture,
  type Measurement,
  prepareDuplicateSourceFixture,
} from "./record-duplicate.shared";

type SelectionDuplicateStreamResult = {
  totalCount: number;
  duplicatedCount: number;
  duplicatedRecordIds: string[];
  progressEventCount: number;
  status: number;
  routing: ReturnType<typeof assertEngineRouting> & {
    canaryHeader: string;
  };
  trace: {
    traceparent?: string;
    traceLink?: string;
  };
};

type SelectionDuplicateVerification = {
  duplicatedValues: Awaited<
    ReturnType<typeof assertDuplicatedRecordsMatchSource>
  >;
  finalCount: Awaited<ReturnType<typeof assertRecordCount>>;
};

const SELECTION_DUPLICATE_FIXTURE_VERSION = "selection-duplicate-v1";

const getStreamHeaders = (context: PerfRunContext) => ({
  ...(context.cookie ? { Cookie: context.cookie } : {}),
  [X_CANARY_HEADER]: context.engine === "v2" ? "true" : "false",
});

const buildDuplicateRange = (
  fixture: DuplicateRecordFixture,
  config: SelectionDuplicateCaseConfig,
) => {
  const start = config.duplicate.startRowOffset;
  const end = start + config.duplicate.rowCount - 1;
  return {
    viewId: fixture.viewId,
    type: "rows",
    ranges: [[start, end]],
    projection: fixture.projection,
  };
};

const buildDuplicateStreamUrl = (
  fixture: DuplicateRecordFixture,
  config: SelectionDuplicateCaseConfig,
) => {
  const range = buildDuplicateRange(fixture, config);
  return axios.getUri({
    baseURL: axios.defaults.baseURL || "/api",
    url: `/table/${fixture.tableId}/selection/duplicate-stream`,
    params: {
      viewId: range.viewId,
      type: range.type,
      ranges: JSON.stringify(range.ranges),
      projection: range.projection,
    },
  });
};

const duplicateSelectionRange = async (
  fixture: DuplicateRecordFixture,
  config: SelectionDuplicateCaseConfig,
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<SelectionDuplicateStreamResult> => {
  const sseResult = await perfStreamSse<IDuplicateSelectionStreamEvent>({
    context,
    perfCase,
    stepId: config.threshold.metric,
    url: buildDuplicateStreamUrl(fixture, config),
    method: "GET",
    headers: getStreamHeaders(context),
    errorPrefix: "Duplicate selection stream failed",
  });
  const progressEvents = sseResult.events.filter(
    (event): event is IDuplicateSelectionStreamProgressEvent =>
      event.id === "progress",
  );
  const errors = sseResult.events.filter(
    (event): event is IDuplicateSelectionStreamErrorEvent =>
      event.id === "error",
  );
  const done = sseResult.events.find(
    (event): event is IDuplicateSelectionStreamDoneEvent => event.id === "done",
  );

  if (!done) {
    throw new Error(
      errors.at(-1)?.message ??
        "Duplicate selection stream ended without result",
    );
  }

  expect(errors).toHaveLength(0);
  expect(done.totalCount).toBe(config.duplicate.rowCount);
  expect(done.duplicatedCount).toBe(config.duplicate.rowCount);
  expect(done.data.duplicatedCount).toBe(config.duplicate.rowCount);
  expect(done.data.duplicatedRecordIds).toHaveLength(config.duplicate.rowCount);

  const routing = assertEngineRouting(context, sseResult.headers, {
    feature: "duplicateRecord",
    operation: "duplicateSelection",
  });
  if (!routing.routeMatched) {
    throw new Error(
      `duplicateSelection route mismatch: ${JSON.stringify(routing)}`,
    );
  }

  return {
    totalCount: done.totalCount,
    duplicatedCount: done.duplicatedCount,
    duplicatedRecordIds: done.data.duplicatedRecordIds,
    progressEventCount: progressEvents.length,
    status: sseResult.status,
    routing: {
      canaryHeader: context.engine === "v2" ? "true" : "false",
      ...routing,
    },
    trace: sseResult.trace,
  };
};

const verifySelectionDuplicate = async (
  fixture: DuplicateRecordFixture,
  config: SelectionDuplicateCaseConfig,
  duplicatedRecordIds: string[],
): Promise<SelectionDuplicateVerification> => {
  const duplicatedValues = await assertDuplicatedRecordsMatchSource({
    fixture,
    config,
    duplicatedRecordIds,
    sourceStartRowOffset: config.duplicate.startRowOffset,
    sampleDuplicateOffsets: config.verify.sampleRows.filter(
      (rowOffset) => rowOffset < duplicatedRecordIds.length,
    ),
  });
  const finalCount = await assertRecordCount(
    fixture,
    config.rowCount + config.duplicate.rowCount,
    config.verify.fullScanPageSize ?? 1_000,
  );

  return {
    duplicatedValues,
    finalCount,
  };
};

const cleanupDuplicatedRows = async (
  baseId: string,
  fixture: DuplicateRecordFixture,
  config: SelectionDuplicateCaseConfig,
  duplicatedRecordIds: string[],
) => {
  if (duplicatedRecordIds.length > 0) {
    await deleteRecordsInBatches(fixture.tableId, duplicatedRecordIds);
  }
  return assertRecordCount(
    fixture,
    config.rowCount,
    config.verify.fullScanPageSize ?? 1_000,
  );
};

const buildSelectionDuplicateResult = ({
  config,
  fixture,
  prepareMeasurement,
  sourceReadyMeasurement,
  duplicateMeasurement,
  verifyMeasurement,
  error,
}: {
  config: SelectionDuplicateCaseConfig;
  fixture?: DuplicateRecordFixture;
  prepareMeasurement?: Measurement<DuplicateRecordFixture>;
  sourceReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertDuplicateSourceReady>>
  >;
  duplicateMeasurement?: Measurement<SelectionDuplicateStreamResult>;
  verifyMeasurement?: Measurement<SelectionDuplicateVerification>;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    ...(prepareMeasurement ? { prepareMs: prepareMeasurement.durationMs } : {}),
    ...(fixture?.seedCacheInfo
      ? {
          seedCacheHit: fixture.seedCacheHit ? 1 : 0,
          seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
          ...(fixture.seedCacheHit
            ? { seedRestoreMs: prepareMeasurement?.durationMs ?? 0 }
            : fixture.seedCacheInfo.enabled
              ? { seedBuildMs: prepareMeasurement?.durationMs ?? 0 }
              : {}),
          ...(sourceReadyMeasurement
            ? { seedReadyMs: sourceReadyMeasurement.durationMs }
            : {}),
        }
      : {}),
    ...(duplicateMeasurement
      ? { [config.threshold.metric]: duplicateMeasurement.durationMs }
      : {}),
    ...(verifyMeasurement ? { verifyMs: verifyMeasurement.durationMs } : {}),
  },
  thresholds: duplicateMeasurement
    ? [
        {
          metric: config.threshold.metric,
          max: getPrimaryThresholdMs(config.threshold.maxMs),
          unit: "ms",
        },
      ]
    : [],
  phases: [
    ...(prepareMeasurement
      ? [
          {
            name: prepareMeasurement.name,
            durationMs: prepareMeasurement.durationMs,
          },
        ]
      : []),
    ...(sourceReadyMeasurement
      ? [
          {
            name: sourceReadyMeasurement.name,
            durationMs: sourceReadyMeasurement.durationMs,
          },
        ]
      : []),
    ...(duplicateMeasurement
      ? [
          {
            name: duplicateMeasurement.name,
            durationMs: duplicateMeasurement.durationMs,
          },
        ]
      : []),
    ...(verifyMeasurement
      ? [
          {
            name: verifyMeasurement.name,
            durationMs: verifyMeasurement.durationMs,
          },
        ]
      : []),
  ],
  details: {
    feature: "duplicateRecord",
    operation: "duplicate-selection-stream",
    tableId: fixture?.tableId,
    tableName: fixture?.tableName,
    viewId: fixture?.viewId,
    sourceRowCount: config.rowCount,
    duplicateRowCount: config.duplicate.rowCount,
    expectedFinalRowCount: config.rowCount + config.duplicate.rowCount,
    request: fixture
      ? {
          method: "GET",
          path: `/api/table/${fixture.tableId}/selection/duplicate-stream`,
          ...buildDuplicateRange(fixture, config),
          projectionSize: fixture.projection.length,
        }
      : undefined,
    fields: fixture?.fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
    })),
    seed: fixture
      ? {
          sourceRecords: config.rowCount,
          batchSize: config.batchSize,
          batchCount: fixture.seedBatchDurations.length,
          maxSeedBatchMs: fixture.seedBatchDurations.length
            ? Math.max(...fixture.seedBatchDurations)
            : undefined,
          ready: sourceReadyMeasurement?.result,
          cache: fixture.seedCacheInfo
            ? {
                enabled: fixture.seedCacheInfo.enabled,
                cacheHit: Boolean(fixture.seedCacheHit),
                reusable: Boolean(fixture.reusableSeed),
                seedHash: fixture.seedCacheInfo.seedHash,
                seedHashShort: fixture.seedCacheInfo.seedHashShort,
                seedTableName: fixture.seedCacheInfo.seedTableName,
                schemaSignature: fixture.seedCacheInfo.schemaSignature,
              }
            : undefined,
        }
      : undefined,
    duplicate: duplicateMeasurement?.result
      ? {
          totalCount: duplicateMeasurement.result.totalCount,
          duplicatedCount: duplicateMeasurement.result.duplicatedCount,
          duplicatedRecordIds: duplicateMeasurement.result.duplicatedRecordIds,
          progressEventCount: duplicateMeasurement.result.progressEventCount,
          status: duplicateMeasurement.result.status,
          trace: duplicateMeasurement.result.trace,
        }
      : undefined,
    routing: duplicateMeasurement?.result.routing,
    verification: verifyMeasurement?.result
      ? {
          duplicatedIds: {
            scannedRecords:
              verifyMeasurement.result.duplicatedValues.scannedRecords,
            checkedRecords:
              verifyMeasurement.result.duplicatedValues.checkedRecords,
            pageSize: verifyMeasurement.result.duplicatedValues.pageSize,
            pageCount: verifyMeasurement.result.duplicatedValues.pageCount,
          },
          finalCount: verifyMeasurement.result.finalCount,
        }
      : undefined,
    verifiedSamples: verifyMeasurement?.result.duplicatedValues.verifiedSamples,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
          }
        : undefined,
  },
});

export const runSelectionDuplicateCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as SelectionDuplicateCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  let prepareMeasurement: Measurement<DuplicateRecordFixture> | undefined;
  let sourceReadyMeasurement:
    | Measurement<Awaited<ReturnType<typeof assertDuplicateSourceReady>>>
    | undefined;
  let duplicateMeasurement:
    | Measurement<SelectionDuplicateStreamResult>
    | undefined;
  let verifyMeasurement:
    | Measurement<SelectionDuplicateVerification>
    | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareDuplicateSourceFixture({
        baseId,
        tableName,
        config,
        perfCase,
        runner: "selection-duplicate",
        fixtureVersion: SELECTION_DUPLICATE_FIXTURE_VERSION,
      }),
    );
    sourceReadyMeasurement = await measureAsync("seedReady", () =>
      assertDuplicateSourceReady(prepareMeasurement!.result, config),
    );

    try {
      duplicateMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        config.threshold.metric,
        () =>
          measureAsync(config.threshold.metric, () =>
            duplicateSelectionRange(
              prepareMeasurement!.result,
              config,
              perfCase,
              context,
            ),
          ),
      );

      verifyMeasurement = await measureAsync("verify", () =>
        verifySelectionDuplicate(
          prepareMeasurement!.result,
          config,
          duplicateMeasurement!.result.duplicatedRecordIds,
        ),
      );
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildSelectionDuplicateResult({
          config,
          fixture: prepareMeasurement.result,
          prepareMeasurement,
          sourceReadyMeasurement,
          duplicateMeasurement,
          verifyMeasurement,
          error,
        }),
      );
    }

    return buildSelectionDuplicateResult({
      config,
      fixture: prepareMeasurement.result,
      prepareMeasurement,
      sourceReadyMeasurement,
      duplicateMeasurement,
      verifyMeasurement,
    });
  } finally {
    const fixture = prepareMeasurement?.result;
    if (fixture && !isExecuteDbIsolated() && fixture.reusableSeed) {
      let restored = false;
      try {
        await cleanupDuplicatedRows(
          baseId,
          fixture,
          config,
          duplicateMeasurement?.result.duplicatedRecordIds ?? [],
        );
        restored = true;
      } catch (error) {
        console.warn(
          `Failed to restore cached selection duplicate seed ${fixture.tableId}; deleting it`,
          error,
        );
      }

      if (!restored) {
        try {
          await permanentDeleteTable(baseId, fixture.tableId);
        } catch (error) {
          console.warn(
            `Failed to cleanup perf table ${fixture.tableId}`,
            error,
          );
        }
      }
    } else if (fixture && !isExecuteDbIsolated()) {
      try {
        await permanentDeleteTable(baseId, fixture.tableId);
      } catch (error) {
        console.warn(`Failed to cleanup perf table ${fixture.tableId}`, error);
      }
    }
  }
};

export const seedSelectionDuplicateCase = async (
  perfCase: PerfCase,
  _context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as SelectionDuplicateCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const prepareMeasurement = await measureAsync("prepare", () =>
    prepareDuplicateSourceFixture({
      baseId,
      tableName,
      config,
      perfCase,
      runner: "selection-duplicate",
      fixtureVersion: SELECTION_DUPLICATE_FIXTURE_VERSION,
    }),
  );
  const sourceReadyMeasurement = await measureAsync("seedReady", () =>
    assertDuplicateSourceReady(prepareMeasurement.result, config),
  );

  return buildSelectionDuplicateResult({
    config,
    fixture: prepareMeasurement.result,
    prepareMeasurement,
    sourceReadyMeasurement,
  });
};
