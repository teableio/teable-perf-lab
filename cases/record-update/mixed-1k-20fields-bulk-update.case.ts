import { definePerfCase } from "../../framework/types";
import { mixedRecordUpdate1kBase } from "../record-update.shared";

export default definePerfCase({
  id: "record-update/mixed-1k-20fields-bulk-update",
  title: "Bulk update 1k existing rows across 20 mixed fields",
  runner: "record-update",
  timeoutMs: 600_000,
  config: {
    ...mixedRecordUpdate1kBase,
    tableNamePrefix: "perf-record-update-mixed-1k-20fields-bulk-update",
    threshold: {
      metric: "bulkUpdate1kMs",
      // Calibrated 2026-06-22 from 275 CI runs (v1+v2, Apr-Jun 2026): p95 ~3011ms,
      // worst ~4461ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 90_000).
      maxMs: 10_000,
    },
  },
});
