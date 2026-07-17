import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-restore/10k-owner-text-field",
  title: "Restore one populated single-line text field on 10k rows",
  runner: "field-restore",
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-field-restore-10k-owner-text",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "Owner Text", type: FieldType.SingleLineText },
    ],
    generator: {
      type: "mixed-undo-redo",
      titlePrefix: "Item",
      payloadPrefix: "Field restore",
      source: "perf-lab-field-restore-owner-text",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      fullScanPageSize: 1_000,
    },
    restore: { fieldName: "Owner Text" },
    threshold: { metric: "restoreFieldMs", maxMs: 120_000 },
  },
});
