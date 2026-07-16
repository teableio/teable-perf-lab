import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "computed-outbox/bullmq-pause-recovery-20k",
  title: "Computed Outbox recovery: pause BullMQ during a 20k formula update",
  runner: "computed-outbox",
  timeoutMs: 480_000,
  config: {
    baseId: "seed-base",
    operation: "record-update",
    tableNamePrefix: "perf-outbox-bullmq-pause-recovery-20k",
    recordCount: 20_000,
    batchSize: 1_000,
    formulaDepth: 4,
    updateCount: 20_000,
    scenario: {
      kind: "bullmq-pause-recovery",
      holdMs: 3_000,
      evidencePollIntervalMs: 50,
    },
    generator: {
      type: "numeric-sequence",
      titlePrefix: "Outbox BullMQ recovery row",
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
      pollIntervalMs: 20,
    },
    threshold: {
      metric: "computedOutboxRecoveryReadyMs",
      maxMs: 180_000,
    },
  },
});
