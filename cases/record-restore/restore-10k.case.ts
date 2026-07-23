import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-restore/restore-10k",
  title: "Restore 10k records from table trash",
  runner: "record-restore",
  seedAffinity: "record-replay/10k",
  timeoutMs: 1_200_000,
  watchdogMs: 300_000,
  config: {
    ...recordReplay10kBaseConfig,
    tableNamePrefix: "perf-record-restore-10k",
    verify: {
      ...recordReplay10kBaseConfig.verify,
      timeoutMs: 300_000,
      pollIntervalMs: 1_000,
    },
    threshold: {
      metric: "restoreRecords10kMs",
      // Initial correctness-first guardrail; calibrate after local + CI runs.
      maxMs: 180_000,
    },
  },
});
