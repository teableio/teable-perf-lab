import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "lookup/dual-link-computed-first-link-1of4k-get-records",
  title:
    "First-link one of 4k orders, await lookup readiness through filtered getRecords",
  runner: "link-computed-propagation",
  timeoutMs: 600_000,
  watchdogMs: 300_000,
  config: {
    baseId: "seed-base",
    mode: "first-link",
    ordersTableNamePrefix: "perf-lookup-dual-link-first-link-1of4k-records",
    rowCount: 4_000,
    batchSize: 1_000,
    writeBatchSize: 100,
    foreignRowCount: 4_000,
    foreignBatchSize: 1_000,
    purchase: {
      groupSize: 10,
    },
    mutation: {
      startOffset: 1_999,
      recordCount: 1,
    },
    link: {
      isOneWay: true,
      seedPermutation: { multiplier: 1, offset: 0 },
      updatePermutation: { multiplier: 7, offset: 3 },
    },
    verify: {
      sampleRows: [0, 1_999, 3_999],
      readinessReadPath: "get-records",
      fullScanPageSize: 1_000,
      timeoutMs: 120_000,
      pollIntervalMs: 100,
    },
    threshold: {
      metric: "lookupPropagationMs",
      // The customer reported that API reads could still be empty after 10s.
      // Local V1/V2 hybrid measured 35ms/205ms, leaving ~49x margin while
      // turning that customer-visible 10s window into a regression failure.
      maxMs: 10_000,
    },
  },
});
