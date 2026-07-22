import {
  getTrashItems,
  restoreTrash,
  TableTrashType,
  TrashType,
} from "@teable/openapi";
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
  waitForRowsRestored,
  type RecordReplayFixture,
  type RecordReplayVerification,
} from "./record-replay.shared";
import {
  deleteAllRowsByEngineStream,
  prepareRecordTrashFixture,
  type DeleteStreamResult,
} from "./record-delete-stream.runner";

type RecordTrashLookup = {
  trashId: string;
  resourceCount: number;
  deletedTime?: string;
  scannedPages: number;
};

type RestoreSetupResult = {
  delete: Omit<DeleteStreamResult, "deletedRecordIds">;
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
// ordered set of trash items created by these requests. V2 already chunks its
// by-id stream internally.
const V1_DELETE_SETUP_BATCH_SIZE = 25_000;

const deleteRowsForRestoreSetup = async (
  fixture: RecordReplayFixture,
  perfCase: PerfCase,
  context: PerfRunContext,
  windowId: string,
): Promise<DeleteStreamResult> => {
  if (
    context.engine !== "v1" ||
    fixture.seededRecords.length <= V1_DELETE_SETUP_BATCH_SIZE
  ) {
    return deleteAllRowsByEngineStream(
      fixture,
      "deleteRecordSetup",
      perfCase,
      context,
      windowId,
    );
  }

  const results: DeleteStreamResult[] = [];
  let remaining = fixture.seededRecords.length;
  while (remaining > 0) {
    const batchSize = Math.min(V1_DELETE_SETUP_BATCH_SIZE, remaining);
    results.push(
      await deleteAllRowsByEngineStream(
        {
          ...fixture,
          // V1 selects rows by their current view positions. After each batch
          // is deleted, the next remaining rows shift back to [0, batchSize).
          seededRecords: fixture.seededRecords.slice(0, batchSize),
        },
        "deleteRecordSetup",
        perfCase,
        context,
        windowId,
      ),
    );
    remaining -= batchSize;
  }

  const first = results[0];
  const last = results.at(-1);
  if (!first || !last) {
    throw new Error("V1 restore setup did not execute a delete batch");
  }
  return {
    totalCount: results.reduce((total, result) => total + result.totalCount, 0),
    deletedCount: results.reduce(
      (total, result) => total + result.deletedCount,
      0,
    ),
    deletedRecordIds: results.flatMap((result) => result.deletedRecordIds),
    progressEventCount: results.reduce(
      (total, result) => total + result.progressEventCount,
      0,
    ),
    status: last.status,
    routing: first.routing,
    trace: last.trace,
  };
};

const findRecordTrashItems = async (
  tableId: string,
  deletedRecordIds: string[],
): Promise<RecordTrashLookup[]> => {
  const expectedIds = new Set(deletedRecordIds);
  const matchedIds = new Set<string>();
  const lookups: RecordTrashLookup[] = [];
  let cursor: string | null | undefined;
  for (let page = 1; page <= 25; page += 1) {
    const response = await getTrashItems({
      resourceId: tableId,
      resourceType: TrashType.Table,
      cursor,
    });
    const items = response.data.trashItems as Array<{
      id: string;
      resourceType?: string;
      resourceIds?: string[];
      deletedTime?: string;
    }>;
    for (const item of items) {
      if (
        item.resourceType !== TableTrashType.Record ||
        !item.resourceIds?.length ||
        !item.resourceIds.every((recordId) => expectedIds.has(recordId))
      ) {
        continue;
      }
      const newIds = item.resourceIds.filter(
        (recordId) => !matchedIds.has(recordId),
      );
      if (newIds.length === 0) continue;
      newIds.forEach((recordId) => matchedIds.add(recordId));
      lookups.push({
        trashId: item.id,
        resourceCount: item.resourceIds.length,
        deletedTime: item.deletedTime,
        scannedPages: page,
      });
    }
    if (matchedIds.size === expectedIds.size) {
      return lookups;
    }

    cursor = (response.data as { nextCursor?: string | null }).nextCursor;
    if (!cursor || items.length === 0) break;
  }

  throw new Error(
    `Record trash items cover ${matchedIds.size}/${expectedIds.size} deleted records in table ${tableId}`,
  );
};

const setupRecordTrash = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: RecordReplayFixture,
  config: RecordRestoreCaseConfig,
  windowId: string,
): Promise<RestoreSetupResult> => {
  const deleteResult = await deleteRowsForRestoreSetup(
    fixture,
    perfCase,
    context,
    windowId,
  );
  const deletedState = await assertDeleted(fixture);
  const trashLookups = await pollUntilReady(
    {
      timeoutMs: 60_000,
      pollIntervalMs: 500,
      description: `record trash item for ${config.rowCount} rows in table ${fixture.tableId}`,
    },
    () => findRecordTrashItems(fixture.tableId, deleteResult.deletedRecordIds),
  );
  const { deletedRecordIds: _deletedRecordIds, ...compactDelete } =
    deleteResult;

  return {
    delete: compactDelete,
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
  new PerfRunDiagnosticError(
    error instanceof Error ? error.message : String(error),
    {
      metrics: {},
      thresholds: [],
      details: {
        partialPrimaryMeasurement: {
          name: config.threshold.metric,
          durationMs: result.restoreMeasurement?.durationMs ?? 0,
          result,
        } satisfies Measurement<RestorePrimaryResult>,
      },
    },
  );

const runRestoreMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: RecordReplayFixture,
  config: RecordRestoreCaseConfig,
  windowId: string,
): Promise<Measurement<RestorePrimaryResult>> => {
  const result: RestorePrimaryResult = {};
  try {
    result.setupMeasurement = await measureAsync("deleteRecordSetup", () =>
      setupRecordTrash(perfCase, context, fixture, config, windowId),
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
  if (isExecuteDbIsolated()) return;
  if (!fixture?.tableId) return;

  const verified = primaryMeasurement?.result.verifyMeasurement?.result;
  if (
    fixture.reusableSeed &&
    verified?.scannedRecords === fixture.seededRecords.length
  ) {
    return;
  }

  try {
    await permanentDeleteTable(baseId, fixture.tableId);
  } catch (error) {
    console.warn(
      `Failed to cleanup perf record restore table ${fixture.tableId}`,
      error,
    );
  }
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
    assertRowsRestored(fixture, config, { verifySamples: true }),
  runMeasuredOperation: ({ perfCase, context, fixture, config, windowId }) =>
    runRestoreMeasuredOperation(perfCase, context, fixture, config, windowId),
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
