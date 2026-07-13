import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";

export default definePerfCase({
  id: "lookup/conditional-group-text-fanout50-10k",
  title: "10k conditional text lookup with fanout 50",
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
      name: "Group Text Values Fanout 50",
      valueField: "text",
      filter: "group",
      sort: { field: "amount", order: "asc" },
      limit: 50,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
