import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-restore/restore-50k",
  title: "Restore 50k records from table trash",
  runner: "record-restore",
  timeoutMs: 1_800_000,
  watchdogMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    rowCount: 50_000,
    tableNamePrefix: "perf-record-restore-50k",
    verify: {
      ...recordReplay10kBaseConfig.verify,
      sampleRows: [0, 24_999, 49_999],
      timeoutMs: 900_000,
      pollIntervalMs: 2_000,
    },
    threshold: {
      metric: "restoreRecords50kMs",
      // Initial correctness-first guardrail; calibrate after local + CI runs.
      maxMs: 600_000,
    },
  },
});
