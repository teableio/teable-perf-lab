import { definePerfCase } from "../../framework/types";
import baseline from "./customer-update-user-control-field-create-order-4k-depth5.case";

export default definePerfCase({
  id: "lookup/customer-update-user-control-field-create-order-20k-depth5",
  title:
    "Update one non-computed User field, then create one linked Order on a 20k graph",
  runner: "customer-upsert-computed-flow",
  timeoutMs: 900_000,
  watchdogMs: 600_000,
  config: {
    ...baseline.config,
    tableNamePrefix:
      "perf-customer-update-user-control-field-create-order-20k-depth5",
    orderCount: 20_000,
    ordersPerUser: 500,
    verify: {
      ...baseline.config.verify,
      timeoutMs: 360_000,
      maxPostOrderResponseMs: 30_000,
    },
    threshold: { metric: "customerFlowReadyTotalMs", maxMs: 60_000 },
  },
});
