import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-update/1k-primary-text-only-bulk-update",
  title: "Bulk update 1k rows in a one-field table",
  runner: "record-update",
  timeoutMs: 600_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-record-update-1k-primary-text-only",
    rowCount: 1_000,
    batchSize: 1_000,
    fields: [{ name: "Title", type: FieldType.SingleLineText }],
    updateFieldNames: ["Title"],
    generator: {
      type: "mixed-record-update",
      seedPrefix: "seed",
      updatePrefix: "updated",
    },
    verify: {
      sampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
    },
    threshold: { metric: "bulkUpdate1kMs", maxMs: 8_000 },
  },
});
