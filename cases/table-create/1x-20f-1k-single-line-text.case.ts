import { definePerfCase } from "../../framework/types";
import { tableCreate1kBase, tableCreate1kFields } from "../table-create.shared";

export default definePerfCase({
  id: "table-create/1x-20f-1k-single-line-text",
  title: "Create one 20-field text table with 1k inline records",
  runner: "table-create",
  timeoutMs: 600_000,
  config: {
    ...tableCreate1kBase,
    tableNamePrefix: "perf-table-create-1k-text-20f",
    fields: tableCreate1kFields.singleLineText20,
    threshold: {
      metric: "createTable1x1kRecordsMs",
      maxMs: 6_000,
    },
  },
});
