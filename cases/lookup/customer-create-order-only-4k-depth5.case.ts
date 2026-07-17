import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "lookup/customer-create-order-only-4k-depth5",
  title: "Create one linked Order without a preceding User write",
  runner: "customer-upsert-computed-flow",
  timeoutMs: 420_000,
  watchdogMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-customer-create-order-only-4k-depth5",
    scenario: "create-order-only",
    userCount: 40,
    orderCount: 4_000,
    ordersPerUser: 100,
    purchaseGroupSize: 10,
    targetUserRow: 20,
    batchSize: 1_000,
    userBatchSize: 100,
    verify: {
      fullScanPageSize: 1_000,
      timeoutMs: 120_000,
      pollIntervalMs: 100,
      maxPostOrderResponseMs: 10_000,
      outboxPollIntervalMs: 50,
    },
    threshold: {
      metric: "customerFlowReadyTotalMs",
      maxMs: 30_000,
    },
  },
});
