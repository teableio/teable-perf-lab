import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/10k-50fields-filter-text-not-empty",
  title: "Filter a 10k 50-field record read by non-empty text",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      filters: {
        conjunction: "and",
        items: [
          {
            fieldName: "Text 1",
            operator: "isNotEmpty",
            value: null,
          },
        ],
      },
      expectedRowCount: 10_000,
    },
    threshold: { metric: "getRecordsQueryOverheadMs", maxMs: 8_000 },
  },
});
