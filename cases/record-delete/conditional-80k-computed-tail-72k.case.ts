import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-delete/conditional-80k-computed-tail-72k",
  title:
    "V2-only: delete the last 72,000 rows of 80k, matched by a filter on an unindexed column with computed fields",
  runner: "record-conditional-write",
  routingEvidence: "not-applicable",
  expectedSkipEngines: ["v1"],
  timeoutMs: 1_200_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-delete-where-80k-computed-tail-72k",
    operation: "delete",
    selector: "filter",
    filterField: "plain",
    rowCount: 80_000,
    batchSize: 1_000,
    matchedRows: 72_000,
    collaborator: {
      updateRows: 500,
      deleteRows: 500,
      responseTimeoutMs: 10_000,
      paceMs: 100,
    },
    computed: { groupCount: 200, readyTimeoutMs: 600_000 },
    threshold: { metric: "recordWriteReadyMs", maxMs: 30_000 },
  },
});
