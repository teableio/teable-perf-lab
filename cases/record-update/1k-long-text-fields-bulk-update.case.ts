import { definePerfCase } from "../../framework/types";
import { mixedRecordUpdate1kBase } from "../record-update.shared";

export default definePerfCase({
  id: "record-update/1k-long-text-fields-bulk-update",
  title: "Bulk update 1k rows across three long-text fields",
  runner: "record-update",
  timeoutMs: 600_000,
  config: {
    ...mixedRecordUpdate1kBase,
    tableNamePrefix: "perf-record-update-1k-long-text",
    updateFieldNames: ["Description", "Notes", "Comment"],
    threshold: { metric: "bulkUpdate1kMs", maxMs: 8_000 },
  },
});
