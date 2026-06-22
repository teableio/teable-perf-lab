import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "import-base/v2-only-complex-3x10k-3tables-2workflow-stream",
  title:
    "V2-only: import three 10k-record tables with workflows through the product stream endpoint",
  runner: "import-base",
  timeoutMs: 1_200_000,
  runtimeEnv: {
    PRISMA_TRANSACTION_TIMEOUT: 30_000,
  },
  config: {
    spaceId: "seed-space",
    sourceBaseNamePrefix: "perf-import-base-v2-complex-3x10k-3tables",
    tables: [
      {
        name: "Table A 10k",
        rowCount: 10_000,
        batchSize: 1_000,
        generator: {
          titlePrefix: "Table A Item",
          payloadPrefix: "Import base table A",
          source: "perf-lab-import-base-flat-a",
        },
      },
      {
        name: "Table B 10k",
        rowCount: 10_000,
        batchSize: 1_000,
        generator: {
          titlePrefix: "Table B Item",
          payloadPrefix: "Import base table B",
          source: "perf-lab-import-base-flat-b",
        },
      },
      {
        name: "Table C 10k",
        rowCount: 10_000,
        batchSize: 1_000,
        generator: {
          titlePrefix: "Table C Item",
          payloadPrefix: "Import base table C",
          source: "perf-lab-import-base-flat-c",
        },
      },
    ],
    workflows: {
      count: 2,
      namePrefix: "perf-import-base-wf",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      fullScanPageSize: 1_000,
      timeoutMs: 180_000,
      pollIntervalMs: 2_000,
    },
    threshold: {
      metric: "importBaseStreamMs",
      // Calibrated 2026-06-22 from 38 CI runs (v1+v2, Apr-Jun 2026): p95 ~5704ms,
      // worst ~6126ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 300_000).
      maxMs: 15_000,
    },
  },
});
