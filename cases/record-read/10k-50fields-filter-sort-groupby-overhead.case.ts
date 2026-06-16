import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/10k-50fields-filter-sort-groupby-overhead",
  title:
    "Compare 10k 50-field record reads with and without filter, sort and groupBy",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    queryVariant: {
      filterFieldName: "Text 1",
      orderByFieldName: "A",
      groupByFieldName: "Text 2",
    },
    threshold: {
      metric: "getRecordsFilterSortGroupByOverheadMs",
      maxMs: 30_000,
    },
  },
});
