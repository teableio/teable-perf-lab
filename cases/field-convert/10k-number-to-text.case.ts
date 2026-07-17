import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-convert/10k-number-to-text",
  title: "Convert a 10k-row number field to single-line text",
  runner: "field-convert",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-number-text",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      {
        name: "Amount",
        type: FieldType.Number,
        options: { formatting: { type: "decimal", precision: 0 } },
      },
    ],
    generator: { type: "field-convert-mixed", titlePrefix: "Convert row" },
    convert: {
      sourceFieldName: "Amount",
      target: { type: FieldType.SingleLineText },
      expected: "numberText",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 60_000,
      fullScanPageSize: 1_000,
    },
    threshold: { metric: "convertNumberToTextReadyMs", maxMs: 15_000 },
  },
});
