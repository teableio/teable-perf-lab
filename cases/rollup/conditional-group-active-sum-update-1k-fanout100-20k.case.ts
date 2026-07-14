import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryFanout100Host20kBase } from "../conditional-query.shared";

export default definePerfCase({
  id: "rollup/conditional-group-active-sum-update-1k-fanout100-20k",
  title: "20k conditional active sum after 1k source updates",
  runner: "conditional-query",
  timeoutMs: 900_000,
  config: {
    ...groupedConditionalQueryFanout100Host20kBase,
    field: {
      kind: "rollup",
      name: "20k Active Group Sum after 1k Source Updates",
      valueField: "amount",
      filter: "group-and-active",
      expression: "sum({values})",
      limit: 100,
    },
    mutation: {
      kind: "amount-update",
      recordCount: 1_000,
      amountDelta: 1_000_000,
    },
    threshold: {
      metric: "conditionalQueryPropagationReadyMs",
      maxMs: 360_000,
    },
  },
});
