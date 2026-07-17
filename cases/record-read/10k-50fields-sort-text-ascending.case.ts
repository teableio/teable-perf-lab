import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/10k-50fields-sort-text-ascending",
  title: "Sort a 10k 50-field record read by text ascending",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      orderBy: [{ fieldName: "Text 1", order: "asc" }],
      expectedRowCount: 10_000,
    },
    threshold: { metric: "getRecordsQueryOverheadMs", maxMs: 8_000 },
  },
});
