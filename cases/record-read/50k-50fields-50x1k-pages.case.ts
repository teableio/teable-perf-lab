import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-50fields-10x1k-pages.case";

export default definePerfCase({
  id: "record-read/50k-50fields-50x1k-pages",
  title:
    "Read a 50k table through fifty 1k-record pages with 50 projected fields",
  runner: "record-read",
  timeoutMs: 1_800_000,
  watchdogMs: 300_000,
  config: {
    ...baseCase.config,
    sourceTableNamePrefix: "perf-record-read-source-50k-50fields",
    tableNamePrefix: "perf-record-read-host-50k-50fields",
    rowCount: 50_000,
    verify: {
      sampleRows: [0, 999, 24_999, 49_999],
      timeoutMs: 600_000,
      pollIntervalMs: 1_000,
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "getRecords50kPagedScanMs",
      // Initial scale guardrail; tighten after local and CI history.
      maxMs: 60_000,
    },
  },
});
