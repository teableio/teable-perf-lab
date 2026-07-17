import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/10k-50fields-sort-lookup-ascending",
  title: "Sort a 10k 50-field read by a computed lookup",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      orderBy: [
        { fieldName: "Lookup Value 1", order: "asc" },
        { fieldName: "A", order: "asc" },
      ],
      expectedRowCount: 10_000,
    },
    threshold: { metric: "getRecordsQueryPagedScanMs", maxMs: 8_000 },
  },
});
