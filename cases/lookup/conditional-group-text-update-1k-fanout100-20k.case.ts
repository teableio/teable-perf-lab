import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryFanout100Host20kBase } from "../conditional-query.shared";

export default definePerfCase({
  id: "lookup/conditional-group-text-update-1k-fanout100-20k",
  title: "20k conditional text lookup after 1k source updates",
  runner: "conditional-query",
  timeoutMs: 900_000,
  config: {
    ...groupedConditionalQueryFanout100Host20kBase,
    field: {
      kind: "lookup",
      name: "20k Group Text after 1k Source Updates",
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
      maxMs: 360_000,
    },
  },
});
