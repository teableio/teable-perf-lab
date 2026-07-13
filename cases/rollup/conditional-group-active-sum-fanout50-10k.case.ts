import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";

export default definePerfCase({
  id: "rollup/conditional-group-active-sum-fanout50-10k",
  title: "10k conditional active amount sum with fanout 50",
  runner: "conditional-query",
  timeoutMs: 600_000,
  config: {
    ...groupedConditionalQueryBase,
    sourceTableNamePrefix: "perf-conditional-query-source-50k",
    hostTableNamePrefix: "perf-conditional-query-host-10k-fanout50",
    sourceRecordCount: 50_000,
    verify: {
      ...groupedConditionalQueryBase.verify,
      timeoutMs: 360_000,
    },
    field: {
      kind: "rollup",
      name: "Active Group Amount Sum Fanout 50",
      valueField: "amount",
      filter: "group-and-active",
      expression: "sum({values})",
      limit: 50,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
