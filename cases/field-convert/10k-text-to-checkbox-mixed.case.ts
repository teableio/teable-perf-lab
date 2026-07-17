import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-convert/10k-text-to-checkbox-mixed",
  title: "Convert 10k populated and null text values to checkbox",
  runner: "field-convert",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-text-checkbox-mixed",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "Truthy Text", type: FieldType.SingleLineText },
    ],
    generator: { type: "field-convert-mixed", titlePrefix: "Convert row" },
    convert: {
      sourceFieldName: "Truthy Text",
      target: { type: FieldType.Checkbox },
      expected: "textCheckboxMixed",
    },
    verify: {
      sampleRows: [0, 1, 4_999, 9_999],
      timeoutMs: 60_000,
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "convertTextToCheckboxReadyMs",
      maxMs: 15_000,
    },
  },
});
