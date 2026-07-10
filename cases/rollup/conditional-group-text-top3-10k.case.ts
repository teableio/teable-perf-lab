import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";
export default definePerfCase({
  id: "rollup/conditional-group-text-top3-10k",
  title: "10k conditional rollup array-join over top 3 matches",
  runner: "conditional-query",
  timeoutMs: 300_000,
  config: {
    ...groupedConditionalQueryBase,
    field: {
      kind: "rollup",
      name: "Top 3 Group Text",
      valueField: "text",
      filter: "group",
      expression: "array_join({values})",
      sort: { field: "amount", order: "desc" },
      limit: 3,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
