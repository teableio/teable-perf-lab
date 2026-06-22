import { definePerfCase } from "../../framework/types";
import { recordReorderMixed10kBaseConfig } from "../../framework/runners/record-reorder.runner";

export default definePerfCase({
  id: "record-reorder/10k-move-last-1k-to-front",
  title: "Move the last 1k records to the front of a 10k mixed table",
  runner: "record-reorder",
  timeoutMs: 900_000,
  config: {
    ...recordReorderMixed10kBaseConfig,
    tableNamePrefix: "perf-record-reorder-10k-move-last-1k-to-front",
    reorder: {
      blockStartOffset: 9_000,
      blockSize: 1_000,
      anchorOffset: 0,
      position: "before",
    },
    threshold: {
      metric: "moveLast1kToFrontMs",
      // Calibrated 2026-06-22 from 251 CI runs (v1+v2, Apr-Jun 2026): p95 ~1603ms,
      // worst ~2237ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 90_000).
      maxMs: 5_000,
    },
  },
});
