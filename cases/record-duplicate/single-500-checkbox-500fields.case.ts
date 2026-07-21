import { definePerfCase } from "../../framework/types";
import {
  recordDuplicateSingle500Base,
  recordDuplicateSingleMaxWidthFields,
} from "../record-duplicate.shared";

export default definePerfCase({
  id: "record-duplicate/single-500-checkbox-500fields",
  title: "Duplicate 500 records sequentially at the 500-field limit",
  runner: "record-duplicate-single",
  timeoutMs: 1_800_000,
  watchdogMs: 600_000,
  runtimeEnv: {
    PERF_LAB_TRACE_INCLUDE_STEP_PATTERN: "^duplicateSingleP95Ms-(1|250|500)$",
    PERF_LAB_TRACE_FALLBACK_STEP_PATTERN: "^duplicateSingleP95Ms-\\d+$",
  },
  config: {
    ...recordDuplicateSingle500Base,
    tableNamePrefix: "perf-record-duplicate-single-500-checkbox-500fields",
    batchSize: 100,
    fields: recordDuplicateSingleMaxWidthFields.checkbox500,
    threshold: { metric: "duplicateSingleP95Ms", maxMs: 5_000 },
  },
});
