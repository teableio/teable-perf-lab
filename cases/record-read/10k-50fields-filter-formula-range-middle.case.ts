import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/10k-50fields-filter-formula-range-middle",
  title: "Range-filter a 10k 50-field read by a computed formula",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      filters: {
        conjunction: "and",
        items: [
          { fieldName: "Formula 4", operator: "isGreater", value: 8_000 },
          { fieldName: "Formula 4", operator: "isLessEqual", value: 23_000 },
        ],
      },
      expectedRowCount: 5_000,
    },
    threshold: { metric: "getRecordsQueryPagedScanMs", maxMs: 8_000 },
  },
});
