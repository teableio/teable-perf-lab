import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "lookup/dual-link-computed-repoint-4k",
  title:
    "Re-point 4k orders, await dual-link lookup + formula + cross-table rollup recompute",
  runner: "link-computed-propagation",
  timeoutMs: 1_800_000,
  watchdogMs: 300_000,
  config: {
    baseId: "seed-base",
    mode: "repoint",
    ordersTableNamePrefix: "perf-lookup-dual-link-repoint-4k",
    // 4k (not 10k): the V2 hybrid async path does not converge for 10k within a
    // practical window (see the case markdown "Notes"). 4k is the largest scale
    // that reliably converges in both sync and hybrid, so it is green in both.
    rowCount: 4_000,
    batchSize: 1_000,
    // Small measured-write batches so the V1 synchronous recompute path (which
    // recomputes the whole graph inside the write) stays under the request
    // timeout.
    writeBatchSize: 100,
    foreignRowCount: 4_000,
    foreignBatchSize: 1_000,
    purchase: {
      // Each purchase groups 10 consecutive orders; its rollups aggregate the
      // 10 children's recomputed values (second cascade hop).
      groupSize: 10,
    },
    link: {
      isOneWay: true,
      // Seed links order row i -> foreign i (identity) for both customer + guest.
      seedPermutation: { multiplier: 1, offset: 0 },
      // Measured write re-points order row i -> foreign ((i-1)*7+3)%4000+1.
      // multiplier 7 is coprime with 4000, so every link changes target and all
      // dependent lookups, formulas, and downstream rollups must recompute.
      updatePermutation: { multiplier: 7, offset: 3 },
    },
    verify: {
      sampleRows: [0, 1999, 3999],
      fullScanPageSize: 1_000,
      timeoutMs: 600_000,
      pollIntervalMs: 250,
    },
    threshold: {
      metric: "lookupReadyTotalMs",
      maxMs: 300_000,
    },
  },
});
