import { Colors, FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

const choices = ["Todo", "Doing", "Done"].map((name, index) => ({
  name,
  color: [Colors.BlueBright, Colors.OrangeBright, Colors.GreenBright][index],
}));

export default definePerfCase({
  id: "field-convert/10k-single-select-to-text",
  title: "Convert a 10k-row single-select field to single-line text",
  runner: "field-convert",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-single-select-text",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "Status", type: FieldType.SingleSelect, options: { choices } },
    ],
    generator: { type: "field-convert-mixed", titlePrefix: "Convert row" },
    convert: {
      sourceFieldName: "Status",
      target: { type: FieldType.SingleLineText },
      expected: "singleSelectText",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 60_000,
      fullScanPageSize: 1_000,
    },
    threshold: { metric: "convertSingleSelectToTextReadyMs", maxMs: 15_000 },
  },
});
