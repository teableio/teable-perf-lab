import { definePerfCase } from "../../framework/types";
import baseCase from "../lookup/foreign-select-flip-1of40-fanout100-4k.case";

export default definePerfCase({
  id: "record-update/single-foreign-select-update-1of40-fanout100-4k",
  title:
    "Single-record select update through a 100-order, depth-5 computed fanout",
  runner: "computed-chain-mutation",
  timeoutMs: 420_000,
  watchdogMs: 300_000,
  config: {
    ...baseCase.config,
    tableNamePrefix: "perf-record-update-single-foreign-select-fanout100-4k",
    recordWriteMode: "single",
    threshold: {
      metric: "firstOrderReadyTotalMs",
      maxMs: 15_000,
    },
  },
});
