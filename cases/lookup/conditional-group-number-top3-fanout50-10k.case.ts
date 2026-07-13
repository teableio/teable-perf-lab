import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";

export default definePerfCase({
  id: "lookup/conditional-group-number-top3-fanout50-10k",
  title: "10k conditional top-3 number lookup with fanout 50",
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
      kind: "lookup",
      name: "Top 3 Group Amounts Fanout 50",
      valueField: "amount",
      filter: "group",
      sort: { field: "amount", order: "desc" },
      limit: 3,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
