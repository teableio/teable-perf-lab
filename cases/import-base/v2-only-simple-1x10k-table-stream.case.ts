import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "import-base/v2-only-simple-1x10k-table-stream",
  title:
    "V2-only: import one 10k-record table through the product stream endpoint",
  runner: "import-base",
  timeoutMs: 900_000,
  runtimeEnv: {
    PRISMA_TRANSACTION_TIMEOUT: 30_000,
  },
  config: {
    spaceId: "seed-space",
    sourceBaseNamePrefix: "perf-import-base-v2-simple-1x10k-table",
    tables: [
      {
        name: "Simple Table 10k",
        rowCount: 10_000,
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
      sampleRows: [0, 4_999, 9_999],
      fullScanPageSize: 1_000,
      timeoutMs: 120_000,
      pollIntervalMs: 1_000,
    },
    threshold: {
      metric: "importBaseStreamMs",
      // Initial 10k scale guardrail; tighten after CI history establishes variance.
      maxMs: 10_000,
    },
  },
});
