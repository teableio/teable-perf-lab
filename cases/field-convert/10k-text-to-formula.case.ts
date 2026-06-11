import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-convert/10k-text-to-formula",
  title: "Convert a 10k-row text field to a computed formula field",
  runner: "field-convert",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-text-formula",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "A", type: FieldType.Number },
      { name: "B", type: FieldType.Number },
      { name: "C", type: FieldType.Number },
      { name: "Total", type: FieldType.SingleLineText },
    ],
    generator: {
      type: "field-convert-mixed",
      titlePrefix: "Convert row",
    },
    convert: {
      sourceFieldName: "Total",
      target: {
        type: FieldType.Formula,
        options: {
          expression: "({A} * {B}) + {C}",
        },
      },
      expected: "aTimesBPlusC",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 60_000,
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "convertTextToFormulaReadyMs",
      maxMs: 15_000,
    },
  },
});
