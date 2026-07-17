import { definePerfCase } from "../../framework/types";
import {
  recordDuplicateSingle50Base,
  recordDuplicateSingle50Fields,
} from "../record-duplicate.shared";

export default definePerfCase({
  id: "record-duplicate/single-50-rating-10fields",
  title: "Duplicate 50 records sequentially in a 10-field rating table",
  runner: "record-duplicate-single",
  timeoutMs: 300_000,
  config: {
    ...recordDuplicateSingle50Base,
    tableNamePrefix: "perf-record-duplicate-single-50-rating-10fields",
    fields: recordDuplicateSingle50Fields.rating10,
    threshold: {
      metric: "duplicateSingleP95Ms",
      maxMs: 2_000,
    },
  },
});
