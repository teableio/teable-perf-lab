import { definePerfCase } from "../../framework/types";
import baseCase from "./flat-1k-20fields-cell-clear-stream.case";

export default definePerfCase({
  id: "selection-clear/flat-10k-20fields-cell-clear-stream",
  title: "Clear 10k rows across a 20-field table with selection stream",
  runner: "selection-clear",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    tableNamePrefix: "perf-selection-clear-flat-10k-20fields-cell-clear-stream",
    rowCount: 10_000,
    batchSize: 1_000,
    verify: {
      sampleRows: [0, 4_999, 9_999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "clear10kMs",
      // Initial scale guardrail; tighten after local and CI history.
      maxMs: 60_000,
    },
  },
});
