import { axios, X_CANARY_HEADER } from "@teable/openapi";
import type {
  IDuplicateSelectionStreamDoneEvent,
  IDuplicateSelectionStreamErrorEvent,
  IDuplicateSelectionStreamEvent,
  IDuplicateSelectionStreamProgressEvent,
} from "@teable/openapi";
import { getPrimaryThresholdMs } from "../env";
import { measureAsync, type Measurement } from "../metrics";
import { assertEngineRouting } from "../routing";
import { perfStreamSse } from "../sse";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  SelectionDuplicateCaseConfig,
} from "../types";
import {
  assertDuplicatedRecordsMatchSource,
  assertDuplicateSourceReady,
  assertRecordCount,
  type DuplicateRecordFixture,
} from "./record-duplicate.shared";
import {
  runRecordDuplicateLifecycle,
  seedRecordDuplicateLifecycle,
  type RecordDuplicateSpec,
} from "./record-duplicate-lifecycle";

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

const buildSelectionDuplicateResult = ({
  config,
  fixture,
  prepareMeasurement,
  sourceReadyMeasurement,
  primaryMeasurement,
  verifyMeasurement,
  error,
}: {
  config: SelectionDuplicateCaseConfig;
  fixture?: DuplicateRecordFixture;
  prepareMeasurement?: Measurement<DuplicateRecordFixture>;
  sourceReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertDuplicateSourceReady>>
  >;
  primaryMeasurement?: Measurement<SelectionDuplicateStreamResult>;
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
    ...(primaryMeasurement
      ? { [config.threshold.metric]: primaryMeasurement.durationMs }
      : {}),
    ...(verifyMeasurement ? { verifyMs: verifyMeasurement.durationMs } : {}),
  },
  thresholds: primaryMeasurement
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
    ...(primaryMeasurement
      ? [
          {
            name: primaryMeasurement.name,
            durationMs: primaryMeasurement.durationMs,
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
    duplicate: primaryMeasurement?.result
      ? {
          totalCount: primaryMeasurement.result.totalCount,
          duplicatedCount: primaryMeasurement.result.duplicatedCount,
          duplicatedRecordIds: primaryMeasurement.result.duplicatedRecordIds,
          progressEventCount: primaryMeasurement.result.progressEventCount,
          status: primaryMeasurement.result.status,
          trace: primaryMeasurement.result.trace,
        }
      : undefined,
    routing: primaryMeasurement?.result.routing,
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

const selectionDuplicateSpec: RecordDuplicateSpec<
  SelectionDuplicateCaseConfig,
  SelectionDuplicateStreamResult,
  SelectionDuplicateVerification
> = {
  runner: "selection-duplicate",
  fixtureVersion: SELECTION_DUPLICATE_FIXTURE_VERSION,
  seedLabel: "selection duplicate",
  // One top-level trace step wraps the whole duplicate-selection stream.
  runPrimary: ({ fixture, config, perfCase, context }) =>
    withPerfTraceStep(context, perfCase, config.threshold.metric, () =>
      measureAsync(config.threshold.metric, () =>
        duplicateSelectionRange(fixture, config, perfCase, context),
      ),
    ),
  verify: ({ fixture, config, primaryResult }) =>
    verifySelectionDuplicate(
      fixture,
      config,
      primaryResult.duplicatedRecordIds,
    ),
  getCreatedRecordIds: (primaryResult) =>
    primaryResult?.duplicatedRecordIds ?? [],
  buildResult: buildSelectionDuplicateResult,
};

export const runSelectionDuplicateCase = async (
  perfCase: PerfCaseFor<"selection-duplicate">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordDuplicateLifecycle(perfCase, context, selectionDuplicateSpec);

export const seedSelectionDuplicateCase = async (
  perfCase: PerfCaseFor<"selection-duplicate">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordDuplicateLifecycle(perfCase, context, selectionDuplicateSpec);
