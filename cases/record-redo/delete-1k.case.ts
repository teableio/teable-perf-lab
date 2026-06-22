import { definePerfCase } from "../../framework/types";
import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";

export default definePerfCase({
  id: "record-redo/delete-1k",
  title: "Redo a 1k mixed-record selection delete",
  runner: "record-redo",
  timeoutMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    rowCount: 1_000,
    tableNamePrefix: "perf-record-redo-delete-1k",
    verify: {
      ...recordReplay10kBaseConfig.verify,
      sampleRows: [0, 499, 999],
    },
    threshold: {
      metric: "redoReplay1kMs",
      // Calibrated 2026-06-22 from 271 CI runs (v1+v2, Apr-Jun 2026): p95 ~379ms,
      // worst ~555ms. Sub-second metric floored at 2_000ms (not 2x worst) to keep
      // headroom for CI variance on a noisy small metric (was 90_000).
      maxMs: 2_000,
    },
  },
});
