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
      // Local v1/v2 runs measured p95 ~41ms; 5s still leaves ~120x headroom
      // while catching order-of-magnitude regressions.
      maxMs: 5_000,
    },
  },
});
