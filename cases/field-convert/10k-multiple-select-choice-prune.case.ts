import { Colors, FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

const alphaChoiceId = "choBatch03Alpha";

export default definePerfCase({
  id: "field-convert/10k-multiple-select-choice-prune",
  title: "Rename one multiple-select choice and prune three across 10k rows",
  runner: "field-convert",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-multiple-select-prune",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      {
        name: "Tags",
        type: FieldType.MultipleSelect,
        options: {
          choices: [
            {
              id: alphaChoiceId,
              name: "Alpha",
              color: Colors.BlueBright,
            },
            {
              id: "choBatch03Beta",
              name: "Beta",
              color: Colors.GreenBright,
            },
            {
              id: "choBatch03Gamma",
              name: "Gamma",
              color: Colors.OrangeBright,
            },
            {
              id: "choBatch03Delta",
              name: "Delta",
              color: Colors.PurpleBright,
            },
          ],
        },
      },
    ],
    generator: { type: "field-convert-mixed", titlePrefix: "Convert row" },
    convert: {
      sourceFieldName: "Tags",
      target: {
        type: FieldType.MultipleSelect,
        options: {
          choices: [
            {
              id: alphaChoiceId,
              name: "Primary",
              color: Colors.CyanBright,
            },
          ],
        },
      },
      expected: "multipleSelectChoicePruned",
    },
    verify: {
      sampleRows: [0, 1, 2, 3, 4_999, 9_999],
      timeoutMs: 60_000,
      fullScanPageSize: 1_000,
      targetOptionNames: ["Primary"],
    },
    threshold: {
      metric: "convertMultipleSelectChoicesReadyMs",
      maxMs: 15_000,
    },
  },
});
