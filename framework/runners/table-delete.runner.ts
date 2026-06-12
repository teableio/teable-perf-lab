import { permanentDeleteTable } from "../../../utils/init-app";
import { isExecuteDbIsolated } from "../env";
import { measureAsync } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  TableDeleteCaseConfig,
} from "../types";
import { PerfRunDiagnosticError } from "../types";
import {
  assertRowsRestored,
  waitForRowsRestored,
  type Measurement,
  type RecordReplayVerification,
  type RecordUndoRedoFixture,
} from "./record-undo-redo.shared";
import {
  archiveTable,
  assertTableNotListed,
  buildTableLifecycleResult,
  findTableTrashId,
  prepareTableLifecycleFixture,
  restoreTableTrash,
  seedTableLifecycleCase,
  type TableLifecycleRequestResult,
  type TableTrashLookup,
} from "./table-lifecycle.shared";

export const runTableDeleteCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as TableDeleteCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  let prepareMeasurement: Measurement<RecordUndoRedoFixture> | undefined;
  let seedReadyMeasurement: Measurement<RecordReplayVerification> | undefined;
  let primaryMeasurement: Measurement<TableLifecycleRequestResult> | undefined;
  let verifyMeasurement: Measurement<unknown> | undefined;
  let cleanupRestoreMeasurement:
    | Measurement<TableLifecycleRequestResult>
    | undefined;
  let cleanupVerifyMeasurement:
    | Measurement<RecordReplayVerification>
    | undefined;
  let trashLookup: TableTrashLookup | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareTableLifecycleFixture(
        baseId,
        tableName,
        config,
        perfCase,
        "table-delete",
      ),
    );
    const fixture = prepareMeasurement.result;
    seedReadyMeasurement = await measureAsync("seedReady", () =>
      assertRowsRestored(fixture, config),
    );

    try {
      primaryMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        config.threshold.metric,
        () =>
          measureAsync("deleteTableRequest", () =>
            archiveTable(baseId, fixture.tableId),
          ),
      );

      verifyMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        "deleteTableVerify",
        () =>
          measureAsync("deleteTableVerify", async () => {
            const listing = await assertTableNotListed(baseId, fixture.tableId);
            trashLookup = await findTableTrashId(baseId, fixture.tableId);
            return { ...listing, trashId: trashLookup.trashId };
          }),
      );

      if (!isExecuteDbIsolated() && trashLookup) {
        cleanupRestoreMeasurement = await withPerfTraceStep(
          context,
          perfCase,
          "cleanupRestoreTable",
          () =>
            measureAsync("cleanupRestoreTable", () =>
              restoreTableTrash(trashLookup!.trashId),
            ),
        );
        cleanupVerifyMeasurement = await measureAsync("cleanupFullScan", () =>
          waitForRowsRestored(fixture, config),
        );
      }
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildTableLifecycleResult({
          config,
          runner: "table-delete",
          prepareMeasurement,
          seedReadyMeasurement,
          primaryMeasurement,
          verifyMeasurement,
          setupMeasurements: [
            ...(cleanupRestoreMeasurement ? [cleanupRestoreMeasurement] : []),
            ...(cleanupVerifyMeasurement ? [cleanupVerifyMeasurement] : []),
          ],
          trashLookup,
          error,
        }),
      );
    }

    return buildTableLifecycleResult({
      config,
      runner: "table-delete",
      prepareMeasurement,
      seedReadyMeasurement,
      primaryMeasurement,
      verifyMeasurement,
      setupMeasurements: [
        ...(cleanupRestoreMeasurement ? [cleanupRestoreMeasurement] : []),
        ...(cleanupVerifyMeasurement ? [cleanupVerifyMeasurement] : []),
      ],
      trashLookup,
      details: {
        cleanup:
          cleanupRestoreMeasurement && cleanupVerifyMeasurement
            ? {
                restoreStatus: cleanupRestoreMeasurement.result.status,
                restoreRequestMs: cleanupRestoreMeasurement.durationMs,
                fullScan: cleanupVerifyMeasurement.result,
              }
            : undefined,
        verification: {
          metric: "deleteTableVerifyMs",
          checks: [
            "tableAbsentFromBaseTableList",
            "trashItemPresent",
            ...(cleanupVerifyMeasurement
              ? ["cleanupRestoreFullRowCountScan"]
              : []),
          ],
          participatesInThreshold: false,
        },
      },
    });
  } finally {
    // CI execute jobs run on an isolated restored copy of the seed dump, so
    // the mutated database is simply discarded after the job.
    if (!isExecuteDbIsolated()) {
      const fixture = prepareMeasurement?.result;
      if (fixture?.tableId) {
        const archived = Boolean(primaryMeasurement);
        let restored = Boolean(cleanupVerifyMeasurement);

        if (!restored && archived && trashLookup) {
          try {
            await withPerfTraceStep(
              context,
              perfCase,
              "cleanupRestoreTable",
              () => restoreTableTrash(trashLookup!.trashId),
            );
            await waitForRowsRestored(fixture, config);
            restored = true;
          } catch (error) {
            console.warn(
              `Failed to restore archived table ${fixture.tableId}; deleting it`,
              error,
            );
          }
        }

        if (!(restored && fixture.reusableSeed)) {
          try {
            await permanentDeleteTable(baseId, fixture.tableId);
          } catch (error) {
            console.warn(
              `Failed to cleanup perf table ${fixture.tableId}`,
              error,
            );
          }
        }
      }
    }
  }
};

export const seedTableDeleteCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedTableLifecycleCase(perfCase, context, "table-delete");
