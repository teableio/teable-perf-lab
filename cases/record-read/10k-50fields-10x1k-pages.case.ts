import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-read/10k-50fields-10x1k-pages",
  title:
    "Read a 10k table through ten 1k-record pages with 50 projected fields",
  runner: "record-read",
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    sourceTableNamePrefix: "perf-record-read-source-10k-50fields",
    tableNamePrefix: "perf-record-read-host-10k-50fields",
    rowCount: 10_000,
    batchSize: 1_000,
    pageSize: 1_000,
    skip: 0,
    simpleTextFieldCount: 20,
    formulaFieldCount: 5,
    lookupFieldCount: 20,
    generator: {
      type: "record-read-lookup-formula",
      titlePrefix: "Read row",
      textPrefix: "Read text",
      sourceKeyPrefix: "Read-Key",
      sourceValuePrefix: "Read-Value",
      permutation: {
        multiplier: 73,
        offset: 19,
      },
    },
    verify: {
      sampleRows: [0, 499, 999, 4_999, 9_999],
      timeoutMs: 180_000,
      pollIntervalMs: 1_000,
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "getRecords10kPagedScanMs",
      // Calibrated 2026-06-22 from 159 CI runs (v1+v2, Apr-Jun 2026): p95 ~3787ms,
      // worst ~4359ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 30_000).
      maxMs: 10_000,
    },
  },
});
