import { definePerfCase } from "../../framework/types";
import { mixedRecordCreate1kBase } from "../record-create.shared";

export default definePerfCase({
  id: "record-create/1k-checkbox-fields-bulk-create",
  title: "Bulk create 1k rows across two checkbox fields",
  runner: "record-create",
  timeoutMs: 600_000,
  config: {
    ...mixedRecordCreate1kBase,
    tableNamePrefix: "perf-record-create-1k-checkbox",
    createFieldNames: ["Active", "Approved"],
    threshold: { metric: "bulkCreate1kMs", maxMs: 6_000 },
  },
});
