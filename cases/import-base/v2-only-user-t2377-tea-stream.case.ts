import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "import-base/v2-only-user-t2377-tea-stream",
  title:
    "V2-only: import the user-provided T2377 tea package through the product stream endpoint",
  runner: "import-base",
  expectedSkipEngines: ["v1"],
  timeoutMs: 600_000,
  runtimeEnv: {
    PRISMA_TRANSACTION_TIMEOUT: 30_000,
  },
  config: {
    spaceId: "seed-space",
    sourceBaseNamePrefix: "perf-import-base-v2-user-t2377",
    teaFile: {
      path: "cases/import-base/fixtures/T2377.tea",
      fileName: "T2377.tea",
      contentType: "application/zip",
    },
    tables: [
      {
        name: "全阶段报告",
        rowCount: 0,
        batchSize: 1,
        expectedFieldCount: 100,
        expectedViewCount: 1,
        generator: {
          titlePrefix: "T2377",
          payloadPrefix: "T2377",
          source: "user-provided-tea-package",
        },
      },
      {
        name: "培训名单汇总版",
        rowCount: 0,
        batchSize: 1,
        expectedFieldCount: 82,
        expectedViewCount: 7,
        generator: {
          titlePrefix: "T2377",
          payloadPrefix: "T2377",
          source: "user-provided-tea-package",
        },
      },
      {
        name: "培训报告一阶段",
        rowCount: 0,
        batchSize: 1,
        expectedFieldCount: 60,
        expectedViewCount: 1,
        generator: {
          titlePrefix: "T2377",
          payloadPrefix: "T2377",
          source: "user-provided-tea-package",
        },
      },
    ],
    workflows: {
      count: 1,
      namePrefix: "新自动化",
    },
    verify: {
      mode: "structure-only",
      sampleRows: [],
      expectedTableCount: 52,
      expectedAppCount: 1,
      timeoutMs: 120_000,
      pollIntervalMs: 2_000,
    },
    threshold: {
      metric: "importBaseStreamMs",
      // Calibrated 2026-06-22 from 38 CI runs (v1+v2, Apr-Jun 2026): p95 ~6147ms,
      // worst ~6876ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 180_000).
      maxMs: 15_000,
    },
  },
});
