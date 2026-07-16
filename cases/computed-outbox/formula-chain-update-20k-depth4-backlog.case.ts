import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "computed-outbox/formula-chain-update-20k-depth4-backlog",
  title:
    "Computed Outbox backlog: update 20,000 rows through a depth-4 formula chain",
  runner: "computed-outbox",
  timeoutMs: 420_000,
  config: {
    baseId: "seed-base",
    operation: "record-update",
    tableNamePrefix: "perf-outbox-formula-update-20k-depth4-backlog",
    recordCount: 20_000,
    batchSize: 1_000,
    formulaDepth: 4,
    updateCount: 20_000,
    generator: {
      type: "numeric-sequence",
      titlePrefix: "Outbox formula backlog row",
      updateDelta: 100_000,
    },
    verify: {
      sampleRows: [0, 9_999, 19_999],
      timeoutMs: 360_000,
      pollIntervalMs: 100,
      fullScanPageSize: 1_000,
    },
    outbox: {
      expectedInV2Hybrid: "task",
      expectedChangeType: "seed",
      minimumPeakPending: 2,
      pollIntervalMs: 5,
    },
    threshold: {
      metric: "computedOutboxPropagationReadyMs",
      maxMs: 180_000,
    },
  },
});
