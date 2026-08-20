import { definePerfCase } from "../../framework/types";
import { compositeKeyConditionalQueryBase } from "../conditional-query.shared";

export default definePerfCase({
  id: "rollup/conditional-composite-key-sum-update-1k-fanout10-10k",
  title: "10k conditional sum keyed by group and code after 1k updates",
  runner: "conditional-query",
  seedAffinity: "conditional-query/fanout10-host10k-composite",
  timeoutMs: 900_000,
  config: {
    ...compositeKeyConditionalQueryBase,
    field: {
      kind: "rollup",
      name: "Composite Key Amount Sum after 1k Source Updates",
      valueField: "amount",
      filter: "group-and-code",
      expression: "sum({values})",
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
