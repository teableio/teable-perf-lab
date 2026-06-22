import { definePerfCase } from "../../framework/types";
import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";

export default definePerfCase({
  id: "record-delete/delete-1k",
  title: "Delete 1k mixed records through selection delete",
  runner: "record-delete",
  timeoutMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    rowCount: 1_000,
    tableNamePrefix: "perf-record-delete-1k",
    verify: {
      ...recordReplay10kBaseConfig.verify,
      sampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "delete1kMs",
      // Calibrated 2026-06-22 from 276 CI runs (v1+v2, Apr-Jun 2026): p95 ~563ms,
      // worst ~969ms. Sub-second metric floored at 2_000ms (not 2x worst) to keep
      // headroom for CI variance on a noisy small metric (was 30_000).
      maxMs: 2_000,
    },
  },
});
