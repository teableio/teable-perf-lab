import { definePerfCase } from "../../framework/types";
import { compositeKeyConditionalQueryBase } from "../conditional-query.shared";

export default definePerfCase({
  id: "rollup/conditional-composite-key-sum-fanout10-10k",
  title: "10k conditional rollup sum keyed by group and code",
  runner: "conditional-query",
  seedAffinity: "conditional-query/fanout10-host10k-composite",
  timeoutMs: 300_000,
  config: {
    ...compositeKeyConditionalQueryBase,
    field: {
      kind: "rollup",
      name: "Composite Key Amount Sum",
      valueField: "amount",
      filter: "group-and-code",
      expression: "sum({values})",
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
