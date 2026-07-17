import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-restore/10k-status-field",
  title: "Restore one populated single-select field on a 10k-row mixed table",
  runner: "field-restore",
  timeoutMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    tableNamePrefix: "perf-field-restore-10k-status",
    generator: {
      ...recordReplay10kBaseConfig.generator,
      source: "perf-lab-field-restore-status",
    },
    restore: {
      fieldName: "Status",
    },
    threshold: {
      metric: "restoreFieldMs",
      maxMs: 120_000,
    },
  },
});
