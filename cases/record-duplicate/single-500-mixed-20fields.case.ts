import { definePerfCase } from "../../framework/types";
import {
  recordDuplicateSingle500Base,
  recordDuplicateSingle50Fields,
} from "../record-duplicate.shared";

export default definePerfCase({
  id: "record-duplicate/single-500-mixed-20fields",
  title: "Duplicate 500 records sequentially in a 20-field mixed table",
  runner: "record-duplicate-single",
  timeoutMs: 900_000,
  config: {
    ...recordDuplicateSingle500Base,
    tableNamePrefix: "perf-record-duplicate-single-500-mixed-20fields",
    fields: recordDuplicateSingle50Fields.mixed20,
    threshold: { metric: "duplicateSingleP95Ms", maxMs: 2_000 },
  },
});
