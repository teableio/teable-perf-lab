import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-restore/10k-active-field",
  title: "Restore one populated checkbox field on 10k rows",
  runner: "field-restore",
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-field-restore-10k-active",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "Active", type: FieldType.Checkbox },
    ],
    generator: {
      type: "mixed-undo-redo",
      titlePrefix: "Item",
      payloadPrefix: "Field restore",
      source: "perf-lab-field-restore-active",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      fullScanPageSize: 1_000,
    },
    restore: { fieldName: "Active" },
    threshold: { metric: "restoreFieldMs", maxMs: 120_000 },
  },
});
