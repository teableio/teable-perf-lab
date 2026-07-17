import { definePerfCase } from "../../framework/types";
import { mixedRecordCreate1kBase } from "../record-create.shared";

export default definePerfCase({
  id: "record-create/mixed-1k-20fields-bulk-create",
  title: "Create 1k mixed records through the record create endpoint",
  runner: "record-create",
  timeoutMs: 300_000,
  config: {
    ...mixedRecordCreate1kBase,
    tableNamePrefix: "perf-record-create-mixed-1k-20fields-bulk-create",
    threshold: {
      metric: "bulkCreate1kMs",
      // Calibrated 2026-06-22 from 248 CI runs (v1+v2, Apr-Jun 2026): p95 ~2257ms,
      // worst ~2775ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 90_000).
      maxMs: 6_000,
    },
  },
});
