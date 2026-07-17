import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/10k-50fields-filter-sort-formula-selective",
  title: "Filter and sort a 10k 50-field read by a computed formula",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      filters: {
        conjunction: "and",
        items: [
          { fieldName: "Formula 2", operator: "isGreater", value: 15_000 },
        ],
      },
      orderBy: [
        { fieldName: "Formula 2", order: "asc" },
        { fieldName: "A", order: "asc" },
      ],
      expectedRowCount: 5_173,
    },
    threshold: { metric: "getRecordsQueryPagedScanMs", maxMs: 8_000 },
  },
});
