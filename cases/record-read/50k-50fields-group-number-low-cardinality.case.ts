import { definePerfCase } from "../../framework/types";
import baseCase from "./50k-50fields-50x1k-pages.case";

export default definePerfCase({
  id: "record-read/50k-50fields-group-number-low-cardinality",
  title: "Group a 50k 50-field record read by a seven-value number field",
  runner: "record-read",
  seedAffinity: "record-read/50k-50fields",
  timeoutMs: 1_800_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      groupBy: [{ fieldName: "C", order: "asc" }],
      expectedRowCount: 50_000,
    },
    threshold: { metric: "getRecordsQueryOverheadMs", maxMs: 30_000 },
  },
});
