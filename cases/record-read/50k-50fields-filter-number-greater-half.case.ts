import { definePerfCase } from "../../framework/types";
import baseCase from "./50k-50fields-50x1k-pages.case";

export default definePerfCase({
  id: "record-read/50k-50fields-filter-number-greater-half",
  title: "Filter a 50k 50-field record read to the upper numeric half",
  runner: "record-read",
  timeoutMs: 1_800_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      filters: {
        conjunction: "and",
        items: [{ fieldName: "A", operator: "isGreater", value: 25_000 }],
      },
      expectedRowCount: 25_000,
    },
    threshold: { metric: "getRecordsQueryOverheadMs", maxMs: 30_000 },
  },
});
