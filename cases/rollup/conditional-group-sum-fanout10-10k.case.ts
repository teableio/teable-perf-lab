import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";
export default definePerfCase({
  id: "rollup/conditional-group-sum-fanout10-10k",
  title: "10k conditional rollup sum over 10 matches per row",
  runner: "conditional-query",
  timeoutMs: 300_000,
  config: {
    ...groupedConditionalQueryBase,
    field: {
      kind: "rollup",
      name: "Group Amount Sum",
      valueField: "amount",
      filter: "group",
      expression: "sum({values})",
      limit: 10,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
