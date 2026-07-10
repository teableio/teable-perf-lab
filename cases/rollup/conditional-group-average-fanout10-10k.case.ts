import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";
export default definePerfCase({
  id: "rollup/conditional-group-average-fanout10-10k",
  title: "10k conditional rollup average over 10 matches per row",
  runner: "conditional-query",
  timeoutMs: 300_000,
  config: {
    ...groupedConditionalQueryBase,
    field: {
      kind: "rollup",
      name: "Group Amount Average",
      valueField: "amount",
      filter: "group",
      expression: "average({values})",
      limit: 10,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
