import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "duplicate-base/10k-3tables-link-2workflow",
  title:
    "Duplicate a base with a 10k main table, a 1k linked table, a small table and 2 workflows",
  runner: "duplicate-base",
  timeoutMs: 900_000,
  config: {
    spaceId: "seed-space",
    sourceBaseNamePrefix: "perf-duplicate-base-10k-3tables",
    mainTable: {
      name: "Main 10k",
      rowCount: 10_000,
      batchSize: 1_000,
      generator: {
        titlePrefix: "Item",
        payloadPrefix: "Duplicate base",
        source: "perf-lab-duplicate-base",
      },
    },
    linkedTable: {
      name: "Linked 1k",
      rowCount: 1_000,
      batchSize: 1_000,
      keyPrefix: "LINK",
      // 7 is coprime with 10,000, so every linked row maps to a distinct,
      // locally computable main row.
      permutation: {
        multiplier: 7,
        offset: 3,
      },
    },
    smallTable: {
      name: "Small 100",
      rowCount: 100,
      valuePrefix: "small",
    },
    workflows: {
      count: 2,
      namePrefix: "perf-duplicate-base-wf",
    },
    duplicate: {
      namePrefix: "perf-duplicate-base-copy",
      withRecords: true,
    },
    verify: {
      mainSampleRows: [0, 4_999, 9_999],
      linkSampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
      timeoutMs: 180_000,
      pollIntervalMs: 2_000,
    },
    threshold: {
      metric: "duplicateBaseRequestMs",
      // Calibrated 2026-06-22 from 162 CI runs (v1+v2, Apr-Jun 2026): p95 ~4883ms,
      // worst ~6307ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 180_000).
      maxMs: 15_000,
    },
  },
});
