import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-duplicate/conditional-lookup-10k",
  title: "Duplicate a 10k x 10k conditional lookup field",
  runner: "field-duplicate",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    sourceTableNamePrefix: "perf-field-duplicate-lookup-source-10k",
    hostTableNamePrefix: "perf-field-duplicate-lookup-host-10k",
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
    duplicate: {
      name: "Matched A Value Copy",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 120_000,
      pollIntervalMs: 500,
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "conditionalLookupDuplicateReadyMs",
      maxMs: 6_000,
    },
  },
});
