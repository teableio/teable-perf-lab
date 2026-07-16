import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "computed-outbox/formula-chain-update-1k-depth8",
  title: "Computed Outbox: update 1k through a depth-8 formula chain",
  runner: "computed-outbox",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    operation: "record-update",
    tableNamePrefix: "perf-outbox-formula-update-1k-depth8",
    recordCount: 1_000,
    batchSize: 1_000,
    formulaDepth: 8,
    updateCount: 1_000,
    generator: {
      type: "numeric-sequence",
      titlePrefix: "Outbox formula cumulative row",
      updateDelta: 100_000,
    },
    verify: {
      sampleRows: [0, 499, 999],
      timeoutMs: 120_000,
      pollIntervalMs: 100,
      fullScanPageSize: 1_000,
    },
    outbox: {
      expectedInV2Hybrid: "task",
      expectedChangeType: "seed",
      pollIntervalMs: 5,
    },
    threshold: {
      metric: "computedOutboxPropagationReadyMs",
      maxMs: 60_000,
    },
  },
});
