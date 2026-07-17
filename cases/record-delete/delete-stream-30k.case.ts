import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-delete/delete-stream-30k",
  title: "Delete a 30k-row table through the grid selection delete stream",
  runner: "record-delete-stream",
  timeoutMs: 1_200_000,
  watchdogMs: 300_000,
  config: {
    ...recordReplay10kBaseConfig,
    rowCount: 30_000,
    batchSize: 1_000,
    tableNamePrefix: "perf-record-delete-stream-30k",
    verify: {
      ...recordReplay10kBaseConfig.verify,
      sampleRows: [0, 14_999, 29_999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "deleteStream30kMs",
      // Initial scale guardrail; tighten after local and CI history.
      maxMs: 120_000,
    },
  },
});
