import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";
export default definePerfCase({
  id: "lookup/conditional-group-text-fanout10-10k",
  title: "10k conditional lookup, 10 text matches per row",
  runner: "conditional-query",
  timeoutMs: 300_000,
  config: {
    ...groupedConditionalQueryBase,
    field: {
      kind: "lookup",
      name: "Group Text Values",
      valueField: "text",
      filter: "group",
      sort: { field: "amount", order: "asc" },
      limit: 10,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
