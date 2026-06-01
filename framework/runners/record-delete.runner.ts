import { measureAsync } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import { PerfRunDiagnosticError } from "../types";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordDeleteCaseConfig,
} from "../types";
import {
  assertDeleted,
  assertRowsRestored,
  buildRecordReplayResult,
  buildRecordWindowId,
  cleanupRecordUndoRedoFixture,
  deleteAllRows,
  prepareRecordUndoRedoFixture,
  withRecordWindowId,
  type Measurement,
  type RecordReplayVerification,
  type RecordUndoRedoFixture,
} from "./record-undo-redo.shared";

export const runRecordDeleteCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as RecordDeleteCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const windowId = buildRecordWindowId(context, perfCase);
  let prepareMeasurement: Measurement<RecordUndoRedoFixture> | undefined;
  let seedReadyMeasurement: Measurement<RecordReplayVerification> | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareRecordUndoRedoFixture(baseId, tableName, config, {
        perfCase,
        runner: "record-delete",
        seedCodeFiles: [new URL(import.meta.url)],
      }),
    );
    const fixture = prepareMeasurement.result;
    let operationMeasurement: Measurement<unknown> | undefined;
    let verifyMeasurement: Measurement<RecordReplayVerification> | undefined;

    try {
      seedReadyMeasurement = await measureAsync("seedReady", () =>
        assertRowsRestored(fixture, config),
      );

      await withRecordWindowId(windowId, async () => {
        operationMeasurement = await withPerfTraceStep(
          context,
          perfCase,
          config.threshold.metric,
          () =>
            measureAsync(config.threshold.metric, () =>
              deleteAllRows(fixture, context),
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
          operation: "delete",
          windowId,
          fixture,
          prepareMeasurement,
          seedReadyMeasurement,
          operationMeasurement,
          verifyMeasurement,
          error,
        }),
      );
    }

    return buildRecordReplayResult({
      config,
      operation: "delete",
      windowId,
      fixture,
      prepareMeasurement,
      seedReadyMeasurement,
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
