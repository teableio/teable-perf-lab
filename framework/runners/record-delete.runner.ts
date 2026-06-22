import type { PerfCase, PerfRunContext, PerfRunResult } from "../types";
import { runRecordReplayLifecycle } from "./record-replay-lifecycle";
import { assertDeleted, deleteAllRowsByEngine } from "./record-replay.shared";

// Measured operation: delete every seeded row through the grid selection-delete
// path. Same user behavior on both engines, engine-specific endpoint: V1 deletes
// by range (DELETE /selection/delete), V2 deletes by id (POST
// /selection/delete-by-id). No setup phases. Verify that no records remain.
export const runRecordDeleteCase = (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordReplayLifecycle(perfCase, context, {
    runner: "record-delete",
    operation: "delete",
    seedCodeFile: new URL(import.meta.url),
    measuredOperation: ({ fixture, context }) =>
      deleteAllRowsByEngine(fixture, context),
    verifyPhaseName: "verifyDeleted",
    verify: ({ fixture }) => assertDeleted(fixture),
  });
