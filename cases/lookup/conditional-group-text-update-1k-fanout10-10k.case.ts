import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";

export default definePerfCase({
  id: "lookup/conditional-group-text-update-1k-fanout10-10k",
  title: "10k conditional text lookup after 1k updates, fanout 10",
  runner: "conditional-query",
  timeoutMs: 900_000,
  config: {
    ...groupedConditionalQueryBase,
    field: {
      kind: "lookup",
      name: "Group Text after 1k Source Updates Fanout 10",
      valueField: "text",
      filter: "group",
      sort: { field: "amount", order: "asc" },
      limit: 10,
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
