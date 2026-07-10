import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";
export default definePerfCase({
  id: "rollup/conditional-group-countall-fanout10-10k",
  title: "10k conditional rollup count over 10 matches per row",
  runner: "conditional-query",
  timeoutMs: 300_000,
  config: {
    ...groupedConditionalQueryBase,
    field: {
      kind: "rollup",
      name: "Group Record Count",
      valueField: "text",
      filter: "group",
      expression: "countall({values})",
      limit: 10,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
