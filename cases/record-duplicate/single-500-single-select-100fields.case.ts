import { definePerfCase } from "../../framework/types";
import {
  recordDuplicateSingle500Base,
  recordDuplicateSingle500TraceRuntimeEnv,
  recordDuplicateSingle500WideFields,
} from "../record-duplicate.shared";

export default definePerfCase({
  id: "record-duplicate/single-500-single-select-100fields",
  title:
    "Duplicate 500 records sequentially in a 100-field single-select table",
  runner: "record-duplicate-single",
  timeoutMs: 900_000,
  runtimeEnv: recordDuplicateSingle500TraceRuntimeEnv,
  config: {
    ...recordDuplicateSingle500Base,
    tableNamePrefix: "perf-record-duplicate-single-500-single-select-100fields",
    fields: recordDuplicateSingle500WideFields.singleSelect100,
    threshold: { metric: "duplicateSingleP95Ms", maxMs: 5_000 },
  },
});
