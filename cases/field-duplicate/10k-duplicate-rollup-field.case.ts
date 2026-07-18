import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-duplicate/10k-duplicate-rollup-field",
  title: "Duplicate one ready many-many Rollup field across 10k rows",
  runner: "field-duplicate",
  timeoutMs: 1_800_000,
  watchdogMs: 600_000,
  config: {
    mode: "computed",
    computed: {
      kind: "rollup",
      sourceFieldName: "Amount Sum",
      expression: "sum({values})",
    },
    baseId: "seed-base",
    tableNamePrefix: "perf-field-duplicate-rollup-10k",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [{ name: "Title", type: FieldType.SingleLineText }],
    generator: {
      type: "mixed-undo-redo",
      titlePrefix: "Rollup duplicate row",
      payloadPrefix: "Rollup field duplicate",
      source: "perf-lab-field-duplicate-rollup",
    },
    link: {
      fieldName: "Related",
      relationship: "manyMany",
      isOneWay: false,
      foreignTable: {
        rowCount: 10_000,
        batchSize: 1_000,
        keyPrefix: "ROLLUP-FK",
        value: {
          name: "Amount",
          type: "number-sequence",
          multiplier: 7,
          offset: 3,
        },
      },
      permutation: { multiplier: 1, offset: 0 },
    },
    duplicate: { name: "Amount Sum Copy" },
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
