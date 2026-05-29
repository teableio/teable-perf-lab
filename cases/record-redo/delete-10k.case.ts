import { definePerfCase } from "../../framework/types";
import { undoRedo10kBaseConfig } from "../../framework/runners/record-undo-redo.shared";

export default definePerfCase({
  id: "record-redo/delete-10k",
  title: "Redo a 10k mixed-record selection delete",
  runner: "record-redo",
  timeoutMs: 900_000,
  config: {
    ...undoRedo10kBaseConfig,
    tableNamePrefix: "perf-record-redo-delete-10k",
    threshold: {
      metric: "redoReplay10kMs",
      maxMs: 90_000,
    },
  },
});
