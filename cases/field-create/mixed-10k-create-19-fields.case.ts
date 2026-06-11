import { undoRedoMixed20Fields } from "../../framework/runners/record-undo-redo.shared";
import { definePerfCase } from "../../framework/types";

const baseFields = undoRedoMixed20Fields.filter(
  (field) => field.name === "Title",
);
const createFields = undoRedoMixed20Fields.filter(
  (field) => field.name !== "Title",
);

export default definePerfCase({
  id: "field-create/mixed-10k-create-19-fields",
  title: "Create 19 mixed fields on a 10k-row table",
  runner: "field-create",
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-field-create-mixed-10k-19fields",
    rowCount: 10_000,
    batchSize: 1_000,
    baseFields,
    fields: createFields,
    generator: {
      type: "title-sequence",
      titlePrefix: "Item",
    },
    verify: {
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "create19FieldsMs",
      maxMs: 180_000,
    },
  },
});
