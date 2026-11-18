import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-delete/conditional-20k-by-ids-tail-18k",
  title: "V2-only: delete the last 18,000 rows of 20k, listed by record id",
  runner: "record-conditional-write",
  routingEvidence: "not-applicable",
  expectedSkipEngines: ["v1"],
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-delete-where-by-ids-tail-18k",
    operation: "delete",
    selector: "recordIds",
    filterField: "plain",
    rowCount: 20_000,
    batchSize: 1_000,
    matchedRows: 18_000,
    threshold: { metric: "recordWriteReadyMs", maxMs: 120_000 },
  },
});
