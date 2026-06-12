import { undoRedo10kBaseConfig } from "../../framework/runners/record-undo-redo.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "table-delete/10k-20f",
  title: "Archive a 10k-record mixed 20-field table to trash",
  runner: "table-delete",
  timeoutMs: 900_000,
  config: {
    ...undoRedo10kBaseConfig,
    tableNamePrefix: "perf-table-delete-10k-20f",
    generator: {
      ...undoRedo10kBaseConfig.generator,
      source: "perf-lab-table-delete",
    },
    threshold: {
      metric: "deleteTableRequestMs",
      maxMs: 30_000,
    },
  },
});
