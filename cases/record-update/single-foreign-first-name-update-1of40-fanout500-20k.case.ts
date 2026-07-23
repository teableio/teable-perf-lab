import { definePerfCase } from "../../framework/types";
import baseline from "../lookup/foreign-first-name-update-1of40-fanout500-20k.case";

export default definePerfCase({
  id: "record-update/single-foreign-first-name-update-1of40-fanout500-20k",
  title:
    "Single-record text update through a 500-order, depth-5 computed fanout",
  runner: "computed-chain-mutation",
  seedAffinity: "computed-chain/20k-depth5",
  timeoutMs: 900_000,
  watchdogMs: 600_000,
  config: {
    ...baseline.config,
    tableNamePrefix: "perf-record-update-single-foreign-text-fanout500-20k",
    recordWriteMode: "single",
    threshold: { metric: "firstOrderReadyTotalMs", maxMs: 60_000 },
  },
});
