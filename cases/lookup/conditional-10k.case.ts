import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "lookup/conditional-10k",
  title: "10k x 10k conditional lookup",
  runner: "conditional-lookup",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    sourceTableNamePrefix: "perf-conditional-lookup-source-10k",
    hostTableNamePrefix: "perf-conditional-lookup-host-10k",
    recordCount: 10_000,
    batchSize: 1_000,
    generator: {
      type: "matching-key-sequence",
      keyPrefix: "CL-Key",
      sourceValuePrefix: "CL-Value",
    },
    lookup: {
      name: "Matched Value",
      limit: 1,
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 120_000,
      pollIntervalMs: 500,
    },
    threshold: {
      metric: "conditionalLookupReadyMs",
      maxMs: 120_000,
    },
  },
});
