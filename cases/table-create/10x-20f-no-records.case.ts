import { recordReplayMixed20Fields } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "table-create/10x-20f-no-records",
  title: "Create 10 mixed 20-field tables without records in one window",
  runner: "table-create",
  timeoutMs: 600_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-table-create-10x-20f",
    tableCount: 10,
    fields: recordReplayMixed20Fields,
    threshold: {
      metric: "createTables10xTotalMs",
      // Calibrated 2026-06-22 from 154 CI runs (v1+v2, Apr-Jun 2026): p95 ~2272ms,
      // worst ~2768ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 60_000).
      maxMs: 6_000,
    },
  },
});
