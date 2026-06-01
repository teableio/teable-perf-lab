import { definePerfCase } from "../../framework/types";
import { undoRedo10kBaseConfig } from "../../framework/runners/record-undo-redo.shared";

export default definePerfCase({
  id: "record-redo/delete-1k",
  title: "Redo a 1k mixed-record selection delete",
  runner: "record-redo",
  timeoutMs: 900_000,
  config: {
    ...undoRedo10kBaseConfig,
    rowCount: 1_000,
    tableNamePrefix: "perf-record-redo-delete-1k",
    verify: {
      ...undoRedo10kBaseConfig.verify,
      sampleRows: [0, 499, 999],
    },
    threshold: {
      metric: "redoReplay1kMs",
      maxMs: 90_000,
    },
  },
});
