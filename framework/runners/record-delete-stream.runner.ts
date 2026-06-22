import { axios, RangeType, X_CANARY_HEADER } from "@teable/openapi";
import type {
  IDeleteSelectionStreamDoneEvent,
  IDeleteSelectionStreamErrorEvent,
  IDeleteSelectionStreamEvent,
  IDeleteSelectionStreamProgressEvent,
} from "@teable/openapi";
import { permanentDeleteTable } from "../../../utils/init-app";
import { isExecuteDbIsolated } from "../env";
import { measureAsync, type Measurement } from "../metrics";
import { assertEngineRouting } from "../routing";
import { perfStreamSse } from "../sse";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordDeleteStreamCaseConfig,
} from "../types";
import {
  runRecordMutationLifecycle,
  seedRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";
import {
  assertDeleted,
  assertRowsRestored,
  buildRecordReplayResult,
  prepareRecordReplayFixture,
  type RecordReplayFixture,
  type RecordReplayVerification,
} from "./record-replay.shared";

type DeleteStreamResult = {
  totalCount: number;
  deletedCount: number;
  deletedRecordIds: string[];
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

// The single measured operation bundles the trace-wrapped delete stream and the
// post-delete empty-table verification, mirroring selection-clear: the driver
// hands back one primary measurement whose duration is the metric, and
// buildResult splits the bundle back into the delete + verifyDeleted phases.
type DeleteStreamPrimaryResult = {
  delete: DeleteStreamResult;
  verify: Measurement<RecordReplayVerification>;
};

const getStreamHeaders = (context: PerfRunContext, windowId: string) => ({
  ...(context.cookie ? { Cookie: context.cookie } : {}),
  // Sent so the request matches real grid behavior (the grid populates the undo
  // stack via this header); this case never replays it.
  "X-Window-Id": windowId,
  [X_CANARY_HEADER]: context.engine === "v2" ? "true" : "false",
});

// V1 range leg: GET /selection/delete-stream with the rows-range query params
// (mirrors the openapi deleteSelectionStream client's buildAllRowsRange shape).
// A rows-type range over [0, lastRow] selects every seeded row. seededRecords on
// a cache hit are synthetic (only the COUNT is restored), but `.length` equals
// the configured row count, so the range bound is reliable without real ids.
const buildDeleteStreamUrl = (fixture: RecordReplayFixture) =>
  axios.getUri({
    baseURL: axios.defaults.baseURL || "/api",
    url: `/table/${fixture.tableId}/selection/delete-stream`,
    params: {
      viewId: fixture.viewId,
      type: RangeType.Rows,
      ranges: JSON.stringify([[0, fixture.seededRecords.length - 1]]),
      projection: fixture.projection,
    },
  });

// V2 by-id leg: PATCH /selection/delete-by-id-stream with selectionIdsRoSchema.
// Use allRecords:true (NOT explicit recordIds) so the selection survives a
// seed-cache hit that hydrates seededRecords with synthetic empty ids — the
// server resolves the query-scoped ids itself. Delete is row-scoped, so no
// fieldIds are needed.
const buildDeleteByIdBody = (fixture: RecordReplayFixture) =>
  JSON.stringify({
    viewId: fixture.viewId,
    selection: { allRecords: true },
  });

// Same user behavior ("delete the whole selection"), engine-specific endpoint:
// V1's grid streams the range delete (GET /selection/delete-stream), V2's grid
// streams the by-id delete (PATCH /selection/delete-by-id-stream). Both emit
// IDeleteSelectionStreamEvent, so the done-event assertions and the routing
// check below are identical for both engines.
const deleteAllRowsByEngineStream = async (
  fixture: RecordReplayFixture,
  config: RecordDeleteStreamCaseConfig,
  perfCase: PerfCase,
  context: PerfRunContext,
  windowId: string,
): Promise<DeleteStreamResult> => {
  const isV2 = context.engine === "v2";
  const expectedDeletedCount = fixture.seededRecords.length;
  const url = isV2
    ? axios.getUri({
        baseURL: axios.defaults.baseURL || "/api",
        url: `/table/${fixture.tableId}/selection/delete-by-id-stream`,
      })
    : buildDeleteStreamUrl(fixture);

  const sseResult = await perfStreamSse<IDeleteSelectionStreamEvent>({
    context,
    perfCase,
    stepId: config.threshold.metric,
    url,
    method: isV2 ? "PATCH" : "GET",
    headers: {
      ...(isV2 ? { "Content-Type": "application/json" } : {}),
      ...getStreamHeaders(context, windowId),
    },
    body: isV2 ? buildDeleteByIdBody(fixture) : undefined,
    errorPrefix: "Delete selection stream failed",
  });

  const progressEvents = sseResult.events.filter(
    (event): event is IDeleteSelectionStreamProgressEvent =>
      event.id === "progress",
  );
  const errors = sseResult.events.filter(
    (event): event is IDeleteSelectionStreamErrorEvent => event.id === "error",
  );
  const done = sseResult.events.find(
    (event): event is IDeleteSelectionStreamDoneEvent => event.id === "done",
  );

  if (!done) {
    throw new Error(
      errors.at(-1)?.message ?? "Delete selection stream ended without result",
    );
  }

  expect(errors).toHaveLength(0);
  expect(done.totalCount).toBe(expectedDeletedCount);
  expect(done.deletedCount).toBe(expectedDeletedCount);
  expect(done.data.deletedCount).toBe(expectedDeletedCount);
  expect(done.data.deletedRecordIds).toHaveLength(expectedDeletedCount);

  const routing = assertEngineRouting(context, sseResult.headers, {
    feature: "deleteRecord",
    operation: "deleteSelectionStream",
  });
  if (!routing.routeMatched) {
    throw new Error(
      `deleteSelectionStream route mismatch: ${JSON.stringify(routing)}`,
    );
  }

  return {
    totalCount: done.totalCount,
    deletedCount: done.deletedCount,
    deletedRecordIds: done.data.deletedRecordIds,
    progressEventCount: progressEvents.length,
    status: sseResult.status,
    routing: {
      canaryHeader: context.engine === "v2" ? "true" : "false",
      ...routing,
    },
    trace: sseResult.trace,
  };
};

const runDeleteStreamMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: RecordDeleteStreamCaseConfig,
  fixture: RecordReplayFixture,
  windowId: string,
): Promise<Measurement<DeleteStreamPrimaryResult>> => {
  const deleteMeasurement = await withPerfTraceStep(
    context,
    perfCase,
    config.threshold.metric,
    () =>
      measureAsync(config.threshold.metric, () =>
        deleteAllRowsByEngineStream(
          fixture,
          config,
          perfCase,
          context,
          windowId,
        ),
      ),
  );
  const verifyMeasurement = await measureAsync("verifyDeleted", () =>
    assertDeleted(fixture),
  );
  return {
    name: deleteMeasurement.name,
    durationMs: deleteMeasurement.durationMs,
    result: {
      delete: deleteMeasurement.result,
      verify: verifyMeasurement,
    },
  };
};

// Adapter: the driver hands back one primary measurement; split it back into the
// delete + verifyDeleted measurements so buildRecordReplayResult — and therefore
// the artifact shape — matches the sync record-delete sibling exactly.
const buildDeleteStreamResult = ({
  config,
  fixture,
  windowId,
  prepareMeasurement,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  config: RecordDeleteStreamCaseConfig;
  fixture?: RecordReplayFixture;
  windowId?: string;
  prepareMeasurement?: Measurement<RecordReplayFixture>;
  seedReadyMeasurement?: Measurement<RecordReplayVerification>;
  primaryMeasurement?: Measurement<DeleteStreamPrimaryResult>;
  error?: unknown;
}): PerfRunResult =>
  buildRecordReplayResult({
    config,
    operation: "delete",
    windowId,
    fixture,
    prepareMeasurement,
    seedReadyMeasurement,
    operationMeasurement: primaryMeasurement
      ? {
          name: primaryMeasurement.name,
          durationMs: primaryMeasurement.durationMs,
          result: primaryMeasurement.result.delete,
        }
      : undefined,
    verifyMeasurement: primaryMeasurement?.result.verify,
    error,
  });

// Cleanup class D: delete-all is the measured workload, so the post-op state
// (empty table) is not a reusable seed — drop the execute table and let the next
// run rebuild. CI execute jobs run on an isolated restored DB, so cleanup is
// skipped there and the mutated copy is simply discarded.
const cleanupDeleteStreamFixture = async ({
  baseId,
  fixture,
}: {
  baseId: string;
  fixture: RecordReplayFixture | undefined;
}) => {
  if (isExecuteDbIsolated() || !fixture?.tableId) {
    return;
  }
  try {
    await permanentDeleteTable(baseId, fixture.tableId);
  } catch (error) {
    console.warn(`Failed to cleanup perf table ${fixture.tableId}`, error);
  }
};

// record-delete-stream rides the record-mutation lifecycle: seed a mixed table
// (cache-aware, reusing the record-replay seed so it stays a true sibling of the
// sync record-delete case), assert seed readiness, run one measured streaming
// delete, verify the table is empty, drop the table. The seed shares the
// record-replay fixture but hashes this runner file, so it gets its own seed
// table distinct from the sync record-delete seed.
const recordDeleteStreamSpec: RecordMutationLifecycleSpec<
  RecordDeleteStreamCaseConfig,
  RecordReplayFixture,
  RecordReplayVerification,
  DeleteStreamPrimaryResult
> = {
  prepareFixture: ({ baseId, tableName, config, perfCase }) =>
    prepareRecordReplayFixture(baseId, tableName, config, {
      perfCase,
      runner: "record-delete-stream",
      seedCodeFiles: [new URL(import.meta.url)],
    }),
  assertSeedReady: ({ fixture, config }) => assertRowsRestored(fixture, config),
  runMeasuredOperation: ({ perfCase, context, config, fixture, windowId }) =>
    runDeleteStreamMeasuredOperation(
      perfCase,
      context,
      config,
      fixture,
      windowId,
    ),
  buildResult: buildDeleteStreamResult,
  cleanup: cleanupDeleteStreamFixture,
};

export const runRecordDeleteStreamCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, recordDeleteStreamSpec);

export const seedRecordDeleteStreamCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(perfCase, context, recordDeleteStreamSpec);
