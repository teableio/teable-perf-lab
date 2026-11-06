import { definePerfCase } from "../../framework/types";
import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";

export default definePerfCase({
  id: "record-delete/delete-stream-1k",
  title: "Delete a 1k-row table through a durable V2 operation",
  runner: "record-delete-stream",
  expectedSkipEngines: ["v1"],
  timeoutMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    rowCount: 1_000,
    tableNamePrefix: "perf-record-delete-stream-1k",
    verify: {
      ...recordReplay10kBaseConfig.verify,
      sampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "deleteOperationTotalReady1kMs",
      // Preserve the existing numeric guardrail; this new metric identity
      // includes durable effect readiness, unlike historical stream timings.
      maxMs: 30_000,
    },
  },
});
