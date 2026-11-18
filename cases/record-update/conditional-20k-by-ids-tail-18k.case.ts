import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-update/conditional-20k-by-ids-tail-18k",
  title: "V2-only: update the last 18,000 rows of 20k, listed by record id",
  runner: "record-conditional-write",
  routingEvidence: "not-applicable",
  expectedSkipEngines: ["v1"],
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-update-where-by-ids-tail-18k",
    operation: "update",
    selector: "recordIds",
    filterField: "plain",
    rowCount: 20_000,
    batchSize: 1_000,
    matchedRows: 18_000,
    threshold: { metric: "recordWriteReadyMs", maxMs: 120_000 },
  },
});
