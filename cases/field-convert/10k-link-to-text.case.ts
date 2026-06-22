import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-convert/10k-link-to-text",
  title: "Convert a populated 10k-row many-one link field to single line text",
  runner: "field-convert-link",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-link-text",
    direction: "link-to-text",
    rowCount: 10_000,
    batchSize: 1_000,
    sourceFieldName: "Linked",
    foreignTable: {
      rowCount: 1_000,
      batchSize: 1_000,
      keyPrefix: "fk",
    },
    link: {
      isOneWay: true,
      // Host row i links to foreign row ((i-1)*7)%1000+1; multiplier 7 is
      // coprime with 1000 so the 10k host rows spread evenly over the 1k
      // foreign titles.
      permutation: { multiplier: 7, offset: 0 },
    },
    generator: {
      type: "field-convert-link",
      titlePrefix: "Convert row",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 60_000,
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "convertLinkToTextReadyMs",
      // Calibrated 2026-06-22 from 94 CI runs (v1+v2, Apr-Jun 2026): p95 ~2360ms,
      // worst ~2511ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 30_000).
      maxMs: 6_000,
    },
  },
});
