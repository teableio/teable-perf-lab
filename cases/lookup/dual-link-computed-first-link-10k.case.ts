import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "lookup/dual-link-computed-first-link-10k",
  title:
    "First-link 10k orders, await dual-link lookup + formula + cross-table rollup recompute",
  runner: "link-computed-propagation",
  timeoutMs: 1_200_000,
  watchdogMs: 300_000,
  config: {
    baseId: "seed-base",
    mode: "first-link",
    ordersTableNamePrefix: "perf-lookup-dual-link-first-link-10k",
    rowCount: 10_000,
    batchSize: 1_000,
    // Small measured-write batches so the V1 synchronous recompute path (which
    // recomputes the whole graph inside the write) stays under the request
    // timeout; a 1,000-row batch times out (408) on V1 at this graph depth.
    writeBatchSize: 100,
    foreignRowCount: 10_000,
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
      // Measured write links order row i -> foreign ((i-1)*7+3)%10000+1.
      // multiplier 7 is coprime with 10000 so the mapping is a permutation.
      updatePermutation: { multiplier: 7, offset: 3 },
    },
    verify: {
      sampleRows: [0, 4999, 9999],
      fullScanPageSize: 1_000,
      timeoutMs: 300_000,
      pollIntervalMs: 250,
    },
    threshold: {
      metric: "lookupReadyTotalMs",
      maxMs: 300_000,
    },
  },
});
