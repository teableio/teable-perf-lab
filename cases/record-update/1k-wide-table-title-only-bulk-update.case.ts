import { definePerfCase } from "../../framework/types";
import { mixedRecordUpdate1kBase } from "../record-update.shared";

export default definePerfCase({
  id: "record-update/1k-wide-table-title-only-bulk-update",
  title: "Bulk update only Title across 1k rows in a 20-field table",
  runner: "record-update",
  timeoutMs: 600_000,
  config: {
    ...mixedRecordUpdate1kBase,
    tableNamePrefix: "perf-record-update-1k-wide-table-title-only",
    updateFieldNames: ["Title"],
    threshold: { metric: "bulkUpdate1kMs", maxMs: 8_000 },
  },
});
