import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-update/conditional-20k-indexed-tail-18k",
  title:
    "V2-only: update the last 18,000 rows of 20k, matched by a filter on an indexed column",
  runner: "record-conditional-write",
  routingEvidence: "not-applicable",
  expectedSkipEngines: ["v1"],
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-update-where-indexed-tail-18k",
    operation: "update",
    selector: "filter",
    filterField: "indexed",
    rowCount: 20_000,
    batchSize: 1_000,
    matchedRows: 18_000,
    threshold: { metric: "recordWriteReadyMs", maxMs: 120_000 },
  },
});
