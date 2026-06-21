import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "lookup/dual-link-computed-first-link-4k",
  title:
    "First-link 4k orders, await dual-link lookup + formula + cross-table rollup recompute",
  runner: "link-computed-propagation",
  timeoutMs: 1_800_000,
  watchdogMs: 300_000,
  config: {
    baseId: "seed-base",
    mode: "first-link",
    ordersTableNamePrefix: "perf-lookup-dual-link-first-link-4k",
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
      // first-link seeds no customer/guest link, so seedPermutation is unused;
      // kept for config symmetry with the repoint variant.
      seedPermutation: { multiplier: 1, offset: 0 },
      // Measured write links order row i -> foreign ((i-1)*7+3)%4000+1.
      // multiplier 7 is coprime with 4000 so the mapping is a permutation.
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
      // COARSE guardrail to catch the 10k-class non-convergence / 2x+ regression
      // shape — NOT a tight perf SLA. Genuine non-convergence already times out
      // at verify.timeoutMs (600s), so this only needs margin over normal noise.
      //
      // The V1 synchronous whole-graph recompute is high-variance. The original
      // 60s bound (calibrated at ~50.9s on run 27736047791) flaked on
      // environment noise: 2026-06-21 sampling of this exact case over 11 v1 runs
      // measured lookupReadyTotalMs across 31–79s, and `main` alone reached 58.5s
      // (a near-miss), i.e. the breaches were CI-runner variance, not a code
      // regression. Raised to 120s ≈ 1.5x over the observed ~79s tail: it kills
      // the false failures while still flagging a real 2x+ blow-up or the
      // 10k-class non-convergence shape.
      //
      // If this fails again: first confirm the recompute genuinely regressed
      // (compare the measured value against this 31–79s band) before re-bumping.
      maxMs: 120_000,
    },
  },
});
