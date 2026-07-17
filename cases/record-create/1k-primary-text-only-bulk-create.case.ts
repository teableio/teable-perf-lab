import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-create/1k-primary-text-only-bulk-create",
  title: "Bulk create 1k rows in a one-field table",
  runner: "record-create",
  timeoutMs: 600_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-record-create-1k-primary-text-only",
    rowCount: 1_000,
    fields: [{ name: "Title", type: FieldType.SingleLineText }],
    createFieldNames: ["Title"],
    generator: {
      type: "mixed-record-create",
      titlePrefix: "Mixed row",
      payloadPrefix: "mixed",
      valuePrefix: "Cell",
    },
    verify: {
      sampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
    },
    threshold: { metric: "bulkCreate1kMs", maxMs: 6_000 },
  },
});
