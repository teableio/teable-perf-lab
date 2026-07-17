import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/10k-50fields-filter-number-sort-descending",
  title: "Filter and descending-sort a 10k 50-field record read",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      filters: {
        conjunction: "and",
        items: [{ fieldName: "A", operator: "isGreater", value: 5_000 }],
      },
      orderBy: [{ fieldName: "A", order: "desc" }],
      expectedRowCount: 5_000,
    },
    threshold: { metric: "getRecordsQueryOverheadMs", maxMs: 8_000 },
  },
});
