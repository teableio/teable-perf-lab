import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "table-delete/10k-20f",
  title: "Archive a 10k-record mixed 20-field table to trash",
  runner: "table-delete",
  timeoutMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    tableNamePrefix: "perf-table-delete-10k-20f",
    generator: {
      ...recordReplay10kBaseConfig.generator,
      source: "perf-lab-table-delete",
    },
    samples: 10,
    threshold: {
      metric: "deleteTableP95Ms",
      // Local v1/v2 runs measured p95 ~39ms; 2s still leaves ~50x headroom
      // while catching order-of-magnitude regressions.
      maxMs: 2_000,
    },
  },
});
