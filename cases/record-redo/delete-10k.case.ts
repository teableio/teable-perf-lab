import { definePerfCase } from "../../framework/types";
import baseline from "./delete-1k.case";

export default definePerfCase({
  id: "record-redo/delete-10k",
  title: "Redo a 10k mixed-record selection delete",
  runner: "record-redo",
  timeoutMs: 1_800_000,
  watchdogMs: 600_000,
  config: {
    ...baseline.config,
    rowCount: 10_000,
    tableNamePrefix: "perf-record-redo-delete-10k",
    verify: {
      ...baseline.config.verify,
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 120_000,
      pollIntervalMs: 500,
    },
    threshold: { metric: "redoReplay10kMs", maxMs: 30_000 },
  },
});
