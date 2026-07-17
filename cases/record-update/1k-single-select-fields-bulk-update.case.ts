import { definePerfCase } from "../../framework/types";
import { mixedRecordUpdate1kBase } from "../record-update.shared";

export default definePerfCase({
  id: "record-update/1k-single-select-fields-bulk-update",
  title: "Bulk update 1k rows across three single-select fields",
  runner: "record-update",
  timeoutMs: 600_000,
  config: {
    ...mixedRecordUpdate1kBase,
    tableNamePrefix: "perf-record-update-1k-single-select",
    updateFieldNames: ["Status", "Priority", "Category"],
    threshold: { metric: "bulkUpdate1kMs", maxMs: 8_000 },
  },
});
