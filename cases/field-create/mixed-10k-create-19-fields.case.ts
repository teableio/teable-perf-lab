import { recordReplayMixed20Fields } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

const baseFields = recordReplayMixed20Fields.filter(
  (field) => field.name === "Title",
);
const createFields = recordReplayMixed20Fields.filter(
  (field) => field.name !== "Title",
);

export default definePerfCase({
  id: "field-create/mixed-10k-create-19-fields",
  title: "Create 19 mixed fields on a 10k-row table",
  runner: "field-create",
  timeoutMs: 900_000,
  // Idle watchdog: creating one field on a 10k-row table is the longest single
  // round-trip here, so 5 minutes of total server silence means the create hung
  // — fail fast with a diagnostic instead of waiting out the 900s case timeout.
  watchdogMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-field-create-mixed-10k-19fields",
    rowCount: 10_000,
    batchSize: 1_000,
    baseFields,
    fields: createFields,
    generator: {
      type: "title-sequence",
      titlePrefix: "Item",
    },
    verify: {
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "create19FieldsMs",
      // Calibrated 2026-06-22 from 166 CI runs (v1+v2, Apr-Jun 2026): p95 ~16990ms,
      // worst ~18688ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 180_000).
      maxMs: 40_000,
    },
  },
});
