import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-duplicate/10k-duplicate-formula-field",
  title: "Duplicate one ready Formula field across 10k rows",
  runner: "field-duplicate",
  timeoutMs: 300_000,
  config: {
    mode: "computed",
    computed: { kind: "formula" },
    baseId: "seed-base",
    tableNamePrefix: "perf-field-duplicate-formula-10k",
    recordCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "A", type: FieldType.Number },
      { name: "B", type: FieldType.Number },
      { name: "C", type: FieldType.Number },
    ],
    generator: {
      type: "numeric-sequence",
      titlePrefix: "Formula duplicate row",
    },
    formula: {
      name: "Total",
      expression: "({A} * {B}) + {C}",
      expected: "aTimesBPlusC",
    },
    duplicate: { name: "Total Copy" },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 120_000,
      pollIntervalMs: 500,
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "computedFieldDuplicateReadyMs",
      // Initial safety bound; calibrate from the first official V1/V2 run.
      maxMs: 120_000,
    },
  },
});
