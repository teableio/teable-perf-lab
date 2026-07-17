import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/10k-50fields-filter-lookup-not-empty",
  title: "Filter a 10k 50-field read by a non-empty computed lookup",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      filters: {
        conjunction: "and",
        items: [
          {
            fieldName: "Lookup Value 1",
            operator: "isNotEmpty",
            value: null,
          },
        ],
      },
      expectedRowCount: 10_000,
    },
    threshold: { metric: "getRecordsQueryPagedScanMs", maxMs: 8_000 },
  },
});
