import { Colors, FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-convert/10k-text-to-multiple-select",
  title: "Convert 10k comma-list text values to multiple select",
  runner: "field-convert",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-text-multiple-select",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "Multi Text", type: FieldType.SingleLineText },
    ],
    generator: { type: "field-convert-mixed", titlePrefix: "Convert row" },
    convert: {
      sourceFieldName: "Multi Text",
      target: {
        type: FieldType.MultipleSelect,
        options: {
          choices: [
            { name: "Alpha", color: Colors.BlueBright },
            { name: "Beta", color: Colors.GreenBright },
          ],
        },
      },
      expected: "textMultipleSelect",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 60_000,
      fullScanPageSize: 1_000,
      targetOptionNames: ["Alpha", "Beta", "Gamma", "Delta"],
    },
    threshold: {
      metric: "convertTextToMultipleSelectReadyMs",
      maxMs: 15_000,
    },
  },
});
