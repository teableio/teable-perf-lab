import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-update/conditional-80k-by-ids-tail-20k",
  title: "V2-only: update the last 20,000 rows of 80k, listed by record id",
  runner: "record-conditional-write",
  routingEvidence: "not-applicable",
  expectedSkipEngines: ["v1"],
  timeoutMs: 1_200_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-update-where-80k-by-ids-tail-20k",
    operation: "update",
    selector: "recordIds",
    filterField: "plain",
    rowCount: 80_000,
    batchSize: 1_000,
    matchedRows: 20_000,
    collaborator: {
      updateRows: 500,
      deleteRows: 500,
      responseTimeoutMs: 10_000,
      paceMs: 100,
    },
    threshold: { metric: "recordWriteReadyMs", maxMs: 10_000 },
  },
});
