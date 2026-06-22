import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "lookup/conditional-10k",
  title: "10k x 10k unique-key conditional lookup",
  runner: "conditional-lookup",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    sourceTableNamePrefix: "perf-conditional-lookup-source-10k",
    hostTableNamePrefix: "perf-conditional-lookup-host-10k",
    recordCount: 10_000,
    batchSize: 1_000,
    generator: {
      type: "permuted-unique-key-sequence",
      sourceKeyPrefix: "A-Key",
      hostKeyPrefix: "B-Key",
      sourceValuePrefix: "A-Value",
      permutation: {
        multiplier: 73,
        offset: 19,
      },
    },
    lookup: {
      name: "Matched A Value",
      limit: 1,
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 120_000,
      pollIntervalMs: 500,
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "conditionalLookupReadyMs",
      // Calibrated 2026-06-22 from 350 CI runs (v1+v2): p95 ~2.5s; v1 worst
      // ~2.8s, v2 worst ~1.5s recently with one early ~8.1s outlier. Guardrail
      // ~2.5x that outlier - catches a real regression without flaking (was
      // 120_000).
      maxMs: 20_000,
    },
  },
});
