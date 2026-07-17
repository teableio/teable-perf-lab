import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-convert/10k-text-to-auto-number",
  title: "Convert 10k text values to computed auto-number sequence",
  runner: "field-convert",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-text-auto-number",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "Sequence Text", type: FieldType.SingleLineText },
    ],
    generator: { type: "field-convert-mixed", titlePrefix: "Convert row" },
    convert: {
      sourceFieldName: "Sequence Text",
      target: { type: FieldType.AutoNumber, options: {} },
      expected: "autoNumberSequence",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 120_000,
      fullScanPageSize: 1_000,
      targetIsComputed: true,
    },
    threshold: {
      metric: "convertTextToAutoNumberReadyMs",
      maxMs: 30_000,
    },
  },
});
