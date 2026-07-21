import { definePerfCase } from "../../framework/types";
import {
  recordDuplicateSingle500Base,
  recordDuplicateSingle50Fields,
} from "../record-duplicate.shared";

export default definePerfCase({
  id: "record-duplicate/single-500-primary-only",
  title: "Duplicate 500 records sequentially in a primary-only table",
  runner: "record-duplicate-single",
  timeoutMs: 900_000,
  config: {
    ...recordDuplicateSingle500Base,
    tableNamePrefix: "perf-record-duplicate-single-500-primary-only",
    fields: recordDuplicateSingle50Fields.primaryOnly,
    threshold: { metric: "duplicateSingleP95Ms", maxMs: 2_000 },
  },
});
