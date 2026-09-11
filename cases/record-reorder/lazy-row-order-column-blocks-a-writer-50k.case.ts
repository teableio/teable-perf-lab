import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-reorder/lazy-row-order-column-blocks-a-writer-50k",
  title:
    "A row-order column built lazily on a 50k table, timed from the writer it blocks",
  runner: "blocked-writer",
  // The measured request is a bystander PATCH whose routing is asserted by the
  // runner it borrows, not by an engine contract of its own.
  routingEvidence: "not-applicable",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-blocked-writer-50k",
    recordCount: 50_000,
    batchSize: 1_000,
    trigger: {
      kind: "lazy-row-order-column",
      lockModes: ["AccessExclusiveLock"],
      lockWaitTimeoutMs: 150,
    },
    bystander: {
      kind: "single-cell-update",
    },
    threshold: {
      metric: "blockedWriterMs",
      maxMs: 60_000,
    },
  },
});
