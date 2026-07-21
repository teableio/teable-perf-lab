import { definePerfCase } from "../../framework/types";
import baseCase from "./50k-50fields-50x1k-pages.case";

export default definePerfCase({
  id: "record-read/50k-50fields-sort-three-fields",
  title: "Sort a 50k 50-field record read by three fields",
  runner: "record-read",
  timeoutMs: 1_800_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      orderBy: [
        { fieldName: "C", order: "asc" },
        { fieldName: "B", order: "desc" },
        { fieldName: "A", order: "asc" },
      ],
      expectedRowCount: 50_000,
    },
    threshold: { metric: "getRecordsQueryOverheadMs", maxMs: 30_000 },
  },
});
