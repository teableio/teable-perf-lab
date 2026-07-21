import { measureAsync } from "../metrics";
import type {
  PerfCaseFor,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import { runRecordReplayLifecycle } from "./record-replay-lifecycle";
import {
  assertDeleted,
  buildRecordReplayPhaseName,
  deleteAllRowsViaSelectionDelete,
  redoLastOperation,
  undoLastOperation,
  waitForDeleteReplayReady,
  waitForRowsRestored,
} from "./record-replay.shared";

// Setup (not measured): delete all rows, undo that delete (rows restored), so a
// redo has something to replay. Measured operation: redo via the redo-stream.
// Verify the rows are deleted again.
export const runRecordRedoCase = (
  perfCase: PerfCaseFor<"record-redo">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordReplayLifecycle(perfCase, context, {
    runner: "record-redo",
    operation: "redo",
    seedCodeFile: new URL(import.meta.url),
    runSetup: async ({ fixture, context, perfCase, config }) => {
      const deleteStartedAt = new Date();
      const deleteSetupMeasurement = await measureAsync(
        buildRecordReplayPhaseName("deleteSetup", config.rowCount),
        () => deleteAllRowsViaSelectionDelete(fixture, context),
      );
      const deleteSetupVerifyMeasurement = await measureAsync(
        "deleteSetupVerify",
        () => assertDeleted(fixture),
      );
      const deleteReplayReadyMeasurement = await measureAsync(
        "deleteReplayReady",
        () =>
          waitForDeleteReplayReady(fixture, context, deleteStartedAt, {
            timeoutMs: config.verify.timeoutMs,
            pollIntervalMs: config.verify.pollIntervalMs,
          }),
      );
      const undoSetupPhaseName = buildRecordReplayPhaseName(
        "undoSetup",
        config.rowCount,
      );
      const undoSetupMeasurement = await measureAsync(undoSetupPhaseName, () =>
        undoLastOperation(fixture, context, perfCase, undoSetupPhaseName),
      );
      const undoSetupVerifyMeasurement = await measureAsync(
        "undoSetupVerify",
        () => waitForRowsRestored(fixture, config),
      );
      return {
        deleteSetupMeasurement,
        deleteSetupVerifyMeasurement,
        deleteReplayReadyMeasurement,
        undoSetupMeasurement,
        undoSetupVerifyMeasurement,
      };
    },
    measuredOperation: ({ fixture, context, perfCase, config }) =>
      redoLastOperation(fixture, context, perfCase, config.threshold.metric),
    verifyPhaseName: "verifyDeleted",
    verify: ({ fixture }) => assertDeleted(fixture),
  });
