import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";

export default definePerfCase({
  id: "lookup/conditional-group-text-fanout100-10k",
  title: "10k conditional text lookup with fanout 100",
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
      kind: "lookup",
      name: "Group Text Values Fanout 100",
      valueField: "text",
      filter: "group",
      sort: { field: "amount", order: "asc" },
      limit: 100,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
