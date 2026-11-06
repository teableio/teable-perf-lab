import { restoreTrash } from "@teable/openapi";
import { permanentDeleteTable } from "../../../utils/init-app";
import { isExecuteDbIsolated } from "../env";
import { measureAsync, type Measurement } from "../metrics";
import { pollUntilReady } from "../readiness";
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
import {
  cleanupDeletedRecordSeed,
  resolveRecordTrashCleanupPolling,
} from "./record-trash-cleanup";
import { findRecordTrashItems } from "./record-trash.shared";
import {
  deleteAllRowsDurably,
  DeleteOperationObservationError,
  DELETE_OPERATION_TIMING_PROFILE,
  type DurableDeleteResult,
} from "./record-delete-operation";

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

// Primary excludes fixture readiness and the independent empty-table scan.
type DeleteStreamPrimaryResult = {
  delete?: DurableDeleteResult;
  verify?: Measurement<RecordReplayVerification>;
  failureSnapshot?: DurableDeleteResult["snapshot"];
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
    const deleteMeasurement = await measureAsync(config.threshold.metric, () =>
      deleteAllRowsDurably({
        tableId: fixture.tableId,
        viewId: fixture.viewId,
        expectedCount: fixture.seededRecords.length,
        stepId: config.threshold.metric,
        perfCase,
        context,
        windowId,
        timeoutMs: perfCase.timeoutMs ?? 120_000,
      }),
    );
    result.delete = deleteMeasurement.result;
    durationMs = deleteMeasurement.durationMs;
    result.verify = await measureAsync("verifyDeleted", () =>
      assertDeleted(fixture),
    );
  } catch (error) {
    result.failureSnapshot =
      error instanceof DeleteOperationObservationError
        ? error.snapshot
        : undefined;
    throw new PerfRunDiagnosticError(error, {
      metrics: {},
      thresholds: [],
      details: {
        timingProfile: DELETE_OPERATION_TIMING_PROFILE,
        snapshot:
          error instanceof DeleteOperationObservationError
            ? error.snapshot
            : undefined,
        partialPrimaryMeasurement: {
          name: config.threshold.metric,
          durationMs,
          result,
        } satisfies Measurement<DeleteStreamPrimaryResult>,
      },
    });
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
}): PerfRunResult => {
  const result = buildRecordReplayResult({
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
  return {
    ...result,
    details: {
      ...result.details,
      timingProfile: DELETE_OPERATION_TIMING_PROFILE,
      timing:
        "Before POST create through terminal status and settled effects; empty-table verification excluded",
      failureSnapshot: primaryMeasurement?.result.failureSnapshot,
      deleteOperation: primaryMeasurement?.result.delete,
    },
  };
};

const restoreDeletedStreamSeed = async ({
  fixture,
  config,
}: {
  fixture: RecordReplayFixture;
  config: RecordDeleteStreamCaseConfig;
}) => {
  const deletedRecordIds = fixture.seededRecords.map(
    (record) => record.recordId,
  );
  if (deletedRecordIds.some((recordId) => !recordId)) {
    throw new Error(
      "Delete cleanup requires pre-mutation seed record identities",
    );
  }
  const cleanupPolling = resolveRecordTrashCleanupPolling(config.verify);
  const trashLookups = await pollUntilReady(
    {
      ...cleanupPolling,
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
    ...cleanupPolling,
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
    restoreSeed: () => restoreDeletedStreamSeed({ fixture, config }),
    deleteFixture: () => permanentDeleteTable(baseId, fixture.tableId),
  });
};

// Case IDs and thresholds remain stable; the timing profile distinguishes this
// V2 durable lifecycle from historical stream measurements on pinned refs.
const recordDeleteStreamSpec: RecordMutationLifecycleSpec<
  RecordDeleteStreamCaseConfig,
  RecordReplayFixture,
  RecordReplayVerification,
  DeleteStreamPrimaryResult
> = {
  prepareFixture: ({ baseId, tableName, config, perfCase }) =>
    prepareRecordTrashFixture({ baseId, tableName, config, perfCase }),
  assertSeedReady: ({ fixture, config }) =>
    assertRowsRestored(fixture, config, {
      // Cache fixtures start with synthetic IDs. Capture real identities in the
      // existing readiness scan, before timing, solely for shared-seed cleanup.
      onRecordId: (recordId, rowNumber) => {
        fixture.seededRecords[rowNumber - 1].recordId = recordId;
      },
    }),
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
): Promise<PerfRunResult> => {
  if (context.engine !== "v2") {
    return {
      result: "skipped",
      metrics: {},
      thresholds: [],
      details: {
        skipped: true,
        requestedEngine: context.engine,
        timingProfile: DELETE_OPERATION_TIMING_PROFILE,
        skippedReason:
          "V2-only durable delete lifecycle. Legacy V1 stream baseline must run with pinned legacy perf-lab/teable-ee refs; this run contains no V1 performance measurement.",
      },
    };
  }
  return runRecordMutationLifecycle(perfCase, context, recordDeleteStreamSpec);
};

export const seedRecordDeleteStreamCase = async (
  perfCase: PerfCaseFor<"record-delete-stream">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(perfCase, context, recordDeleteStreamSpec);
