import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-restore/10k-description-field",
  title: "Restore one populated text field on a 10k-row mixed table",
  runner: "field-restore",
  timeoutMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    tableNamePrefix: "perf-field-restore-10k-description",
    generator: {
      ...recordReplay10kBaseConfig.generator,
      source: "perf-lab-field-restore",
    },
    restore: {
      fieldName: "Description",
    },
    threshold: {
      metric: "restoreFieldMs",
      // First guardrail for a new case: V1 uses the legacy direct restore path,
      // V2 uses the product field-restore stream and restores 10k cell values.
      // Keep wide until the first CI history gives a stable p95/worst envelope.
      maxMs: 120_000,
    },
  },
});
