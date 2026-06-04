import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "lookup/search-index-off-10k-20search-fields",
  title: "10k lookup global search without table search index",
  runner: "lookup-search-index",
  timeoutMs: 600_000,
  config: {
    baseId: "seed-base",
    sourceTableNamePrefix: "perf-lookup-search-index-source-10k",
    hostTableNamePrefix: "perf-lookup-search-index-host-10k",
    tableIndexMode: "off",
    recordCount: 10_000,
    batchSize: 1_000,
    userCount: 10,
    samples: 30,
    generator: {
      type: "lookup-search-index-20-fields",
      sourceKeyPrefix: "A-Key",
      hostKeyPrefix: "B-Key",
      sourceTextPrefix: "A",
      permutation: {
        multiplier: 73,
        offset: 19,
      },
    },
    keywords: [
      {
        name: "lookup-text-one-hit",
        value: "A1-Value-9522",
        expectedHitCount: 1,
        expectedFieldGroup: "lookup-text",
      },
      {
        name: "lookup-key-five-hit",
        value: "A-Key-9999",
        expectedHitCount: 5,
        expectedFieldGroup: "lookup-key",
      },
      {
        name: "lookup-key-capped-hit",
        value: "A-Key-45",
        expectedMinHitCount: 100,
        expectedFieldGroup: "lookup-key",
      },
    ],
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 120_000,
      pollIntervalMs: 500,
    },
    threshold: {
      metric: "lookupSearchIndexP95Ms",
      maxMs: 1_500,
    },
  },
});
