import { Colors, FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

const selectChoices = (names: string[]) =>
  names.map((name, index) => ({
    name,
    color: [
      Colors.BlueBright,
      Colors.GreenBright,
      Colors.OrangeBright,
      Colors.PurpleBright,
    ][index % 4],
  }));

export default definePerfCase({
  id: "field-convert/10k-multi-select-to-text",
  title: "Convert a 10k-row multiple select field to single line text",
  runner: "field-convert",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-select-text",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      {
        name: "Tags",
        type: FieldType.MultipleSelect,
        options: {
          choices: selectChoices(["Alpha", "Beta", "Gamma", "Delta"]),
        },
      },
    ],
    generator: {
      type: "field-convert-mixed",
      titlePrefix: "Convert row",
    },
    convert: {
      sourceFieldName: "Tags",
      target: {
        type: FieldType.SingleLineText,
      },
      expected: "multiSelectJoinedText",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 60_000,
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "convertSelectToTextReadyMs",
      maxMs: 15_000,
    },
  },
});
