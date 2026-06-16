import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "import-base/3x1k-3tables-2workflow-stream",
  title: "Import three 1k-record tables through the product stream endpoint",
  runner: "import-base",
  timeoutMs: 1_200_000,
  runtimeEnv: {
    PRISMA_TRANSACTION_TIMEOUT: 30_000,
  },
  config: {
    spaceId: "seed-space",
    sourceBaseNamePrefix: "perf-import-base-3x1k-3tables",
    tables: [
      {
        name: "Table A 1k",
        rowCount: 1_000,
        batchSize: 1_000,
        generator: {
          titlePrefix: "Table A Item",
          payloadPrefix: "Import base table A",
          source: "perf-lab-import-base-flat-a",
        },
      },
      {
        name: "Table B 1k",
        rowCount: 1_000,
        batchSize: 1_000,
        generator: {
          titlePrefix: "Table B Item",
          payloadPrefix: "Import base table B",
          source: "perf-lab-import-base-flat-b",
        },
      },
      {
        name: "Table C 1k",
        rowCount: 1_000,
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
      sampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
      timeoutMs: 180_000,
      pollIntervalMs: 2_000,
    },
    threshold: {
      metric: "importBaseStreamMs",
      maxMs: 300_000,
    },
  },
});
