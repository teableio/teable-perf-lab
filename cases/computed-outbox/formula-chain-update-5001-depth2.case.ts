import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "computed-outbox/formula-chain-update-5001-depth2",
  title:
    "Computed Outbox split: update 5,001 rows through a depth-2 formula chain",
  runner: "computed-outbox",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    operation: "record-update",
    tableNamePrefix: "perf-outbox-formula-update-5001-depth2",
    recordCount: 5_001,
    batchSize: 1_000,
    formulaDepth: 2,
    updateCount: 5_001,
    generator: {
      type: "numeric-sequence",
      titlePrefix: "Outbox formula threshold row",
      updateDelta: 100_000,
    },
    verify: {
      sampleRows: [0, 2_500, 5_000],
      timeoutMs: 240_000,
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
      maxMs: 120_000,
    },
  },
});
