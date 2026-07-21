import { definePerfCase } from "../../framework/types";
import {
  recordDuplicateSingle500Base,
  recordDuplicateSingle50Fields,
} from "../record-duplicate.shared";

export default definePerfCase({
  id: "record-duplicate/single-500-number-10fields",
  title: "Duplicate 500 records sequentially in a 10-field number table",
  runner: "record-duplicate-single",
  timeoutMs: 900_000,
  config: {
    ...recordDuplicateSingle500Base,
    tableNamePrefix: "perf-record-duplicate-single-500-number-10fields",
    fields: recordDuplicateSingle50Fields.number10,
    threshold: { metric: "duplicateSingleP95Ms", maxMs: 2_000 },
  },
});
