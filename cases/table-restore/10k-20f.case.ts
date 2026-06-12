import { undoRedo10kBaseConfig } from "../../framework/runners/record-undo-redo.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "table-restore/10k-20f",
  title: "Restore a 10k-record mixed 20-field table from trash",
  runner: "table-restore",
  timeoutMs: 900_000,
  config: {
    ...undoRedo10kBaseConfig,
    tableNamePrefix: "perf-table-restore-10k-20f",
    generator: {
      ...undoRedo10kBaseConfig.generator,
      source: "perf-lab-table-restore",
    },
    threshold: {
      metric: "restoreTableRequestMs",
      maxMs: 60_000,
    },
  },
});
