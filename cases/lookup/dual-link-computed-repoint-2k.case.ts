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
      // Total-ready (write + convergence), not propagation-only: the engines
      // place the same recompute work on opposite sides of the write response
      // (V1 synchronous inside the ~35s write, V2 async after a ~9s write), so
      // propagation-only structurally charged V2 for work V1 hid in its write
      // phase (2026-08-08 run 31248839861: propagation v1 0.4s / v2 7.0s while
      // total-ready v1 35.8s / v2 15.9s). lookupPropagationMs stays in metrics
      // for the async-window view.
      metric: "lookupReadyTotalMs",
      // Calibrated 2026-08-08 from runs 31241408467-31258824683: v1 total
      // ~35-36s, v2 total ~13-20s. ~2.5x margin over the v1 tail — a COARSE
      // non-convergence/blow-up guardrail in the first-link-4k style, not a
      // tight SLA.
      maxMs: 90_000,
    },
  },
});
