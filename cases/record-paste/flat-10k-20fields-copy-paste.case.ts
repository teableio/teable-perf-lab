import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-paste/flat-10k-20fields-copy-paste",
  title: "Paste 10k flat records into an empty 20-field table",
  runner: "record-paste",
  timeoutMs: 600_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-record-paste-flat-10k-20fields-copy-paste",
    rowCount: 10_000,
    maxPasteCells: 200_000,
    fields: Array.from({ length: 20 }, (_, index) => ({
      name: `Field ${String(index + 1).padStart(2, "0")}`,
      type: FieldType.SingleLineText,
    })),
    generator: {
      type: "flat-copy-paste",
      titlePrefix: "Wide row",
      valuePrefix: "Cell",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "paste10kMs",
      // Calibrated 2026-06-22 from 289 CI runs (v1+v2, Apr-Jun 2026): p95 ~21789ms,
      // worst ~26622ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 240_000).
      maxMs: 60_000,
    },
  },
});
