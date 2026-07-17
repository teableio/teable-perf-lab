import { definePerfCase } from "../../framework/types";
import { mixedRecordUpdate1kBase } from "../record-update.shared";

export default definePerfCase({
  id: "record-update/1k-number-fields-bulk-update",
  title: "Bulk update 1k rows across three number fields",
  runner: "record-update",
  timeoutMs: 600_000,
  config: {
    ...mixedRecordUpdate1kBase,
    tableNamePrefix: "perf-record-update-1k-number",
    updateFieldNames: ["Amount", "Quantity", "Percent"],
    threshold: { metric: "bulkUpdate1kMs", maxMs: 8_000 },
  },
});
