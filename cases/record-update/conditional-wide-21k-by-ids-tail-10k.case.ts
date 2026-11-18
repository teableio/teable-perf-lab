import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-update/conditional-wide-21k-by-ids-tail-10k",
  title:
    "V2-only: update the last 10,000 wide rows of 21k, listed by record id",
  runner: "record-conditional-write",
  routingEvidence: "not-applicable",
  expectedSkipEngines: ["v1"],
  timeoutMs: 1_800_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-update-where-wide-by-ids-tail-10k",
    operation: "update",
    selector: "recordIds",
    filterField: "plain",
    rowCount: 21_000,
    batchSize: 100,
    matchedRows: 10_000,
    payloadBytes: 32_768,
    collaborator: {
      updateRows: 500,
      deleteRows: 500,
      responseTimeoutMs: 10_000,
      paceMs: 100,
    },
    threshold: { metric: "recordWriteReadyMs", maxMs: 600_000 },
  },
});
