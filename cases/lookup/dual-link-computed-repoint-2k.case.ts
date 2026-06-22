import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "lookup/dual-link-computed-repoint-2k",
  title:
    "Re-point 2k orders, await dual-link lookup + formula + cross-table rollup recompute",
  runner: "link-computed-propagation",
  timeoutMs: 1_800_000,
  watchdogMs: 300_000,
  config: {
    baseId: "seed-base",
    mode: "repoint",
    ordersTableNamePrefix: "perf-lookup-dual-link-repoint-2k",
    // Repoint is heavier than first-link because it invalidates old targets and
    // recomputes new targets plus purchase rollups. 2k is the largest confirmed
    // local hybrid-converging scale with comfortable margin.
    rowCount: 2_000,
    batchSize: 1_000,
    // Small measured-write batches so the V1 synchronous recompute path (which
    // recomputes the whole graph inside the write) stays under the request
    // timeout.
    writeBatchSize: 100,
    foreignRowCount: 2_000,
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
      // Measured write re-points order row i -> foreign ((i-1)*7+3)%2000+1.
      // multiplier 7 is coprime with 2000, so every link changes target and all
      // dependent lookups, formulas, and downstream rollups must recompute.
      updatePermutation: { multiplier: 7, offset: 3 },
    },
    verify: {
      sampleRows: [0, 999, 1999],
      fullScanPageSize: 1_000,
      timeoutMs: 600_000,
      pollIntervalMs: 250,
    },
    threshold: {
      metric: "lookupPropagationMs",
      // Calibrated 2026-06-22 from 53 CI runs (v1+v2) of lookupPropagationMs:
      // async path, v2 worst ~15.7s (p95 ~13.9s), v1 worst ~0.6s. Guardrail
      // ~2.5x v2 worst - extra margin for the async window, still 7.5x tighter
      // than the old 300_000. (Earlier runs measured a now-retired
      // lookupReadyTotalMs.)
      maxMs: 40_000,
    },
  },
});
