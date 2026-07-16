import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "computed-outbox/observer-polling-ab-10k",
  title: "Computed Outbox observer A/B: 5 ms versus 50 ms on a 10k update",
  runner: "computed-outbox",
  timeoutMs: 720_000,
  config: {
    baseId: "seed-base",
    operation: "record-update",
    tableNamePrefix: "perf-outbox-observer-polling-ab-10k",
    recordCount: 10_000,
    batchSize: 1_000,
    formulaDepth: 4,
    updateCount: 10_000,
    scenario: {
      kind: "observer-polling-ab",
      treatmentOrder: [50, 5],
    },
    generator: {
      type: "numeric-sequence",
      titlePrefix: "Outbox observer A-B row",
      updateDelta: 100_000,
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 360_000,
      pollIntervalMs: 100,
      fullScanPageSize: 1_000,
    },
    outbox: {
      expectedInV2Hybrid: "task",
      expectedChangeType: "seed",
    },
    threshold: {
      metric: "computedOutboxObserverAbMaxReadyMs",
      maxMs: 180_000,
    },
  },
});
