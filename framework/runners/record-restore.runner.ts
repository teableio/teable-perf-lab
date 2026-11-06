import { restoreTrash } from "@teable/openapi";
import { permanentDeleteTable } from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, type Measurement } from "../metrics";
import { pollUntilReady } from "../readiness";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfCaseFor,
  PerfRunContext,
  PerfRunResult,
  RecordRestoreCaseConfig,
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
  deleteAllRowsByEngine,
  waitForRowsRestored,
  type RecordReplayFixture,
  type RecordReplayVerification,
} from "./record-replay.shared";
import { prepareRecordTrashFixture } from "./record-delete-stream.runner";
import {
  findRecordTrashItems,
  type RecordTrashLookup,
} from "./record-trash.shared";

// The delete acknowledgement `deleteAllRowsByEngine` returns: a count plus the
// routing/trace evidence for this engine. V1 batches repeat it, so the batched
// setup reports the summed count with the first routing and last trace.
type DeleteRowsByEngineResult = {
  status: number;
  deletedCount: number;
  routing: {
    xTeableV2?: string;
    xTeableV2Reason?: string;
    xTeableV2Feature?: string;
  };
  trace: {
    traceparent?: string;
  };
};

type RestoreSetupResult = {
  delete: DeleteRowsByEngineResult;
  deletedState: RecordReplayVerification;
  trashLookups: RecordTrashLookup[];
};

type RestoreRequestResult = {
  trashItemCount: number;
  restoredRecordCount: number;
  batches: Array<{
    trashId: string;
    resourceCount: number;
    status: number;
    responseHeaders: ReturnType<typeof pickRoutingResponseHeaders>;
    routing: EngineRouting;
  }>;
};

type RestorePrimaryResult = {
  setupMeasurement?: Measurement<RestoreSetupResult>;
  restoreMeasurement?: Measurement<RestoreRequestResult>;
  verifyMeasurement?: Measurement<RecordReplayVerification>;
};

// V1's range endpoint passes every selected record id through attachment
// cleanup in one Prisma statement. Keep each setup request below PostgreSQL's
// 32,767 bind-variable ceiling; the restore metric still covers the complete
// ordered set of trash items created by these requests. V2 deletes the whole
// selection by id in one request and chunks internally.
const V1_DELETE_SETUP_BATCH_SIZE = 25_000;

// The delete response carries nothing the trash scan can use: the shared helper
// reports counts, and a seed-cache hit hydrates seededRecords with synthetic
// ids where only the row COUNT survives. `assertSeedReady` already pages every
// row of this view, so it writes the id each row really holds back into
// seededRecords; setup only reads them out before the delete, so the
// post-delete trash scan can match the item this setup produced. Setup-only
// work: it never runs inside the measured restore.
const deletedRecordIdsForTrash = (fixture: RecordReplayFixture): string[] => {
  const recordIds = fixture.seededRecords.map((record) => record.recordId);
  const missingRow = recordIds.indexOf("");
  if (missingRow !== -1) {
    throw new Error(
      `Seed-ready scan did not report a record id for row ${missingRow + 1} of table ${fixture.tableId}; the trash lookup needs the ids of the rows being deleted`,
    );
  }
  return recordIds;
};

const deleteRowsForRestoreSetup = async (
  fixture: RecordReplayFixture,
  context: Pick<PerfRunContext, "engine">,
): Promise<DeleteRowsByEngineResult> => {
  if (
    context.engine !== "v1" ||
    fixture.seededRecords.length <= V1_DELETE_SETUP_BATCH_SIZE
  ) {
    return deleteAllRowsByEngine(fixture, context);
  }

  const results: DeleteRowsByEngineResult[] = [];
  // V1 selects rows by range, so only the COUNT of seededRecords matters here.
  // After each batch is deleted, the next remaining rows shift back to
  // [0, batchSize), which keeps every request a leading first range.
  for (
    let remaining = fixture.seededRecords.length;
    remaining > 0;
    remaining -= V1_DELETE_SETUP_BATCH_SIZE
  ) {
    const batchSize = Math.min(V1_DELETE_SETUP_BATCH_SIZE, remaining);
    results.push(
      await deleteAllRowsByEngine(
        {
          ...fixture,
          seededRecords: fixture.seededRecords.slice(0, batchSize),
        },
        context,
      ),
    );
  }

  const first = results[0];
  const last = results.at(-1);
  if (!first || !last) {
    throw new Error("V1 restore setup did not execute a delete batch");
  }
  return {
    status: last.status,
    deletedCount: results.reduce(
      (total, result) => total + result.deletedCount,
      0,
    ),
    routing: first.routing,
    trace: last.trace,
  };
};

const setupRecordTrash = async (
  context: PerfRunContext,
  fixture: RecordReplayFixture,
  config: RecordRestoreCaseConfig,
): Promise<RestoreSetupResult> => {
  const deletedRecordIds = deletedRecordIdsForTrash(fixture);
  const deleteResult = await deleteRowsForRestoreSetup(fixture, context);
  const deletedState = await assertDeleted(fixture);
  const trashLookups = await pollUntilReady(
    {
      timeoutMs: 60_000,
      pollIntervalMs: 500,
      description: `record trash item for ${config.rowCount} rows in table ${fixture.tableId}`,
    },
    () => findRecordTrashItems(fixture.tableId, deletedRecordIds),
  );

  return {
    delete: deleteResult,
    deletedState,
    trashLookups,
  };
};

const restoreRecordTrash = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: RecordReplayFixture,
  config: RecordRestoreCaseConfig,
  trashLookups: RecordTrashLookup[],
): Promise<RestoreRequestResult> => {
  const batches = await withPerfTraceStep(
    context,
    perfCase,
    config.threshold.metric,
    async () => {
      const results: RestoreRequestResult["batches"] = [];
      for (const trashLookup of trashLookups) {
        const response = await restoreTrash(
          trashLookup.trashId,
          fixture.tableId,
        );
        expect([200, 201]).toContain(response.status);
        const responseHeaders = pickRoutingResponseHeaders(
          response.headers as Record<string, unknown>,
        );
        results.push({
          trashId: trashLookup.trashId,
          resourceCount: trashLookup.resourceCount,
          status: response.status,
          responseHeaders,
          routing: assertEngineRouting(context, responseHeaders, {
            feature: "createRecord",
            operation: "restoreRecordTrash",
          }),
        });
      }
      return results;
    },
  );
  return {
    trashItemCount: batches.length,
    restoredRecordCount: batches.reduce(
      (total, batch) => total + batch.resourceCount,
      0,
    ),
    batches,
  };
};

const partialPrimaryError = (
  error: unknown,
  config: RecordRestoreCaseConfig,
  result: RestorePrimaryResult,
): PerfRunDiagnosticError =>
  new PerfRunDiagnosticError(error, {
    metrics: {},
    thresholds: [],
    details: {
      partialPrimaryMeasurement: {
        name: config.threshold.metric,
        durationMs: result.restoreMeasurement?.durationMs ?? 0,
        result,
      } satisfies Measurement<RestorePrimaryResult>,
    },
  });

const runRestoreMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: RecordReplayFixture,
  config: RecordRestoreCaseConfig,
): Promise<Measurement<RestorePrimaryResult>> => {
  const result: RestorePrimaryResult = {};
  try {
    result.setupMeasurement = await measureAsync("deleteRecordSetup", () =>
      setupRecordTrash(context, fixture, config),
    );
    result.restoreMeasurement = await measureAsync(
      config.threshold.metric,
      () =>
        restoreRecordTrash(
          perfCase,
          context,
          fixture,
          config,
          result.setupMeasurement!.result.trashLookups,
        ),
    );
    result.verifyMeasurement = await measureAsync("verifyRestoredRecords", () =>
      waitForRowsRestored(fixture, config, {
        timeoutMs: config.verify.timeoutMs,
        pollIntervalMs: config.verify.pollIntervalMs,
        verifySamples: true,
      }),
    );
  } catch (error) {
    throw partialPrimaryError(error, config, result);
  }

  return {
    name: config.threshold.metric,
    durationMs: result.restoreMeasurement.durationMs,
    result,
  };
};

const buildRecordRestoreResult = ({
  config,
  fixture,
  windowId,
  prepareMeasurement,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  config: RecordRestoreCaseConfig;
  fixture?: RecordReplayFixture;
  windowId?: string;
  prepareMeasurement?: Measurement<RecordReplayFixture>;
  seedReadyMeasurement?: Measurement<RecordReplayVerification>;
  primaryMeasurement?: Measurement<RestorePrimaryResult>;
  error?: unknown;
}): PerfRunResult => {
  const setupMeasurement = primaryMeasurement?.result.setupMeasurement;
  const restoreMeasurement = primaryMeasurement?.result.restoreMeasurement;
  const verifyMeasurement = primaryMeasurement?.result.verifyMeasurement;
  return {
    metrics: {
      ...(prepareMeasurement
        ? { prepareMs: prepareMeasurement.durationMs }
        : {}),
      ...(fixture?.seedCacheInfo
        ? {
            seedCacheHit: fixture.seedCacheHit ? 1 : 0,
            seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
            ...(fixture.seedCacheHit
              ? { seedRestoreMs: prepareMeasurement?.durationMs ?? 0 }
              : fixture.seedCacheInfo.enabled
                ? { seedBuildMs: prepareMeasurement?.durationMs ?? 0 }
                : {}),
          }
        : {}),
      ...(seedReadyMeasurement
        ? { seedReadyMs: seedReadyMeasurement.durationMs }
        : {}),
      ...(setupMeasurement
        ? { deleteRecordSetupMs: setupMeasurement.durationMs }
        : {}),
      ...(restoreMeasurement
        ? { [config.threshold.metric]: restoreMeasurement.durationMs }
        : {}),
      ...(verifyMeasurement
        ? { verifyRestoredRecordsMs: verifyMeasurement.durationMs }
        : {}),
    },
    thresholds: restoreMeasurement
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
      ...(seedReadyMeasurement
        ? [
            {
              name: seedReadyMeasurement.name,
              durationMs: seedReadyMeasurement.durationMs,
            },
          ]
        : []),
      ...(setupMeasurement
        ? [
            {
              name: setupMeasurement.name,
              durationMs: setupMeasurement.durationMs,
            },
          ]
        : []),
      ...(restoreMeasurement
        ? [
            {
              name: restoreMeasurement.name,
              durationMs: restoreMeasurement.durationMs,
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
      operation: "record-restore",
      windowId,
      tableId: fixture?.tableId,
      tableName: fixture?.tableName,
      viewId: fixture?.viewId,
      rowCount: config.rowCount,
      fieldCount: config.fields.length,
      deleteSetup: setupMeasurement?.result,
      restore: restoreMeasurement?.result,
      verification: verifyMeasurement?.result,
      seed: fixture
        ? {
            seededRecords: fixture.seededRecords.length,
            ready: seedReadyMeasurement?.result,
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
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : undefined,
    },
  };
};

const cleanupRecordRestoreFixture = async ({
  baseId,
  fixture,
  primaryMeasurement,
}: {
  baseId: string;
  fixture: RecordReplayFixture | undefined;
  primaryMeasurement?: Measurement<RestorePrimaryResult>;
}) => {
  if (!fixture?.tableId) return;
  const sharedSeedIdentity = Boolean(fixture.seedCacheInfo?.seedAffinity);
  if (isExecuteDbIsolated() && !sharedSeedIdentity) return;

  const verified = primaryMeasurement?.result.verifyMeasurement?.result;
  if (
    fixture.reusableSeed &&
    verified?.scannedRecords === fixture.seededRecords.length
  ) {
    return;
  }

  await permanentDeleteTable(baseId, fixture.tableId);
};

const recordRestoreSpec: RecordMutationLifecycleSpec<
  RecordRestoreCaseConfig,
  RecordReplayFixture,
  RecordReplayVerification,
  RestorePrimaryResult
> = {
  prepareFixture: ({ baseId, tableName, config, perfCase }) =>
    prepareRecordTrashFixture({ baseId, tableName, config, perfCase }),
  assertSeedReady: ({ fixture, config }) =>
    assertRowsRestored(fixture, config, {
      verifySamples: true,
      onRecordId: (recordId, rowNumber) => {
        // seededRecords is ordered by rowNumber in both shapes (freshly seeded
        // and the synthetic seed-cache one), so the scan's 1-based row number
        // is the array position.
        const seeded = fixture.seededRecords[rowNumber - 1];
        if (seeded) {
          seeded.recordId = recordId;
        }
      },
    }),
  runMeasuredOperation: ({ perfCase, context, fixture, config }) =>
    runRestoreMeasuredOperation(perfCase, context, fixture, config),
  buildResult: buildRecordRestoreResult,
  cleanup: cleanupRecordRestoreFixture,
};

export const runRecordRestoreCase = (
  perfCase: PerfCaseFor<"record-restore">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, recordRestoreSpec);

export const seedRecordRestoreCase = (
  perfCase: PerfCaseFor<"record-restore">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(perfCase, context, recordRestoreSpec);
