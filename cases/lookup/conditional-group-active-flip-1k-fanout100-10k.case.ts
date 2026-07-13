import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryFanout100Base } from "../conditional-query.shared";

export default definePerfCase({
  id: "lookup/conditional-group-active-flip-1k-fanout100-10k",
  title: "10k conditional active lookup after 1k predicate flips",
  runner: "conditional-query",
  timeoutMs: 900_000,
  config: {
    ...groupedConditionalQueryFanout100Base,
    field: {
      kind: "lookup",
      name: "Active Group Text after 1k Predicate Flips",
      valueField: "text",
      filter: "group-and-active",
      sort: { field: "amount", order: "asc" },
      limit: 100,
    },
    mutation: { kind: "active-flip", recordCount: 1_000 },
    threshold: {
      metric: "conditionalQueryPropagationReadyMs",
      maxMs: 120_000,
    },
  },
});
