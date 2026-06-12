import { undoRedoMixed20Fields } from "../../framework/runners/record-undo-redo.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "table-create/1x-20f-1k-records",
  title: "Create one mixed 20-field table with 1k inline records",
  runner: "table-create",
  timeoutMs: 600_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-table-create-1k-records",
    tableCount: 1,
    fields: undoRedoMixed20Fields,
    inlineRecords: {
      count: 1_000,
      titlePrefix: "Inline",
    },
    threshold: {
      metric: "createTable1x1kRecordsMs",
      // Unlike the no-records variant, the measured cost scales with the
      // inline record count (records are inserted as part of createTable).
      // Local v1/v2 verification on 2026-06-12 measured 1115.85 ms / 924.8 ms.
      maxMs: 10_000,
    },
  },
});
