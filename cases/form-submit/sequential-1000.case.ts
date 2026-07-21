import { definePerfCase } from "../../framework/types";
import baseline from "./sequential-200.case";

export default definePerfCase({
  id: "form-submit/sequential-1000",
  title: "Submit 1,000 records sequentially through a Form view",
  runner: "form-submit",
  timeoutMs: 1_800_000,
  runtimeEnv: {
    PERF_LAB_TRACE_INCLUDE_STEP_PATTERN: "^formSubmitP95Ms:(1|500|1000)$",
    PERF_LAB_TRACE_FALLBACK_STEP_PATTERN: "^formSubmitP95Ms:\\d+$",
    PERF_LAB_TRACE_FALLBACK_MAX_ATTEMPTS: 3,
  },
  config: {
    ...baseline.config,
    tableNamePrefix: "perf-form-submit-sequential-1000",
    rowCount: 1_000,
    verify: { sampleRows: [0, 499, 999], fullScanPageSize: 1_000 },
    threshold: { metric: "formSubmitP95Ms", maxMs: 2_000 },
  },
});
