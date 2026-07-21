import { definePerfCase } from "../../framework/types";
import {
  recordDuplicateSingle500Base,
  recordDuplicateSingleMaxWidthFields,
} from "../record-duplicate.shared";

export default definePerfCase({
  id: "record-duplicate/single-500-multiple-select-500fields",
  title: "Duplicate 500 records sequentially at the 500-field limit",
  runner: "record-duplicate-single",
  timeoutMs: 1_800_000,
  watchdogMs: 600_000,
  config: {
    ...recordDuplicateSingle500Base,
    tableNamePrefix: "perf-record-duplicate-single-500-multi-select-500fields",
    fields: recordDuplicateSingleMaxWidthFields.multipleSelect500,
    threshold: { metric: "duplicateSingleP95Ms", maxMs: 5_000 },
  },
});
