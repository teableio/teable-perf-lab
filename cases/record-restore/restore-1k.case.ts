import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-restore/restore-1k",
  title: "Restore 1k records from table trash",
  runner: "record-restore",
  timeoutMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    rowCount: 1_000,
    tableNamePrefix: "perf-record-restore-1k",
    verify: {
      ...recordReplay10kBaseConfig.verify,
      sampleRows: [0, 499, 999],
      timeoutMs: 120_000,
      pollIntervalMs: 500,
    },
    threshold: {
      metric: "restoreRecords1kMs",
      // Initial correctness-first guardrail; calibrate after local + CI runs.
      maxMs: 60_000,
    },
  },
});
