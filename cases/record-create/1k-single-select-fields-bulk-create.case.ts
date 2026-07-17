import { definePerfCase } from "../../framework/types";
import { mixedRecordCreate1kBase } from "../record-create.shared";

export default definePerfCase({
  id: "record-create/1k-single-select-fields-bulk-create",
  title: "Bulk create 1k rows across three single-select fields",
  runner: "record-create",
  timeoutMs: 600_000,
  config: {
    ...mixedRecordCreate1kBase,
    tableNamePrefix: "perf-record-create-1k-single-select",
    createFieldNames: ["Status", "Priority", "Category"],
    threshold: { metric: "bulkCreate1kMs", maxMs: 6_000 },
  },
});
