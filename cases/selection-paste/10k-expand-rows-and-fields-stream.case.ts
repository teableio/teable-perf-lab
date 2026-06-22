import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "selection-paste/10k-expand-rows-and-fields-stream",
  title: "Paste 10k rows through stream while expanding table rows and fields",
  runner: "record-paste",
  timeoutMs: 900_000,
  runtimeEnv: {
    PRISMA_TRANSACTION_TIMEOUT: 30_000,
  },
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-selection-paste-expand-10k-stream",
    rowCount: 10_000,
    seedRowCount: 10,
    seedFieldCount: 2,
    stream: true,
    maxPasteCells: 200_000,
    fields: Array.from({ length: 20 }, (_, index) => ({
      name: `Field ${String(index + 1).padStart(2, "0")}`,
      type: FieldType.SingleLineText,
    })),
    generator: {
      type: "flat-copy-paste",
      titlePrefix: "Expand row",
      valuePrefix: "ExpandCell",
    },
    verify: {
      sampleRows: [0, 9, 4_999, 9_999],
      fullScanPageSize: 200,
    },
    threshold: {
      metric: "pasteExpand10kMs",
      // Calibrated 2026-06-22 from 83 CI runs (v1+v2, Apr-Jun 2026): p95 ~22016ms,
      // worst ~25086ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 300_000).
      maxMs: 60_000,
    },
  },
});
