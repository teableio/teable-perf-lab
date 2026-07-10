import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";
export default definePerfCase({
  id: "lookup/conditional-group-number-top3-10k",
  title: "10k conditional lookup, top 3 numbers per row",
  runner: "conditional-query",
  timeoutMs: 300_000,
  config: {
    ...groupedConditionalQueryBase,
    field: {
      kind: "lookup",
      name: "Top 3 Group Amounts",
      valueField: "amount",
      filter: "group",
      sort: { field: "amount", order: "desc" },
      limit: 3,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
