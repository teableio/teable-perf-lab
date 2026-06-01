import { definePerfCase } from "../../framework/types";
import { undoRedo10kBaseConfig } from "../../framework/runners/record-undo-redo.shared";

export default definePerfCase({
  id: "record-delete/delete-1k",
  title: "Delete 1k mixed records through selection delete",
  runner: "record-delete",
  timeoutMs: 900_000,
  config: {
    ...undoRedo10kBaseConfig,
    rowCount: 1_000,
    tableNamePrefix: "perf-record-delete-1k",
    verify: {
      sampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "delete1kMs",
      maxMs: 30_000,
    },
  },
});
