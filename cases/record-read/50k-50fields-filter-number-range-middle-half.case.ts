import { definePerfCase } from "../../framework/types";
import baseCase from "./50k-50fields-50x1k-pages.case";

export default definePerfCase({
  id: "record-read/50k-50fields-filter-number-range-middle-half",
  title: "Filter a 50k 50-field record read to a middle numeric range",
  runner: "record-read",
  timeoutMs: 1_800_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      filters: {
        conjunction: "and",
        items: [
          { fieldName: "A", operator: "isGreater", value: 12_500 },
          { fieldName: "A", operator: "isLessEqual", value: 37_500 },
        ],
      },
      expectedRowCount: 25_000,
    },
    threshold: { metric: "getRecordsQueryOverheadMs", maxMs: 30_000 },
  },
});
