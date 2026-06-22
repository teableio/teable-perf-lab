import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-3tables-link-2workflow.case";

export default definePerfCase({
  id: "duplicate-base/10k-3tables-link-2workflow-stream",
  title:
    "Duplicate a 10k 3-table linked base through the product stream endpoint",
  runner: "duplicate-base",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    operation: "duplicate-stream",
    duplicate: {
      ...baseCase.config.duplicate,
      namePrefix: "perf-duplicate-base-copy-stream",
    },
    threshold: {
      metric: "duplicateBaseStreamMs",
      // Calibrated 2026-06-22 from 84 CI runs (v1+v2, Apr-Jun 2026): p95 ~3822ms,
      // worst ~4073ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 180_000).
      maxMs: 10_000,
    },
  },
});
