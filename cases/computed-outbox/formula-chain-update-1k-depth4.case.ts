import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "computed-outbox/formula-chain-update-1k-depth4",
  title: "Computed Outbox seed task: update 1k through a depth-4 formula chain",
  runner: "computed-outbox",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    operation: "record-update",
    tableNamePrefix: "perf-outbox-formula-update-1k-depth4",
    recordCount: 1_000,
    batchSize: 1_000,
    formulaDepth: 4,
    updateCount: 1_000,
    generator: {
      type: "numeric-sequence",
      titlePrefix: "Outbox formula control row",
      updateDelta: 100_000,
    },
    verify: {
      sampleRows: [0, 499, 999],
      timeoutMs: 60_000,
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
      maxMs: 30_000,
    },
  },
});
