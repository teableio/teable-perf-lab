import { definePerfCase } from "../../framework/types";
import baseCase from "./50k-50fields-50x1k-pages.case";

export default definePerfCase({
  id: "record-read/50k-50fields-search-title-visible-rows",
  title: "Search visible rows in a 50k 50-field record read by title",
  runner: "record-read",
  seedAffinity: "record-read/50k-50fields",
  timeoutMs: 1_800_000,
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
    threshold: { metric: "getRecordsQueryOverheadMs", maxMs: 30_000 },
  },
});
