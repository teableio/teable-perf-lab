import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-update/conditional-80k-no-match",
  title:
    "V2-only: update no rows of 80k, matched by a filter on an unindexed column",
  runner: "record-conditional-write",
  routingEvidence: "not-applicable",
  expectedSkipEngines: ["v1"],
  timeoutMs: 1_200_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-update-where-80k-no-match",
    operation: "update",
    selector: "filter",
    filterField: "plain",
    rowCount: 80_000,
    batchSize: 1_000,
    matchedRows: 0,
    collaborator: {
      updateRows: 500,
      deleteRows: 500,
      responseTimeoutMs: 10_000,
      paceMs: 100,
    },
    threshold: { metric: "recordWriteReadyMs", maxMs: 5_000 },
  },
});
