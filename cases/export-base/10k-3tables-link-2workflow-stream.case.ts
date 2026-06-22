import { definePerfCase } from "../../framework/types";
import duplicateBaseCase from "../duplicate-base/10k-3tables-link-2workflow.case";

export default definePerfCase({
  id: "export-base/10k-3tables-link-2workflow-stream",
  title: "Export a 10k 3-table linked base through the product stream endpoint",
  runner: "duplicate-base",
  timeoutMs: 900_000,
  config: {
    ...duplicateBaseCase.config,
    operation: "export-stream",
    sourceBaseNamePrefix: "perf-export-base-source-10k-3tables",
    threshold: {
      metric: "exportBaseStreamMs",
      // Calibrated 2026-06-22 from 84 CI runs (v1+v2, Apr-Jun 2026): p95 ~2123ms,
      // worst ~2616ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 180_000).
      maxMs: 6_000,
    },
  },
});
