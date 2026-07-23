import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "lookup/foreign-select-flip-1of40-fanout100-4k",
  title: "Flip one foreign select and await its 100-order computed fanout",
  runner: "computed-chain-mutation",
  seedAffinity: "computed-chain/4k-depth5",
  timeoutMs: 420_000,
  watchdogMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-lookup-foreign-select-fanout100-4k",
    mutation: "foreign-select",
    userCount: 40,
    orderCount: 4_000,
    ordersPerUser: 100,
    purchaseGroupSize: 10,
    targetUserRow: 20,
    batchSize: 1_000,
    userBatchSize: 100,
    verify: {
      sampleRows: [0, 1_899, 1_900, 1_999, 2_000, 3_999],
      fullScanPageSize: 1_000,
      timeoutMs: 360_000,
      pollIntervalMs: 100,
      maxPostResponseMs: 10_000,
    },
    threshold: {
      metric: "firstOrderReadyTotalMs",
      maxMs: 15_000,
    },
  },
});
