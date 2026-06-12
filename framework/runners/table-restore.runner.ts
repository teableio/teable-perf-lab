import { permanentDeleteTable } from "../../../utils/init-app";
import { isExecuteDbIsolated } from "../env";
import { measureAsync } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  TableRestoreCaseConfig,
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
  assertSampleTextValues,
  assertTableNotListed,
  buildTableLifecycleResult,
  findTableTrashId,
  prepareTableLifecycleFixture,
  restoreTableTrash,
  seedTableLifecycleCase,
  type TableLifecycleRequestResult,
  type TableTrashLookup,
} from "./table-lifecycle.shared";

export const runTableRestoreCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as TableRestoreCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  let prepareMeasurement: Measurement<RecordUndoRedoFixture> | undefined;
  let seedReadyMeasurement: Measurement<RecordReplayVerification> | undefined;
  let deleteSetupMeasurement: Measurement<unknown> | undefined;
  let primaryMeasurement: Measurement<TableLifecycleRequestResult> | undefined;
  let verifyMeasurement: Measurement<unknown> | undefined;
  let trashLookup: TableTrashLookup | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareTableLifecycleFixture(
        baseId,
        tableName,
        config,
        perfCase,
        "table-restore",
      ),
    );
    const fixture = prepareMeasurement.result;
    seedReadyMeasurement = await measureAsync("seedReady", () =>
      assertRowsRestored(fixture, config),
    );

    try {
      // Archive-to-trash is setup for the measured restore, not the metric.
      deleteSetupMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        "deleteSetup",
        () =>
          measureAsync("deleteSetup", async () => {
            const archive = await archiveTable(baseId, fixture.tableId);
            const listing = await assertTableNotListed(baseId, fixture.tableId);
            trashLookup = await findTableTrashId(baseId, fixture.tableId);
            return {
              archiveStatus: archive.status,
              ...listing,
              trashId: trashLookup.trashId,
            };
          }),
      );

      primaryMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        config.threshold.metric,
        () =>
          measureAsync("restoreTableRequest", () =>
            restoreTableTrash(trashLookup!.trashId),
          ),
      );

      verifyMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        "restoreTableVerify",
        () =>
          measureAsync("restoreTableVerify", async () => {
            const fullScan = await waitForRowsRestored(fixture, config, {
              timeoutMs: 60_000,
              pollIntervalMs: 1_000,
            });
            const samples = await assertSampleTextValues(fixture, config);
            return { fullScan, samples };
          }),
      );
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildTableLifecycleResult({
          config,
          runner: "table-restore",
          prepareMeasurement,
          seedReadyMeasurement,
          setupMeasurements: deleteSetupMeasurement
            ? [deleteSetupMeasurement]
            : undefined,
          primaryMeasurement,
          verifyMeasurement,
          trashLookup,
          error,
        }),
      );
    }

    const verifyResult = verifyMeasurement.result as {
      fullScan: RecordReplayVerification;
      samples: Awaited<ReturnType<typeof assertSampleTextValues>>;
    };

    return buildTableLifecycleResult({
      config,
      runner: "table-restore",
      prepareMeasurement,
      seedReadyMeasurement,
      setupMeasurements: [deleteSetupMeasurement],
      primaryMeasurement,
      verifyMeasurement,
      trashLookup,
      details: {
        fullScan: verifyResult.fullScan,
        verifiedSamples: verifyResult.samples.verifiedSamples,
        verification: {
          metric: "restoreTableVerifyMs",
          checks: [
            "fullRowCountScan",
            `sampleTextValues(${verifyResult.samples.verifiedFieldNames.join(
              ",",
            )})`,
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
        const archived = Boolean(deleteSetupMeasurement);
        const restoredByPrimary = Boolean(primaryMeasurement);
        let tableIsLive = !archived || restoredByPrimary;

        if (archived && !restoredByPrimary && trashLookup) {
          try {
            await withPerfTraceStep(
              context,
              perfCase,
              "cleanupRestoreTable",
              () => restoreTableTrash(trashLookup!.trashId),
            );
            await waitForRowsRestored(fixture, config);
            tableIsLive = true;
          } catch (error) {
            console.warn(
              `Failed to restore archived table ${fixture.tableId}; deleting it`,
              error,
            );
          }
        }

        if (!(tableIsLive && fixture.reusableSeed)) {
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

export const seedTableRestoreCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedTableLifecycleCase(perfCase, context, "table-restore");
