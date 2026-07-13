import { definePerfCase } from "../../framework/types";
import { groupedConditionalQueryBase } from "../conditional-query.shared";

export default definePerfCase({
  id: "lookup/conditional-group-active-text-fanout100-10k",
  title: "10k conditional active text lookup with fanout 100",
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
      name: "Active Group Text Values Fanout 100",
      valueField: "text",
      filter: "group-and-active",
      sort: { field: "amount", order: "asc" },
      limit: 100,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 30_000 },
  },
});
