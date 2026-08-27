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
    // wires all four link cells per row, so every batch triggers the full
    // cross-table computed cascade. This case runs in the V2 SYNC pool and
    // guards the burst-insert propagation cost; the hybrid-mode propagation
    // LOSS this shape also reproduces (T7002 / T7018) is guarded by
    // teable-e2e-lab lookup/a-burst-of-new-rows-reaches-every-lookup.
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
      // Calibrated from the first CI acceptance run (33088879155):
      // v1 24,898 ms, v2 17,592 ms — ~4x the slower engine (v2 alone gets
      // ~5.7x). Local full-scale v2 sync measured ~13 s; the four sequential
      // 100-row POST batches dominate, so the bound must absorb CI I/O
      // variance on ~25 s of work while still catching a burst-insert
      // propagation blowup well before verify.timeoutMs.
      maxMs: 100_000,
    },
  },
});
