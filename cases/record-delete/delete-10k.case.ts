import { definePerfCase } from "../../framework/types";
import { undoRedo10kBaseConfig } from "../../framework/runners/record-undo-redo.shared";

export default definePerfCase({
  id: "record-delete/delete-10k",
  title: "Delete 10k mixed records through selection delete stream",
  runner: "record-delete",
  timeoutMs: 900_000,
  config: {
    ...undoRedo10kBaseConfig,
    tableNamePrefix: "perf-record-delete-10k",
    threshold: {
      metric: "delete10kMs",
      maxMs: 90_000,
    },
  },
});
