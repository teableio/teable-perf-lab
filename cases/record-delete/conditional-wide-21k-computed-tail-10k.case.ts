import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-delete/conditional-wide-21k-computed-tail-10k",
  title:
    "V2-only: delete the last 10,000 wide rows of 21k, matched by a filter with computed fields",
  runner: "record-conditional-write",
  routingEvidence: "not-applicable",
  expectedSkipEngines: ["v1"],
  timeoutMs: 1_800_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-delete-where-wide-computed-tail-10k",
    operation: "delete",
    selector: "filter",
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
    computed: { groupCount: 200, readyTimeoutMs: 600_000 },
    threshold: { metric: "recordWriteReadyMs", maxMs: 600_000 },
  },
});
