import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "rollup/conditional-10k",
  title: "10k x 10k unique-key conditional rollup",
  runner: "conditional-rollup",
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
    rollup: {
      name: "Joined A Value",
      expression: "array_join({values})",
      limit: 1,
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 120_000,
      pollIntervalMs: 500,
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "conditionalRollupReadyMs",
      // Initial guardrail aligned with the paired conditional lookup case.
      // Tighten after local and CI V1/V2 history establishes the rollup p95.
      maxMs: 20_000,
    },
  },
});
