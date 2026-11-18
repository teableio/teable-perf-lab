import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-update/conditional-80k-indexed-tail-72k",
  title:
    "V2-only: update the last 72,000 rows of 80k, matched by a filter on an indexed column",
  runner: "record-conditional-write",
  routingEvidence: "not-applicable",
  expectedSkipEngines: ["v1"],
  timeoutMs: 1_200_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-update-where-80k-indexed-tail-72k",
    operation: "update",
    selector: "filter",
    filterField: "indexed",
    rowCount: 80_000,
    batchSize: 1_000,
    matchedRows: 72_000,
    collaborator: {
      updateRows: 500,
      deleteRows: 500,
      responseTimeoutMs: 10_000,
      paceMs: 100,
    },
    threshold: { metric: "recordWriteReadyMs", maxMs: 120_000 },
  },
});
