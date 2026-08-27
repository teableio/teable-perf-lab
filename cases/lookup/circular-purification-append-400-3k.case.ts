import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "lookup/circular-purification-append-400-3k",
  title:
    "Append 400 purification rows in sequential bulk batches and await every host sub-order",
  runner: "circular-link-propagation",
  timeoutMs: 1_800_000,
  // A healthy run keeps polling readiness every 250 ms; only true server
  // silence trips this.
  watchdogMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-lookup-circular-append-3k",
    // Same incident fixture as circular-dual-link-source-update-10of500-3k.
    orderRowCount: 6_000,
    subOrderRowCount: 3_000,
    purificationRowCount: 500,
    plasmidRowCount: 3,
    batchSize: 500,
    purificationBatchSize: 100,
    // The measured operation: 400 new purification rows (p = 501..900, the
    // same injective permutation) in FOUR sequential POST batches of 100 —
    // the write-burst shape from the 2026-08-27 CN incident base. Each batch
    // wires all four link cells per row, so each batch's inline computed run
    // races the previous batch's dispatched outbox task on the table
    // advisory lock under the hybrid strategy.
    writeBatchSize: 100,
    orderPermutation: { multiplier: 7, offset: 3 },
    purificationSubOrderPermutation: { multiplier: 13, offset: 5 },
    purificationOrderPermutation: { multiplier: 11, offset: 2 },
    mutation: { startOffset: 0, recordCount: 400, kind: "purification-append" },
    verify: {
      subOrderSampleRows: [5, 18, 2_999],
      purificationSampleRows: [0, 249, 499],
      fullScanPageSize: 1_000,
      timeoutMs: 600_000,
      pollIntervalMs: 250,
    },
    threshold: {
      metric: "circularPropagationReadyMs",
      // Sync-mode runs land in the tens of seconds. A hybrid-mode run on an
      // engine that loses a batch's propagation (computed:run:failed
      // lock_unavailable with an empty outbox) never converges and dies at
      // verify.timeoutMs instead.
      maxMs: 120_000,
    },
  },
});
