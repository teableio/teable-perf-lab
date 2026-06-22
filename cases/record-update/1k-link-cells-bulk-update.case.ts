import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-update/1k-link-cells-bulk-update",
  title: "Bulk re-point 1k many-one link cells across records",
  runner: "record-update-link",
  timeoutMs: 600_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-record-update-1k-link-cells-bulk-update",
    rowCount: 1_000,
    batchSize: 1_000,
    linkFieldName: "Linked",
    foreignTable: {
      rowCount: 1_000,
      batchSize: 1_000,
      keyPrefix: "fk",
    },
    link: {
      isOneWay: true,
      // Seed links host row i -> foreign row i (identity).
      seedPermutation: { multiplier: 1, offset: 0 },
      // Measured update re-points host row i -> foreign ((i-1)*7+3)%1000+1.
      // multiplier 7 is coprime with 1000 so the new mapping is a permutation,
      // and no row keeps its seeded target, so every link cell changes.
      updatePermutation: { multiplier: 7, offset: 3 },
    },
    generator: {
      type: "link-record-update",
      titlePrefix: "Link row",
    },
    verify: {
      sampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "bulkUpdate1kLinkCellsMs",
      // Calibrated 2026-06-22 from 93 CI runs (v1+v2, Apr-Jun 2026): p95 ~4704ms,
      // worst ~5238ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 90_000).
      maxMs: 12_000,
    },
  },
});
