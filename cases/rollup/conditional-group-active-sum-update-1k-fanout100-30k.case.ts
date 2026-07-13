import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryFanout100Host30kBase } from "../conditional-query.shared";

export default definePerfCase({
  id: "rollup/conditional-group-active-sum-update-1k-fanout100-30k",
  title: "30k conditional active sum after 1k source updates",
  runner: "conditional-query",
  timeoutMs: 900_000,
  config: {
    ...groupedConditionalQueryFanout100Host30kBase,
    field: {
      kind: "rollup",
      name: "30k Active Group Sum after 1k Source Updates",
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
      maxMs: 600_000,
    },
  },
});
