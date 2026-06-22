import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-create/10k-create-5-formula-fields",
  title: "Create 5 formula fields on a 10k-record table",
  runner: "field-create",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-field-create-formula-10k-5fields",
    rowCount: 10_000,
    batchSize: 1_000,
    baseFields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "A", type: FieldType.Number },
      { name: "B", type: FieldType.Number },
      { name: "C", type: FieldType.Number },
    ],
    fields: [
      {
        name: "Total 1",
        type: FieldType.Formula,
        options: { expression: "({A} * {B}) + {C}" },
      },
      {
        name: "Total 2",
        type: FieldType.Formula,
        options: { expression: "{A} + {B} + {C}" },
      },
      {
        name: "Total 3",
        type: FieldType.Formula,
        options: { expression: "({A} * {C}) + {B}" },
      },
      {
        name: "Total 4",
        type: FieldType.Formula,
        options: { expression: "{A} + ({B} * {C})" },
      },
      {
        name: "Total 5",
        type: FieldType.Formula,
        options: { expression: "({A} * 3) + ({B} * 5) + ({C} * 7)" },
      },
    ],
    generator: {
      type: "numeric-sequence",
      titlePrefix: "Formula row",
    },
    verify: {
      fullScanPageSize: 1_000,
    },
    ready: {
      metric: "computedBackfillReadyMs",
      timeoutMs: 30_000,
      pollIntervalMs: 200,
    },
    threshold: {
      metric: "create5ComputedFieldsMs",
      // Calibrated 2026-06-22 from 164 CI runs (v1+v2, Apr-Jun 2026): p95 ~6380ms,
      // worst ~6922ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 120_000).
      maxMs: 15_000,
    },
  },
});
