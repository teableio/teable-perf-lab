import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-duplicate/10k-duplicate-conditional-rollup-field",
  title: "Duplicate one ready 10k x 10k Conditional Rollup field",
  runner: "field-duplicate",
  timeoutMs: 300_000,
  config: {
    mode: "computed",
    computed: { kind: "conditionalRollup" },
    baseId: "seed-base",
    sourceTableNamePrefix: "perf-field-duplicate-crollup-source-10k",
    hostTableNamePrefix: "perf-field-duplicate-crollup-host-10k",
    recordCount: 10_000,
    batchSize: 1_000,
    generator: {
      type: "permuted-unique-key-sequence",
      sourceKeyPrefix: "A-Key",
      hostKeyPrefix: "B-Key",
      sourceValuePrefix: "A-Value",
      permutation: { multiplier: 73, offset: 19 },
    },
    rollup: {
      name: "Joined A Value",
      expression: "array_join({values})",
      limit: 1,
    },
    duplicate: { name: "Joined A Value Copy" },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 120_000,
      pollIntervalMs: 500,
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "computedFieldDuplicateReadyMs",
      maxMs: 12_000,
    },
  },
});
