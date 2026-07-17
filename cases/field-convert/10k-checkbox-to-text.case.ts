import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-convert/10k-checkbox-to-text",
  title: "Convert a 10k-row checkbox field to single-line text",
  runner: "field-convert",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-checkbox-text",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "Active", type: FieldType.Checkbox },
    ],
    generator: { type: "field-convert-mixed", titlePrefix: "Convert row" },
    convert: {
      sourceFieldName: "Active",
      target: { type: FieldType.SingleLineText },
      expected: "checkboxText",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 60_000,
      fullScanPageSize: 1_000,
    },
    threshold: { metric: "convertCheckboxToTextReadyMs", maxMs: 15_000 },
  },
});
