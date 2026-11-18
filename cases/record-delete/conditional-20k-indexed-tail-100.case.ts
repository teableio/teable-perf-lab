import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-delete/conditional-20k-indexed-tail-100",
  title:
    "V2-only: delete the last 100 rows of 20k, matched by a filter on an indexed column",
  runner: "record-conditional-write",
  routingEvidence: "not-applicable",
  expectedSkipEngines: ["v1"],
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-delete-where-indexed-tail-100",
    operation: "delete",
    selector: "filter",
    filterField: "indexed",
    rowCount: 20_000,
    batchSize: 1_000,
    matchedRows: 100,
    threshold: { metric: "recordWriteReadyMs", maxMs: 120_000 },
  },
});
