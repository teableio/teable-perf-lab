import { measureAsync } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import { PerfRunDiagnosticError } from "../types";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordRedoCaseConfig,
} from "../types";
import {
  assertDeleted,
  assertRowsRestored,
  buildRecordReplayResult,
  buildRecordWindowId,
  cleanupRecordUndoRedoFixture,
  deleteAllRows,
  prepareRecordUndoRedoFixture,
  redoLastOperation,
  undoLastOperation,
  withRecordWindowId,
  type Measurement,
  type RecordReplaySetupMeasurements,
  type RecordReplayVerification,
  type RecordUndoRedoFixture,
} from "./record-undo-redo.shared";

export const runRecordRedoCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as RecordRedoCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const windowId = buildRecordWindowId(context, perfCase);
  let prepareMeasurement: Measurement<RecordUndoRedoFixture> | undefined;
  let seedReadyMeasurement: Measurement<RecordReplayVerification> | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareRecordUndoRedoFixture(baseId, tableName, config, {
        perfCase,
        runner: "record-redo",
        seedCodeFiles: [new URL(import.meta.url)],
      }),
    );
    const fixture = prepareMeasurement.result;
    let setupMeasurements: RecordReplaySetupMeasurements = {};
    let operationMeasurement: Measurement<unknown> | undefined;
    let verifyMeasurement: Measurement<RecordReplayVerification> | undefined;

    try {
      seedReadyMeasurement = await measureAsync("seedReady", () =>
        assertRowsRestored(fixture, config),
      );

      await withRecordWindowId(windowId, async () => {
        setupMeasurements = {
          ...setupMeasurements,
          deleteSetupMeasurement: await measureAsync("deleteSetup10k", () =>
            deleteAllRows(fixture, context),
          ),
        };
        setupMeasurements = {
          ...setupMeasurements,
          deleteSetupVerifyMeasurement: await measureAsync(
            "deleteSetupVerify",
            () => assertDeleted(fixture),
          ),
        };
        setupMeasurements = {
          ...setupMeasurements,
          undoSetupMeasurement: await measureAsync("undoSetup10k", () =>
            undoLastOperation(fixture, context),
          ),
        };
        setupMeasurements = {
          ...setupMeasurements,
          undoSetupVerifyMeasurement: await measureAsync(
            "undoSetupVerify",
            () => assertRowsRestored(fixture, config),
          ),
        };

        operationMeasurement = await withPerfTraceStep(
          context,
          perfCase,
          config.threshold.metric,
          () =>
            measureAsync(config.threshold.metric, () =>
              redoLastOperation(fixture, context),
            ),
        );
      });

      verifyMeasurement = await measureAsync("verifyDeleted", () =>
        assertDeleted(fixture),
      );
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildRecordReplayResult({
          config,
          operation: "redo",
          windowId,
          fixture,
          prepareMeasurement,
          seedReadyMeasurement,
          setupMeasurements,
          operationMeasurement,
          verifyMeasurement,
          error,
        }),
      );
    }

    return buildRecordReplayResult({
      config,
      operation: "redo",
      windowId,
      fixture,
      prepareMeasurement,
      seedReadyMeasurement,
      setupMeasurements,
      operationMeasurement,
      verifyMeasurement,
    });
  } finally {
    await cleanupRecordUndoRedoFixture(baseId, prepareMeasurement, {
      config,
      context,
      windowId,
    });
  }
};
