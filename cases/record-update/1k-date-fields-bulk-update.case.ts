import { definePerfCase } from "../../framework/types";
import { mixedRecordUpdate1kBase } from "../record-update.shared";

export default definePerfCase({
  id: "record-update/1k-date-fields-bulk-update",
  title: "Bulk update 1k rows across two date fields",
  runner: "record-update",
  timeoutMs: 600_000,
  config: {
    ...mixedRecordUpdate1kBase,
    tableNamePrefix: "perf-record-update-1k-date",
    updateFieldNames: ["Start Date", "Due Date"],
    threshold: { metric: "bulkUpdate1kMs", maxMs: 8_000 },
  },
});
