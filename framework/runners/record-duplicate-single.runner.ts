import { duplicateRecord } from "@teable/openapi";
import { getPrimaryThresholdMs } from "../env";
import {
  measureAsync,
  roundMetric,
  summarizeDurations,
  type Measurement,
} from "../metrics";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordDuplicateSingleCaseConfig,
} from "../types";
import {
  assertDuplicatedRecordsMatchSource,
  assertDuplicateResponseMatchesSource,
  assertDuplicateSourceReady,
  assertRecordCount,
  getSourceRecords,
  type DuplicateRecordFixture,
} from "./record-duplicate.shared";
import {
  runRecordDuplicateLifecycle,
  seedRecordDuplicateLifecycle,
  type RecordDuplicateSpec,
} from "./record-duplicate-lifecycle";

type SingleDuplicateSample = {
  iteration: number;
  sourceRowOffset: number;
  sourceRowNumber: number;
  sourceRecordId: string;
  duplicatedRecordId: string;
  durationMs: number;
  status: number;
  routing?: EngineRouting;
  actual?: Record<string, unknown>;
  expected?: Record<string, unknown>;
};

type SingleDuplicatePrimaryResult = {
  duplicateSingleP95Ms: number;
  duplicateSingleTotalMs: number;
  duplicateSingleMaxMs: number;
  createdRecordIds: string[];
  samples: SingleDuplicateSample[];
  routing: {
    first: EngineRouting;
    last: EngineRouting;
    checkedRequests: number;
  };
};

type SingleDuplicateVerification = {
  createdDuplicates: Awaited<
    ReturnType<typeof assertDuplicatedRecordsMatchSource>
  >;
  finalCount: Awaited<ReturnType<typeof assertRecordCount>>;
};

const RECORD_DUPLICATE_SINGLE_FIXTURE_VERSION = "record-duplicate-single-v1";

const assertDuplicateRouting = (
  context: PerfRunContext,
  headers: Record<string, string>,
  operation: string,
) => {
  const routing = assertEngineRouting(context, headers, {
    feature: "duplicateRecord",
    operation,
  });
  if (!routing.routeMatched) {
    throw new Error(`${operation} route mismatch: ${JSON.stringify(routing)}`);
  }
  return routing;
};

const duplicateSingleRecords = async (
  fixture: DuplicateRecordFixture,
  config: RecordDuplicateSingleCaseConfig,
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<SingleDuplicatePrimaryResult> => {
  const sourceRecords = await getSourceRecords(
    fixture,
    config.duplicate.sourceRowCount,
  );
  const samples: SingleDuplicateSample[] = [];
  const createdRecordIds: string[] = [];
  const durations: number[] = [];
  let firstRouting: EngineRouting | undefined;
  let lastRouting: EngineRouting | undefined;

  for (const [index, source] of sourceRecords.entries()) {
    const iteration = index + 1;
    const measurement = await withPerfTraceStep(
      context,
      perfCase,
      `${config.threshold.metric}-${iteration}`,
      () =>
        measureAsync(`duplicateSingle:${iteration}`, () =>
          duplicateRecord(fixture.tableId, source.recordId),
        ),
    );
    const headers = pickRoutingResponseHeaders(
      measurement.result.headers as Record<string, unknown>,
    );
    const routing = assertDuplicateRouting(
      context,
      headers,
      "duplicateRecordSingle",
    );
    const record = measurement.result.data;
    const compared = assertDuplicateResponseMatchesSource({
      fixture,
      config,
      record,
      sourceRowNumber: source.rowNumber,
      context: "Single duplicate response",
    });

    expect(measurement.result.status).toBe(201);
    createdRecordIds.push(record.id);
    durations.push(measurement.durationMs);
    if (iteration === 1) {
      firstRouting = routing;
    }
    if (iteration === sourceRecords.length) {
      lastRouting = routing;
    }

    samples.push({
      iteration,
      sourceRowOffset: source.rowOffset,
      sourceRowNumber: source.rowNumber,
      sourceRecordId: source.recordId,
      duplicatedRecordId: record.id,
      durationMs: measurement.durationMs,
      status: measurement.result.status,
      routing:
        iteration === 1 || iteration === sourceRecords.length
          ? routing
          : undefined,
      ...(config.verify.sampleRows.includes(source.rowOffset) ? compared : {}),
    });
  }

  const summary = summarizeDurations(durations);
  const duplicateSingleTotalMs = roundMetric(
    durations.reduce((total, duration) => total + duration, 0),
  );

  if (!firstRouting || !lastRouting) {
    throw new Error("Missing duplicateRecord routing evidence");
  }

  return {
    duplicateSingleP95Ms: summary.p95Ms,
    duplicateSingleTotalMs,
    duplicateSingleMaxMs: summary.maxMs,
    createdRecordIds,
    samples,
    routing: {
      first: firstRouting,
      last: lastRouting,
      checkedRequests: createdRecordIds.length,
    },
  };
};

const verifySingleDuplicates = async (
  fixture: DuplicateRecordFixture,
  config: RecordDuplicateSingleCaseConfig,
  createdRecordIds: string[],
): Promise<SingleDuplicateVerification> => {
  const createdDuplicates = await assertDuplicatedRecordsMatchSource({
    fixture,
    config,
    duplicatedRecordIds: createdRecordIds,
    sourceStartRowOffset: 0,
    sampleDuplicateOffsets: config.verify.sampleRows.filter(
      (rowOffset) => rowOffset < createdRecordIds.length,
    ),
  });
  const finalCount = await assertRecordCount(
    fixture,
    config.rowCount + config.duplicate.sourceRowCount,
    config.verify.fullScanPageSize ?? 1_000,
  );

  return {
    createdDuplicates,
    finalCount,
  };
};

const buildRecordDuplicateSingleResult = ({
  config,
  fixture,
  prepareMeasurement,
  sourceReadyMeasurement,
  primaryMeasurement,
  verifyMeasurement,
  error,
}: {
  config: RecordDuplicateSingleCaseConfig;
  fixture?: DuplicateRecordFixture;
  prepareMeasurement?: Measurement<DuplicateRecordFixture>;
  sourceReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertDuplicateSourceReady>>
  >;
  primaryMeasurement?: Measurement<SingleDuplicatePrimaryResult>;
  verifyMeasurement?: Measurement<SingleDuplicateVerification>;
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
      ? {
          [config.threshold.metric]:
            primaryMeasurement.result.duplicateSingleP95Ms,
          duplicateSingleTotalMs:
            primaryMeasurement.result.duplicateSingleTotalMs,
          duplicateSingleMaxMs: primaryMeasurement.result.duplicateSingleMaxMs,
        }
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
    operation: "duplicate-record-single",
    tableId: fixture?.tableId,
    tableName: fixture?.tableName,
    viewId: fixture?.viewId,
    sourceRowCount: config.rowCount,
    duplicateRequestCount: config.duplicate.sourceRowCount,
    expectedFinalRowCount: config.rowCount + config.duplicate.sourceRowCount,
    request: fixture
      ? {
          method: "POST",
          path: `/api/table/${fixture.tableId}/record/{recordId}/duplicate`,
          requests: config.duplicate.sourceRowCount,
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
          createdRecordIds: primaryMeasurement.result.createdRecordIds,
          requestCount: primaryMeasurement.result.createdRecordIds.length,
          samples: primaryMeasurement.result.samples,
        }
      : undefined,
    routing: primaryMeasurement?.result.routing,
    verification: verifyMeasurement?.result
      ? {
          createdDuplicates: {
            scannedRecords:
              verifyMeasurement.result.createdDuplicates.scannedRecords,
            checkedRecords:
              verifyMeasurement.result.createdDuplicates.checkedRecords,
            pageSize: verifyMeasurement.result.createdDuplicates.pageSize,
            pageCount: verifyMeasurement.result.createdDuplicates.pageCount,
          },
          finalCount: verifyMeasurement.result.finalCount,
        }
      : undefined,
    verifiedSamples:
      verifyMeasurement?.result.createdDuplicates.verifiedSamples,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
          }
        : undefined,
  },
});

const recordDuplicateSingleSpec: RecordDuplicateSpec<
  RecordDuplicateSingleCaseConfig,
  SingleDuplicatePrimaryResult,
  SingleDuplicateVerification
> = {
  runner: "record-duplicate-single",
  fixtureVersion: RECORD_DUPLICATE_SINGLE_FIXTURE_VERSION,
  seedLabel: "single duplicate",
  // No top-level trace wrap: duplicateSingleRecords opens one trace step per
  // sequential duplicate request, so the primary phase is just the loop timer.
  runPrimary: ({ fixture, config, perfCase, context }) =>
    measureAsync("duplicateSingleLoop", () =>
      duplicateSingleRecords(fixture, config, perfCase, context),
    ),
  verify: ({ fixture, config, primaryResult }) =>
    verifySingleDuplicates(fixture, config, primaryResult.createdRecordIds),
  getCreatedRecordIds: (primaryResult) => primaryResult?.createdRecordIds ?? [],
  buildResult: buildRecordDuplicateSingleResult,
};

export const runRecordDuplicateSingleCase = async (
  perfCase: PerfCaseFor<"record-duplicate-single">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordDuplicateLifecycle(perfCase, context, recordDuplicateSingleSpec);

export const seedRecordDuplicateSingleCase = async (
  perfCase: PerfCaseFor<"record-duplicate-single">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordDuplicateLifecycle(perfCase, context, recordDuplicateSingleSpec);
