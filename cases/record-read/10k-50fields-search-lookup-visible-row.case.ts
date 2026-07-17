import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/10k-50fields-search-lookup-visible-row",
  title: "Search visible rows in a 10k 50-field read by computed lookup",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      search: {
        value: "1-03013",
        fieldName: "Lookup Value 1",
        hideNotMatchRow: true,
      },
      expectedRowCount: 1,
    },
    threshold: { metric: "getRecordsQueryPagedScanMs", maxMs: 8_000 },
  },
});
