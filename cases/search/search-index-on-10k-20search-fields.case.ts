import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "search/search-index-on-10k-20search-fields",
  title: "10k lookup global search with table search index",
  runner: "lookup-search-index",
  timeoutMs: 600_000,
  config: {
    baseId: "seed-base",
    sourceTableNamePrefix: "perf-lookup-search-index-source-10k",
    hostTableNamePrefix: "perf-lookup-search-index-host-10k",
    tableIndexMode: "on",
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
        name: "lookup-key-two-hit",
        value: "A-Key-9999",
        expectedHitCount: 2,
        expectedFieldGroup: "lookup-key",
      },
      {
        name: "own-text-one-hit",
        value: "HostText1-Value-9522",
        expectedHitCount: 1,
        expectedFieldGroup: "own-text",
      },
      {
        name: "own-select-capped-hit",
        value: "Todo",
        expectedMinHitCount: 100,
        expectedFieldGroup: "own-select",
      },
      {
        name: "lookup-select-capped-hit",
        value: "Alpha",
        expectedMinHitCount: 100,
        expectedFieldGroup: "lookup-select",
      },
      {
        name: "own-multi-select-capped-hit",
        value: "North",
        expectedMinHitCount: 100,
        expectedFieldGroup: "own-multiple-select",
      },
      {
        name: "lookup-multi-select-capped-hit",
        value: "Red",
        expectedMinHitCount: 100,
        expectedFieldGroup: "lookup-multiple-select",
      },
      {
        name: "user-capped-hit",
        value: "perf_lookup_user_0",
        expectedMinHitCount: 100,
        expectedFieldGroup: "user",
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
