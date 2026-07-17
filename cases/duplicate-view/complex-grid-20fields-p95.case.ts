import { recordReplayMixed20Fields } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "duplicate-view/complex-grid-20fields-p95",
  title: "Duplicate a complex 20-field grid view and track request p95",
  runner: "duplicate-view",
  timeoutMs: 600_000,
  watchdogMs: 120_000,
  runtimeEnv: {
    PERF_LAB_TRACE_INCLUDE_STEP_PATTERN: "^(warmup|sample-(1|15|30))$",
    PERF_LAB_TRACE_FALLBACK_STEP_PATTERN: "^sample-\\d+$",
  },
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-duplicate-view-complex-grid-20fields",
    fields: recordReplayMixed20Fields,
    samples: 30,
    sourceViewName: "perf-complex-grid-source",
    view: {
      textFieldName: "Title",
      numberFieldName: "Amount",
      selectFieldName: "Status",
      groupFieldName: "Category",
    },
    threshold: {
      metric: "duplicateViewP95Ms",
      maxMs: 2_000,
    },
  },
});
