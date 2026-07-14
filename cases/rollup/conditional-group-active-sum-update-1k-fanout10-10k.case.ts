import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";

export default definePerfCase({
  id: "rollup/conditional-group-active-sum-update-1k-fanout10-10k",
  title: "10k conditional active sum after 1k updates, fanout 10",
  runner: "conditional-query",
  timeoutMs: 900_000,
  config: {
    ...groupedConditionalQueryBase,
    field: {
      kind: "rollup",
      name: "Active Group Sum after 1k Source Updates Fanout 10",
      valueField: "amount",
      filter: "group-and-active",
      expression: "sum({values})",
      limit: 10,
    },
    mutation: {
      kind: "amount-update",
      recordCount: 1_000,
      amountDelta: 1_000_000,
    },
    threshold: {
      metric: "conditionalQueryPropagationReadyMs",
      maxMs: 120_000,
    },
  },
});
