import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryFanout100Base } from "../conditional-query.shared";

export default definePerfCase({
  id: "lookup/conditional-group-text-update-1k-fanout100-10k",
  title: "10k conditional text lookup after 1k source updates",
  runner: "conditional-query",
  timeoutMs: 900_000,
  config: {
    ...groupedConditionalQueryFanout100Base,
    field: {
      kind: "lookup",
      name: "Group Text after 1k Source Updates",
      valueField: "text",
      filter: "group",
      sort: { field: "amount", order: "asc" },
      limit: 100,
    },
    mutation: {
      kind: "text-update",
      recordCount: 1_000,
      updatedSuffix: "updated",
    },
    threshold: {
      metric: "conditionalQueryPropagationReadyMs",
      maxMs: 120_000,
    },
  },
});
