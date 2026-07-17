import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/10k-50fields-group-stored-sort-lookup",
  title: "Group a 10k 50-field read and sort by a computed lookup",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      groupBy: [{ fieldName: "C", order: "asc" }],
      orderBy: [
        { fieldName: "Lookup Value 1", order: "desc" },
        { fieldName: "A", order: "asc" },
      ],
      expectedRowCount: 10_000,
    },
    threshold: { metric: "getRecordsQueryPagedScanMs", maxMs: 8_000 },
  },
});
