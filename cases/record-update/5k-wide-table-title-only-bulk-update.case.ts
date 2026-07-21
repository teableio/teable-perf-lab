import { definePerfCase } from "../../framework/types";
import { mixedRecordUpdate1kBase } from "../record-update.shared";

export default definePerfCase({
  id: "record-update/5k-wide-table-title-only-bulk-update",
  title: "Bulk update only Title across 5k rows in a 20-field table",
  runner: "record-update",
  timeoutMs: 600_000,
  config: {
    ...mixedRecordUpdate1kBase,
    rowCount: 5_000,
    seedIdentity: "mixed-5k-20fields",
    tableNamePrefix: "perf-record-update-5k-wide-table-title-only",
    updateFieldNames: ["Title"],
    verify: {
      sampleRows: [0, 2_499, 4_999],
      fullScanPageSize: 1_000,
    },
    threshold: { metric: "bulkUpdate5kMs", maxMs: 30_000 },
  },
});
