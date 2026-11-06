import { definePerfCase } from "../../framework/types";
import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";

export default definePerfCase({
  id: "record-delete/delete-stream-10k",
  title: "Delete a 10k-row table through a durable V2 operation",
  runner: "record-delete-stream",
  expectedSkipEngines: ["v1"],
  seedAffinity: "record-replay/10k",
  timeoutMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    rowCount: 10_000,
    batchSize: 1_000,
    tableNamePrefix: "perf-record-delete-stream-10k",
    verify: {
      ...recordReplay10kBaseConfig.verify,
      sampleRows: [0, 4_999, 9_999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "deleteOperationTotalReady10kMs",
      // Preserve the existing numeric guardrail; this new metric identity
      // includes durable effect readiness, unlike historical stream timings.
      maxMs: 60_000,
    },
  },
});
