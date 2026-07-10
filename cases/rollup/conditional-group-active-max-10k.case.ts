import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";
export default definePerfCase({
  id: "rollup/conditional-group-active-max-10k",
  title: "10k conditional rollup max with dynamic group and active filter",
  runner: "conditional-query",
  timeoutMs: 300_000,
  config: {
    ...groupedConditionalQueryBase,
    field: {
      kind: "rollup",
      name: "Active Group Maximum",
      valueField: "amount",
      filter: "group-and-active",
      expression: "max({values})",
      limit: 10,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
