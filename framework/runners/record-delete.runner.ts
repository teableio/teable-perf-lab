import type { PerfCase, PerfRunContext, PerfRunResult } from "../types";
import { runRecordReplayLifecycle } from "./record-replay-lifecycle";
import {
  assertDeleted,
  deleteAllRowsViaSelectionDelete,
} from "./record-replay.shared";

// Measured operation: delete every seeded row through the grid selection-delete
// path. No setup phases. Verify that no records remain.
export const runRecordDeleteCase = (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordReplayLifecycle(perfCase, context, {
    runner: "record-delete",
    operation: "delete",
    seedCodeFile: new URL(import.meta.url),
    measuredOperation: ({ fixture, context }) =>
      deleteAllRowsViaSelectionDelete(fixture, context),
    verifyPhaseName: "verifyDeleted",
    verify: ({ fixture }) => assertDeleted(fixture),
  });
