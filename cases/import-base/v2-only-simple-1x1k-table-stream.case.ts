import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "import-base/v2-only-simple-1x1k-table-stream",
  title:
    "V2-only: import one 1k-record table through the product stream endpoint",
  runner: "import-base",
  expectedSkipEngines: ["v1"],
  timeoutMs: 600_000,
  runtimeEnv: {
    PRISMA_TRANSACTION_TIMEOUT: 30_000,
  },
  config: {
    spaceId: "seed-space",
    sourceBaseNamePrefix: "perf-import-base-v2-simple-1x1k-table",
    tables: [
      {
        name: "Simple Table 1k",
        rowCount: 1_000,
        batchSize: 1_000,
        generator: {
          titlePrefix: "Simple Import Item",
          payloadPrefix: "Import base simple table",
          source: "perf-lab-import-base-simple-flat",
        },
      },
    ],
    workflows: {
      count: 0,
      namePrefix: "perf-import-base-simple-wf",
    },
    verify: {
      sampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
    },
    threshold: {
      metric: "importBaseStreamMs",
      // Calibrated 2026-06-22 from 38 CI runs (v1+v2, Apr-Jun 2026): p95 ~313ms,
      // worst ~387ms. Sub-second metric floored at 2_000ms (not 2x worst) to keep
      // headroom for CI variance on a noisy small metric (was 120_000).
      maxMs: 2_000,
    },
  },
});
