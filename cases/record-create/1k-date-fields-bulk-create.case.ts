import { definePerfCase } from "../../framework/types";
import { mixedRecordCreate1kBase } from "../record-create.shared";

export default definePerfCase({
  id: "record-create/1k-date-fields-bulk-create",
  title: "Bulk create 1k rows across two date fields",
  runner: "record-create",
  timeoutMs: 600_000,
  config: {
    ...mixedRecordCreate1kBase,
    tableNamePrefix: "perf-record-create-1k-date",
    createFieldNames: ["Start Date", "Due Date"],
    threshold: { metric: "bulkCreate1kMs", maxMs: 6_000 },
  },
});
