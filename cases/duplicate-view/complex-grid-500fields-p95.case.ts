import { FieldType } from "@teable/core";
import { recordReplayMixed20Fields } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

const extraFields = Array.from({ length: 480 }, (_, index) => ({
  name: `Extra Text ${String(index + 1).padStart(3, "0")}`,
  type: FieldType.SingleLineText,
}));

export default definePerfCase({
  id: "duplicate-view/complex-grid-500fields-p95",
  title: "Duplicate a complex 500-field grid view and track request p95",
  runner: "duplicate-view",
  timeoutMs: 1_800_000,
  watchdogMs: 300_000,
  runtimeEnv: {
    PERF_LAB_TRACE_INCLUDE_STEP_PATTERN: "^(warmup|sample-(1|15|30))$",
    PERF_LAB_TRACE_FALLBACK_STEP_PATTERN: "^sample-\\d+$",
  },
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-duplicate-view-complex-grid-500fields",
    fields: [...recordReplayMixed20Fields, ...extraFields],
    samples: 30,
    sourceViewName: "perf-complex-grid-source",
    view: {
      textFieldName: "Title",
      numberFieldName: "Amount",
      selectFieldName: "Status",
      groupFieldName: "Category",
    },
    threshold: { metric: "duplicateViewP95Ms", maxMs: 2_000 },
  },
});
