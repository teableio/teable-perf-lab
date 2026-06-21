import { measureAsync } from "../metrics";
import type { PerfCase, PerfRunContext, PerfRunResult } from "../types";
import { runRecordReplayLifecycle } from "./record-replay-lifecycle";
import {
  assertDeleted,
  buildRecordReplayPhaseName,
  deleteAllRowsViaSelectionDelete,
  undoLastOperation,
  waitForRowsRestored,
} from "./record-replay.shared";

// Setup (not measured): delete all rows, then assert the table is empty.
// Measured operation: undo that delete via the undo-stream. Verify the rows are
// restored, including sampled cell values.
export const runRecordUndoCase = (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordReplayLifecycle(perfCase, context, {
    runner: "record-undo",
    operation: "undo",
    seedCodeFile: new URL(import.meta.url),
    runSetup: async ({ fixture, context, config }) => {
      const deleteSetupMeasurement = await measureAsync(
        buildRecordReplayPhaseName("deleteSetup", config.rowCount),
        () => deleteAllRowsViaSelectionDelete(fixture, context),
      );
      const deleteSetupVerifyMeasurement = await measureAsync(
        "deleteSetupVerify",
        () => assertDeleted(fixture),
      );
      return { deleteSetupMeasurement, deleteSetupVerifyMeasurement };
    },
    measuredOperation: ({ fixture, context, perfCase, config }) =>
      undoLastOperation(fixture, context, perfCase, config.threshold.metric),
    verifyPhaseName: "verifyRestored",
    verify: ({ fixture, config }) =>
      waitForRowsRestored(fixture, config, { verifySamples: true }),
  });
