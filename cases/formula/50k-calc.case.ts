import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-calc.case";

export default definePerfCase({
  id: "formula/50k-calc",
  title: "50k rows formula calculation",
  runner: "formula-table",
  routingEvidence: "not-applicable",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  config: {
    ...baseCase.config,
    tableNamePrefix: "perf-formula-50k",
    recordCount: 50_000,
    verify: {
      sampleRows: [0, 24_999, 49_999],
      fullScanPageSize: 1_000,
      timeoutMs: 600_000,
      pollIntervalMs: 1_000,
    },
    threshold: {
      metric: "formulaFullReadyMs",
      // Initial scale guardrail; tighten after local and CI history.
      maxMs: 30_000,
    },
  },
});
