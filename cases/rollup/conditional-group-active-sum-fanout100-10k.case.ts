import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";

export default definePerfCase({
  id: "rollup/conditional-group-active-sum-fanout100-10k",
  title: "10k conditional active amount sum with fanout 100",
  runner: "conditional-query",
  timeoutMs: 900_000,
  config: {
    ...groupedConditionalQueryBase,
    sourceTableNamePrefix: "perf-conditional-query-source-100k",
    hostTableNamePrefix: "perf-conditional-query-host-10k-fanout100",
    sourceRecordCount: 100_000,
    verify: {
      ...groupedConditionalQueryBase.verify,
      timeoutMs: 600_000,
    },
    field: {
      kind: "rollup",
      name: "Active Group Amount Sum Fanout 100",
      valueField: "amount",
      filter: "group-and-active",
      expression: "sum({values})",
      limit: 100,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
