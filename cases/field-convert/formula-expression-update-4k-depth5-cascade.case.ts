import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-convert/formula-expression-update-4k-depth5-cascade",
  title: "Update one head formula across a 4k depth-5 cascade",
  runner: "computed-chain-mutation",
  timeoutMs: 600_000,
  watchdogMs: 360_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-formula-expression-depth5-4k",
    mutation: "formula-expression",
    userCount: 40,
    orderCount: 4_000,
    ordersPerUser: 100,
    purchaseGroupSize: 10,
    targetUserRow: 20,
    batchSize: 1_000,
    userBatchSize: 100,
    verify: {
      sampleRows: [0, 1_999, 3_999],
      fullScanPageSize: 1_000,
      timeoutMs: 360_000,
      pollIntervalMs: 100,
    },
    threshold: {
      metric: "fullCascadeReadyTotalMs",
      maxMs: 180_000,
    },
  },
});
