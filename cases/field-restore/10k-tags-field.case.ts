import { Colors, FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

const choices = ["Alpha", "Beta", "Gamma", "Delta"].map((name, index) => ({
  name,
  color: [
    Colors.BlueBright,
    Colors.GreenBright,
    Colors.OrangeBright,
    Colors.PurpleBright,
  ][index],
}));

export default definePerfCase({
  id: "field-restore/10k-tags-field",
  title: "Restore one populated multiple-select field on 10k rows",
  runner: "field-restore",
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-field-restore-10k-tags",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "Tags", type: FieldType.MultipleSelect, options: { choices } },
    ],
    generator: {
      type: "mixed-undo-redo",
      titlePrefix: "Item",
      payloadPrefix: "Field restore",
      source: "perf-lab-field-restore-tags",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      fullScanPageSize: 1_000,
    },
    restore: { fieldName: "Tags" },
    threshold: { metric: "restoreFieldMs", maxMs: 120_000 },
  },
});
