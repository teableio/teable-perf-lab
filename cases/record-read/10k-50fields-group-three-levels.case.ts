import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/10k-50fields-group-three-levels",
  title: "Group a 10k 50-field record read across three levels",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      groupBy: [
        { fieldName: "C", order: "asc" },
        { fieldName: "B", order: "desc" },
        { fieldName: "A", order: "asc" },
      ],
      expectedRowCount: 10_000,
    },
    threshold: { metric: "getRecordsQueryOverheadMs", maxMs: 8_000 },
  },
});
