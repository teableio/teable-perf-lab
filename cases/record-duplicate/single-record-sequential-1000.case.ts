import { definePerfCase } from "../../framework/types";
import {
  recordDuplicateSingle500Base,
  recordDuplicateSingle50Fields,
} from "../record-duplicate.shared";

export default definePerfCase({
  id: "record-duplicate/single-record-sequential-1000",
  title: "Duplicate 1,000 records sequentially through the record endpoint",
  runner: "record-duplicate-single",
  timeoutMs: 1_200_000,
  config: {
    ...recordDuplicateSingle500Base,
    tableNamePrefix: "perf-record-duplicate-single-record-sequential-1000",
    fields: recordDuplicateSingle50Fields.mixed20,
    duplicate: { sourceRowCount: 1_000 },
    verify: { sampleRows: [0, 499, 999], fullScanPageSize: 1_000 },
    threshold: { metric: "duplicateSingleP95Ms", maxMs: 2_000 },
  },
});
