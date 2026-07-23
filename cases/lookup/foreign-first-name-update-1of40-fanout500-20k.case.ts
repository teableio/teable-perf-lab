import { definePerfCase } from "../../framework/types";
import baseline from "./foreign-first-name-update-1of40-fanout100-4k.case";

export default definePerfCase({
  id: "lookup/foreign-first-name-update-1of40-fanout500-20k",
  title: "Edit one foreign text cell and await its 500-order computed fanout",
  runner: "computed-chain-mutation",
  seedAffinity: "computed-chain/20k-depth5",
  timeoutMs: 900_000,
  watchdogMs: 600_000,
  config: {
    ...baseline.config,
    tableNamePrefix: "perf-lookup-foreign-text-fanout500-20k",
    orderCount: 20_000,
    ordersPerUser: 500,
    verify: {
      ...baseline.config.verify,
      sampleRows: [0, 9_499, 9_500, 9_999, 10_000, 19_999],
      timeoutMs: 600_000,
      maxPostResponseMs: 30_000,
    },
    threshold: { metric: "firstOrderReadyTotalMs", maxMs: 60_000 },
  },
});
