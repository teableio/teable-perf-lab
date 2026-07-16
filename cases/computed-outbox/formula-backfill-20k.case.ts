import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "computed-outbox/formula-backfill-20k",
  title: "Computed Outbox: backfill a formula on 20k populated rows",
  runner: "computed-outbox",
  timeoutMs: 600_000,
  watchdogMs: 180_000,
  config: {
    baseId: "seed-base",
    operation: "field-backfill",
    tableNamePrefix: "perf-outbox-formula-backfill-20k",
    recordCount: 20_000,
    batchSize: 1_000,
    formulaDepth: 1,
    generator: {
      type: "numeric-sequence",
      titlePrefix: "Outbox formula backfill row",
      updateDelta: 100_000,
    },
    verify: {
      sampleRows: [0, 9_999, 19_999],
      timeoutMs: 300_000,
      pollIntervalMs: 200,
      fullScanPageSize: 1_000,
    },
    outbox: {
      expectedInV2Hybrid: "task",
      expectedChangeType: "field-backfill",
      pollIntervalMs: 10,
    },
    threshold: {
      metric: "computedOutboxBackfillReadyMs",
      maxMs: 120_000,
    },
  },
});
