import { definePerfCase } from "../../framework/types";
import { undoRedo10kBaseConfig } from "../../framework/runners/record-undo-redo.shared";

export default definePerfCase({
  id: "record-undo/delete-10k",
  title: "Undo a 10k mixed-record selection delete",
  runner: "record-undo",
  timeoutMs: 900_000,
  config: {
    ...undoRedo10kBaseConfig,
    tableNamePrefix: "perf-record-undo-delete-10k",
    threshold: {
      metric: "undoReplay10kMs",
      maxMs: 120_000,
    },
  },
});
