import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "lookup/circular-dual-link-source-update-10of500-3k",
  title:
    "Edit 10 purification number cells and await the circular dual-link sub-order cascade",
  runner: "circular-link-propagation",
  timeoutMs: 1_800_000,
  // The 2026-08-27 incident shape is a server that stops answering while a
  // storm UPDATE runs; a healthy run keeps polling readiness every 250 ms, so
  // only true server silence trips this.
  watchdogMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-lookup-circular-dual-link-3k",
    // Incident fingerprint scale (Orders 6287 / SubOrders 3031 / Purification
    // 477 / Plasmid 3), rounded to stable deterministic counts.
    orderRowCount: 6_000,
    subOrderRowCount: 3_000,
    purificationRowCount: 500,
    plasmidRowCount: 3,
    batchSize: 500,
    // Purification inserts write four link cells each (both duplicate
    // backrefs + plasmid + order) and trigger cross-table recompute per row,
    // so their seed batches stay small.
    purificationBatchSize: 100,
    // One measured request: the incident trigger was one bulk cell edit.
    writeBatchSize: 10,
    // multiplier 7 is coprime with 6000; every sub-order maps to a
    // deterministic order.
    orderPermutation: { multiplier: 7, offset: 3 },
    // multiplier 13 is coprime with 3000, so all 500 purifications attach to
    // distinct sub-orders (each sub-order carries 0 or 1 purification).
    purificationSubOrderPermutation: { multiplier: 13, offset: 5 },
    // multiplier 11 is coprime with 6000.
    purificationOrderPermutation: { multiplier: 11, offset: 2 },
    // Edit expression_mg_l on purification rows 1..10 (the incident edit was
    // a numeric expression cell on 表达-纯化).
    mutation: { startOffset: 0, recordCount: 10 },
    verify: {
      // Offsets 5 and 18 are sub-orders 6 and 19 = the linked hosts of
      // purifications 1 and 2 (inside the mutation window); offset 2999 is an
      // unlinked sub-order covering the empty-lookup branch.
      subOrderSampleRows: [5, 18, 2_999],
      purificationSampleRows: [0, 249, 499],
      fullScanPageSize: 1_000,
      timeoutMs: 600_000,
      pollIntervalMs: 250,
    },
    threshold: {
      metric: "circularPropagationReadyMs",
      // COARSE first-run guardrail (assumption, no CI history yet). A healthy
      // run touches ~10 purifications + ~10 sub-orders; the regression this
      // case exists for is the whole-graph storm recompute (25-minute UPDATE
      // in production), which either blows far past this bound or times out
      // at verify.timeoutMs. Tighten after real V1/V2 baselines land.
      maxMs: 120_000,
    },
  },
});
