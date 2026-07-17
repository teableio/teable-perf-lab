import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-restore/10k-start-date-field",
  title: "Restore one populated date field on a 10k-row mixed table",
  runner: "field-restore",
  timeoutMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    tableNamePrefix: "perf-field-restore-10k-start-date",
    generator: {
      ...recordReplay10kBaseConfig.generator,
      source: "perf-lab-field-restore-start-date",
    },
    restore: {
      fieldName: "Start Date",
    },
    threshold: {
      metric: "restoreFieldMs",
      maxMs: 120_000,
    },
  },
});
