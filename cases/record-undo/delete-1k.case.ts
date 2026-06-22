import { definePerfCase } from "../../framework/types";
import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";

export default definePerfCase({
  id: "record-undo/delete-1k",
  title: "Undo a 1k mixed-record selection delete",
  runner: "record-undo",
  timeoutMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    rowCount: 1_000,
    tableNamePrefix: "perf-record-undo-delete-1k",
    verify: {
      sampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "undoReplay1kMs",
      // Calibrated 2026-06-22 from 250 CI runs (v1+v2, Apr-Jun 2026): p95 ~2264ms,
      // worst ~2476ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 90_000).
      maxMs: 5_000,
    },
  },
});
