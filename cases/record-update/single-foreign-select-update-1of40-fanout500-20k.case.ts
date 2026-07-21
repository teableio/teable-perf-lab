import { definePerfCase } from "../../framework/types";
import baseline from "../lookup/foreign-select-flip-1of40-fanout500-20k.case";

export default definePerfCase({
  id: "record-update/single-foreign-select-update-1of40-fanout500-20k",
  title:
    "Single-record select update through a 500-order, depth-5 computed fanout",
  runner: "computed-chain-mutation",
  timeoutMs: 900_000,
  watchdogMs: 600_000,
  config: {
    ...baseline.config,
    tableNamePrefix: "perf-record-update-single-foreign-select-fanout500-20k",
    recordWriteMode: "single",
    threshold: { metric: "firstOrderReadyTotalMs", maxMs: 60_000 },
  },
});
