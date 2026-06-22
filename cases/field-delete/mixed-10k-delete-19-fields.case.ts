import { recordReplayMixed20Fields } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

// Title stays as the primary field and cannot be deleted; the other 19 mixed
// fields are all deletable.
const deletableFieldNames = recordReplayMixed20Fields
  .filter((field) => field.name !== "Title")
  .map((field) => field.name);

export default definePerfCase({
  id: "field-delete/mixed-10k-delete-19-fields",
  title: "Delete 19 mixed fields from a 10k-row table in one bulk request",
  runner: "field-delete",
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-field-delete-mixed-10k-19fields",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: recordReplayMixed20Fields,
    generator: {
      type: "mixed-undo-redo",
      titlePrefix: "Item",
      payloadPrefix: "Field delete",
      source: "perf-lab-field-delete",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      fullScanPageSize: 1_000,
    },
    delete: {
      fieldNames: deletableFieldNames,
    },
    threshold: {
      metric: "delete19FieldsMs",
      // Calibrated 2026-06-22 from 178 CI runs (v1+v2, Apr-Jun 2026): p95 ~3929ms,
      // worst ~7755ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 120_000).
      maxMs: 20_000,
    },
  },
});
