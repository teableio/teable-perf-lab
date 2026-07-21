import { definePerfCase } from "../../framework/types";
import baseline from "./foreign-select-flip-1of40-fanout100-4k.case";

export default definePerfCase({
  id: "lookup/foreign-select-flip-1of40-fanout500-20k",
  title: "Flip one foreign select and await its 500-order computed fanout",
  runner: "computed-chain-mutation",
  timeoutMs: 900_000,
  watchdogMs: 600_000,
  config: {
    ...baseline.config,
    tableNamePrefix: "perf-lookup-foreign-select-fanout500-20k",
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
