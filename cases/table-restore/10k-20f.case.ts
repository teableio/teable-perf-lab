import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "table-restore/10k-20f",
  title: "Restore a 10k-record mixed 20-field table from trash",
  runner: "table-restore",
  timeoutMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    tableNamePrefix: "perf-table-restore-10k-20f",
    generator: {
      ...recordReplay10kBaseConfig.generator,
      source: "perf-lab-table-restore",
    },
    samples: 10,
    threshold: {
      metric: "restoreTableP95Ms",
      // Calibrated 2026-06-22 from 148 CI runs (v1+v2, Apr-Jun 2026): p95 ~135ms,
      // worst ~180ms. Sub-second metric floored at 2_000ms (not 2x worst) to keep
      // headroom for CI variance on a noisy small metric (was 5_000).
      maxMs: 2_000,
    },
  },
});
