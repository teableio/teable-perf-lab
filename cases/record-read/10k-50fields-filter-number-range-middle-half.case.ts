import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/10k-50fields-filter-number-range-middle-half",
  title: "Filter a 10k 50-field record read to a middle numeric range",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      filters: {
        conjunction: "and",
        items: [
          { fieldName: "A", operator: "isGreater", value: 2_500 },
          { fieldName: "A", operator: "isLessEqual", value: 7_500 },
        ],
      },
      expectedRowCount: 5_000,
    },
    threshold: { metric: "getRecordsQueryOverheadMs", maxMs: 8_000 },
  },
});
