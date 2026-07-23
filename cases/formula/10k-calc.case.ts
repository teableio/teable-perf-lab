import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "formula/10k-calc",
  title: "10k rows formula calculation",
  runner: "formula-table",
  routingEvidence: "not-applicable",
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
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "formulaFullReadyMs",
      // Calibrated 2026-06-22 from 340 CI runs (v1+v2, Apr-Jun 2026): p95 ~2535ms,
      // worst ~2944ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 60_000).
      maxMs: 6_000,
    },
  },
});
