import { undoRedoMixed20Fields } from "../../framework/runners/record-undo-redo.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "table-create/10x-20f-no-records",
  title: "Create 10 mixed 20-field tables without records in one window",
  runner: "table-create",
  timeoutMs: 600_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-table-create-10x-20f",
    tableCount: 10,
    fields: undoRedoMixed20Fields,
    threshold: {
      metric: "createTables10xTotalMs",
      maxMs: 60_000,
    },
  },
});
