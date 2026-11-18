import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-update/conditional-20k-no-match",
  title:
    "V2-only: update no rows of 20k, matched by a filter on an unindexed column",
  runner: "record-conditional-write",
  routingEvidence: "not-applicable",
  expectedSkipEngines: ["v1"],
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-update-where-no-match",
    operation: "update",
    selector: "filter",
    filterField: "plain",
    rowCount: 20_000,
    batchSize: 1_000,
    matchedRows: 0,
    threshold: { metric: "recordWriteReadyMs", maxMs: 120_000 },
  },
});
