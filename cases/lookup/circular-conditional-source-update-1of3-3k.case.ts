import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "lookup/circular-conditional-source-update-1of3-3k",
  title:
    "Edit one plasmid conditional-lookup source cell and await the whole-graph circular fanout",
  runner: "circular-link-propagation",
  timeoutMs: 1_800_000,
  // Same rationale as the sibling circular case: a healthy run keeps polling
  // readiness every 250 ms, so only true server silence trips this.
  watchdogMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-lookup-circular-cond-src-3k",
    // Same incident fixture as circular-dual-link-source-update-10of500-3k
    // (Orders 6287 / SubOrders 3031 / Purification 477 / Plasmid 3).
    orderRowCount: 6_000,
    subOrderRowCount: 3_000,
    purificationRowCount: 500,
    plasmidRowCount: 3,
    batchSize: 500,
    purificationBatchSize: 100,
    writeBatchSize: 10,
    orderPermutation: { multiplier: 7, offset: 3 },
    purificationSubOrderPermutation: { multiplier: 13, offset: 5 },
    purificationOrderPermutation: { multiplier: 11, offset: 2 },
    // The T7002 trigger: ONE cell on the 3-row conditional-lookup source
    // table. Plasmid 1 is referenced by the conditional lookups of a third of
    // all SubOrders and the plain lookups of a third of all Purification, so
    // the dirty-state preparation covers ~1,000 + ~167 rows plus the circular
    // SubOrders <-> Purification echo before the request returns (pre-fix).
    mutation: { startOffset: 0, recordCount: 1, kind: "plasmid-total" },
    verify: {
      // Offsets 5 and 18 keep parity with the sibling case; 2999 covers the
      // empty-purification-lookup branch.
      subOrderSampleRows: [5, 18, 2_999],
      purificationSampleRows: [0, 249, 499],
      fullScanPageSize: 1_000,
      // ~1,000 sub-orders are affected; poll an even sample inside the
      // primary timer and leave completeness to the post-metric full scans.
      readinessSampleLimit: 20,
      timeoutMs: 600_000,
      pollIntervalMs: 250,
    },
    threshold: {
      metric: "circularPropagationReadyMs",
      // Pre-T7002 (teable-ee <= b913e5014) the dirty-state preparation runs
      // the conditional target scan inline in the user transaction and this
      // metric blows far past the bound (or the PATCH itself hangs); with the
      // fix the whole-table work is bounded/queued and readiness lands well
      // under it. Calibrate against CI history once it exists.
      maxMs: 120_000,
    },
  },
});
