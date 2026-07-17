import { definePerfCase } from "../../framework/types";
import { mixedRecordCreate1kBase } from "../record-create.shared";

export default definePerfCase({
  id: "record-create/1k-rating-field-bulk-create",
  title: "Bulk create 1k rows with one rating field",
  runner: "record-create",
  timeoutMs: 600_000,
  config: {
    ...mixedRecordCreate1kBase,
    tableNamePrefix: "perf-record-create-1k-rating",
    createFieldNames: ["Score"],
    threshold: { metric: "bulkCreate1kMs", maxMs: 6_000 },
  },
});
