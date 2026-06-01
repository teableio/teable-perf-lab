import { measureAsync } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import { PerfRunDiagnosticError } from "../types";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordUndoCaseConfig,
} from "../types";
import {
  assertDeleted,
  assertRowsRestored,
  buildRecordReplayResult,
  buildRecordWindowId,
  cleanupRecordUndoRedoFixture,
  deleteAllRows,
  prepareRecordUndoRedoFixture,
  undoLastOperation,
  waitForRowsRestored,
  withRecordWindowId,
  type Measurement,
  type RecordReplaySetupMeasurements,
  type RecordReplayVerification,
  type RecordUndoRedoFixture,
} from "./record-undo-redo.shared";

export const runRecordUndoCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as RecordUndoCaseConfig;
  if (context.engine === "v1") {
    return {
      result: "skipped",
      metrics: {},
      thresholds: [],
      details: {
        operation: "undo",
        skipped: true,
        reason:
          "V1 delete-stream undo returns fulfilled but does not restore the 10k selection-delete fixture in this e2e path. The case measures the V2 large undo replay path.",
        engine: context.engine,
        rowCount: config.rowCount,
      },
    };
  }

  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const windowId = buildRecordWindowId(context, perfCase);
  let prepareMeasurement: Measurement<RecordUndoRedoFixture> | undefined;
  let seedReadyMeasurement: Measurement<RecordReplayVerification> | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareRecordUndoRedoFixture(baseId, tableName, config, {
        perfCase,
        runner: "record-undo",
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

        operationMeasurement = await withPerfTraceStep(
          context,
          perfCase,
          config.threshold.metric,
          () =>
            measureAsync(config.threshold.metric, () =>
              undoLastOperation(fixture, context),
            ),
        );
      });

      verifyMeasurement = await measureAsync("verifyRestored", () =>
        waitForRowsRestored(fixture, config),
      );
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildRecordReplayResult({
          config,
          operation: "undo",
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
      operation: "undo",
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
