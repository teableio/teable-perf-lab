import { Colors, FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-convert/10k-text-to-single-select",
  title: "Convert 10k text values to single select",
  runner: "field-convert",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-text-single-select",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "Select Text", type: FieldType.SingleLineText },
    ],
    generator: { type: "field-convert-mixed", titlePrefix: "Convert row" },
    convert: {
      sourceFieldName: "Select Text",
      target: {
        type: FieldType.SingleSelect,
        options: {
          choices: [{ name: "Todo", color: Colors.BlueBright }],
        },
      },
      expected: "textSingleSelect",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 60_000,
      fullScanPageSize: 1_000,
      targetOptionNames: ["Todo", "Doing", "Done"],
    },
    threshold: {
      metric: "convertTextToSingleSelectReadyMs",
      maxMs: 15_000,
    },
  },
});
