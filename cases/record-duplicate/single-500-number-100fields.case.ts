import { definePerfCase } from "../../framework/types";
import {
  recordDuplicateSingle500Base,
  recordDuplicateSingle500WideFields,
} from "../record-duplicate.shared";

export default definePerfCase({
  id: "record-duplicate/single-500-number-100fields",
  title: "Duplicate 500 records sequentially in a 100-field number table",
  runner: "record-duplicate-single",
  timeoutMs: 900_000,
  config: {
    ...recordDuplicateSingle500Base,
    tableNamePrefix: "perf-record-duplicate-single-500-number-100fields",
    fields: recordDuplicateSingle500WideFields.number100,
    threshold: { metric: "duplicateSingleP95Ms", maxMs: 5_000 },
  },
});
