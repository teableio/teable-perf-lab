import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/10k-50fields-search-title-visible-rows",
  title: "Search visible rows in a 10k 50-field record read by title",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      search: {
        value: "00042",
        fieldName: "Title",
        hideNotMatchRow: true,
      },
      expectedRowCount: 1,
    },
    threshold: { metric: "getRecordsQueryOverheadMs", maxMs: 8_000 },
  },
});
