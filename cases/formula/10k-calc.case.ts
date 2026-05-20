import { FieldType } from "@teable/core";
import { definePerfCase } from "../framework/types";

export default definePerfCase({
  id: "formula/10k-calc",
  title: "10k rows formula calculation",
  runner: "formula-table",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-formula-10k",
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
    formula: {
      name: "Total",
      expression: "({A} * {B}) + {C}",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
    },
    threshold: {
      metric: "formulaReadyMs",
      maxMs: 60_000,
    },
  },
});
