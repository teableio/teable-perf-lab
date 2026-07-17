import { definePerfCase } from "../../framework/types";
import {
  recordDuplicateSingle50Base,
  recordDuplicateSingle50Fields,
} from "../record-duplicate.shared";

export default definePerfCase({
  id: "record-duplicate/single-50-primary-only",
  title: "Duplicate 50 records sequentially in a primary-only table",
  runner: "record-duplicate-single",
  timeoutMs: 300_000,
  config: {
    ...recordDuplicateSingle50Base,
    tableNamePrefix: "perf-record-duplicate-single-50-primary-only",
    fields: recordDuplicateSingle50Fields.primaryOnly,
    threshold: {
      metric: "duplicateSingleP95Ms",
      maxMs: 2_000,
    },
  },
});
