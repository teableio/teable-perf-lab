import {
  axios,
  RangeType,
  restoreTrash,
  X_CANARY_HEADER,
} from "@teable/openapi";
import type {
  IDeleteSelectionStreamDoneEvent,
  IDeleteSelectionStreamErrorEvent,
  IDeleteSelectionStreamEvent,
  IDeleteSelectionStreamProgressEvent,
} from "@teable/openapi";
import { permanentDeleteTable } from "../../../utils/init-app";
import { isExecuteDbIsolated } from "../env";
import { measureAsync, type Measurement } from "../metrics";
import { pollUntilReady } from "../readiness";
import { assertEngineRouting } from "../routing";
import { perfStreamSse } from "../sse";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordDeleteStreamCaseConfig,
  RecordUndoRedoBaseCaseConfig,
} from "../types";
import { PerfRunDiagnosticError } from "../types";
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
  waitForRowsRestored,
  type RecordReplayFixture,
  type RecordReplayVerification,
} from "./record-replay.shared";
import { cleanupDeletedRecordSeed } from "./record-trash-cleanup";
import { findRecordTrashItems } from "./record-trash.shared";

export type DeleteStreamResult = {
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

// record-restore measures the inverse operation against the same flat fixture.
// Canonicalize the seed case id + runner here so both runners resolve the same
// seed hash for identical row/field/generator configs.
export const prepareRecordTrashFixture = ({
  baseId,
  tableName,
  config,
  perfCase,
}: {
  baseId: string;
  tableName: string;
  config: RecordUndoRedoBaseCaseConfig;
  perfCase: PerfCase;
}) =>
  prepareRecordReplayFixture(baseId, tableName, config, {
    perfCase: {
      ...perfCase,
      id: `record-trash/shared-${config.rowCount}-${config.fields.length}f`,
    } as PerfCase,
    runner: "record-delete-stream",
    seedIdentity: {
      family: "record-trash",
      rowCount: config.rowCount,
      fieldCount: config.fields.length,
    },
    seedCodeFiles: [new URL(import.meta.url)],
  });

// The single measured operation bundles the trace-wrapped delete stream and the
// post-delete empty-table verification, mirroring selection-clear: the driver
// hands back one primary measurement whose duration is the metric, and
// buildResult splits the bundle back into the delete + verifyDeleted phases.
type DeleteStreamPrimaryResult = {
  delete?: DeleteStreamResult;
  verify?: Measurement<RecordReplayVerification>;
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
export const deleteAllRowsByEngineStream = async (
  fixture: RecordReplayFixture,
  stepId: string,
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
    stepId,
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
  const result: DeleteStreamPrimaryResult = {};
  let durationMs = 0;
  try {
    const deleteMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      config.threshold.metric,
      () =>
        measureAsync(config.threshold.metric, () =>
          deleteAllRowsByEngineStream(
            fixture,
            config.threshold.metric,
            perfCase,
            context,
            windowId,
          ),
        ),
    );
    result.delete = deleteMeasurement.result;
    durationMs = deleteMeasurement.durationMs;
    result.verify = await measureAsync("verifyDeleted", () =>
      assertDeleted(fixture),
    );
  } catch (error) {
    throw new PerfRunDiagnosticError(
      error instanceof Error ? error.message : String(error),
      {
        metrics: {},
        thresholds: [],
        details: {
          partialPrimaryMeasurement: {
            name: config.threshold.metric,
            durationMs,
            result,
          } satisfies Measurement<DeleteStreamPrimaryResult>,
        },
      },
    );
  }
  return {
    name: config.threshold.metric,
    durationMs,
    result,
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
    operationMeasurement: primaryMeasurement?.result.delete
      ? {
          name: primaryMeasurement.name,
          durationMs: primaryMeasurement.durationMs,
          result: primaryMeasurement.result.delete,
        }
      : undefined,
    verifyMeasurement: primaryMeasurement?.result.verify,
    error,
  });

const restoreDeletedStreamSeed = async ({
  fixture,
  config,
  primaryMeasurement,
}: {
  fixture: RecordReplayFixture;
  config: RecordDeleteStreamCaseConfig;
  primaryMeasurement?: Measurement<DeleteStreamPrimaryResult>;
}) => {
  const deletedRecordIds =
    primaryMeasurement?.result.delete?.deletedRecordIds ?? [];
  if (deletedRecordIds.length !== fixture.seededRecords.length) {
    throw new Error(
      `Delete-stream cleanup has ${deletedRecordIds.length}/${fixture.seededRecords.length} deleted record ids`,
    );
  }
  const trashLookups = await pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs,
      pollIntervalMs: config.verify.pollIntervalMs,
      description: `record trash cleanup for ${fixture.tableId}`,
    },
    () => findRecordTrashItems(fixture.tableId, deletedRecordIds),
  );
  for (const trashLookup of trashLookups) {
    const response = await restoreTrash(trashLookup.trashId, fixture.tableId);
    if (![200, 201].includes(response.status)) {
      throw new Error(
        `Record trash cleanup returned HTTP ${response.status} for ${trashLookup.trashId}`,
      );
    }
  }
  await waitForRowsRestored(fixture, config, {
    timeoutMs: config.verify.timeoutMs,
    pollIntervalMs: config.verify.pollIntervalMs,
    verifySamples: true,
  });
};

// Delete-stream is class C when its reusable fixture has affinity siblings:
// restore every deleted row and verify seed readiness before the next case in
// the same execute process. A standalone isolated execute DB can still skip
// cleanup because the whole copy is discarded. Restore failure deletes the
// dirty fixture and fails the case instead of making the next sibling rebuild
// it silently.
const cleanupDeleteStreamFixture = async ({
  baseId,
  fixture,
  config,
  primaryMeasurement,
}: {
  baseId: string;
  fixture: RecordReplayFixture | undefined;
  config: RecordDeleteStreamCaseConfig;
  primaryMeasurement?: Measurement<DeleteStreamPrimaryResult>;
}) => {
  if (!fixture?.tableId) return;
  await cleanupDeletedRecordSeed({
    reusableSeed: Boolean(fixture.reusableSeed),
    executeDbIsolated: isExecuteDbIsolated(),
    sharedSeedIdentity: Boolean(fixture.seedCacheInfo?.seedAffinity),
    canRestoreSeed: Boolean(primaryMeasurement?.result.delete),
    restoreSeed: () =>
      restoreDeletedStreamSeed({ fixture, config, primaryMeasurement }),
    deleteFixture: () => permanentDeleteTable(baseId, fixture.tableId),
  });
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
    prepareRecordTrashFixture({ baseId, tableName, config, perfCase }),
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
  perfCase: PerfCaseFor<"record-delete-stream">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, recordDeleteStreamSpec);

export const seedRecordDeleteStreamCase = async (
  perfCase: PerfCaseFor<"record-delete-stream">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(perfCase, context, recordDeleteStreamSpec);
