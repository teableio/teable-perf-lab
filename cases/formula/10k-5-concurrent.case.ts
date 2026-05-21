import { FieldType } from "@teable/core";
import { definePerfCase } from "../framework/types";

export default definePerfCase({
  id: "formula/10k-5-concurrent",
  title: "10k rows concurrent 5 formula calculations",
  runner: "formula-table",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-formula-10k-5",
    recordCount: 10_000,
    batchSize: 1_000,
    fields: [
      {
        name: "Title",
        type: FieldType.SingleLineText,
      },
      {
        name: "A",
        type: FieldType.Number,
      },
      {
        name: "B",
        type: FieldType.Number,
      },
      {
        name: "C",
        type: FieldType.Number,
      },
    ],
    generator: {
      type: "numeric-sequence",
      titlePrefix: "Formula row",
    },
    formulas: [
      {
        name: "Total 1",
        expression: "({A} * {B}) + {C}",
        expected: "aTimesBPlusC",
      },
      {
        name: "Total 2",
        expression: "{A} + {B} + {C}",
        expected: "aPlusBPlusC",
      },
      {
        name: "Total 3",
        expression: "({A} * {C}) + {B}",
        expected: "aTimesCPlusB",
      },
      {
        name: "Total 4",
        expression: "{A} + ({B} * {C})",
        expected: "aPlusBTimesC",
      },
      {
        name: "Total 5",
        expression: "({A} * 3) + ({B} * 5) + ({C} * 7)",
        expected: "weightedABC",
      },
    ],
    verify: {
      sampleRows: [0, 4_999, 9_999],
    },
    threshold: {
      metric: "formulasReadyMs",
      maxMs: 15_000,
    },
  },
});
