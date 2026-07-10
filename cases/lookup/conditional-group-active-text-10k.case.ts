import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";
export default definePerfCase({
  id: "lookup/conditional-group-active-text-10k",
  title: "10k conditional lookup with dynamic group and active filter",
  runner: "conditional-query",
  timeoutMs: 300_000,
  config: {
    ...groupedConditionalQueryBase,
    field: {
      kind: "lookup",
      name: "Active Group Text Values",
      valueField: "text",
      filter: "group-and-active",
      sort: { field: "amount", order: "asc" },
      limit: 10,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
