import { Colors, FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

const todoChoiceId = "choBatch03Todo";

export default definePerfCase({
  id: "field-convert/10k-single-select-choice-prune",
  title: "Rename one single-select choice and prune two across 10k rows",
  runner: "field-convert",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-single-select-prune",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      {
        name: "Status",
        type: FieldType.SingleSelect,
        options: {
          choices: [
            {
              id: todoChoiceId,
              name: "Todo",
              color: Colors.BlueBright,
            },
            {
              id: "choBatch03Doing",
              name: "Doing",
              color: Colors.OrangeBright,
            },
            {
              id: "choBatch03Done",
              name: "Done",
              color: Colors.GreenBright,
            },
          ],
        },
      },
    ],
    generator: { type: "field-convert-mixed", titlePrefix: "Convert row" },
    convert: {
      sourceFieldName: "Status",
      target: {
        type: FieldType.SingleSelect,
        options: {
          choices: [
            {
              id: todoChoiceId,
              name: "Planned",
              color: Colors.PurpleBright,
            },
          ],
        },
      },
      expected: "singleSelectChoicePruned",
    },
    verify: {
      sampleRows: [0, 1, 2, 4_999, 9_999],
      timeoutMs: 60_000,
      fullScanPageSize: 1_000,
      targetOptionNames: ["Planned"],
    },
    threshold: {
      metric: "convertSingleSelectChoicesReadyMs",
      maxMs: 15_000,
    },
  },
});
