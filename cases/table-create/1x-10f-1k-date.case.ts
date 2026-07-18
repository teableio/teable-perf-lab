import { definePerfCase } from "../../framework/types";
import { tableCreate1kBase, tableCreate1kFields } from "../table-create.shared";

export default definePerfCase({
  id: "table-create/1x-10f-1k-date",
  title: "Create one 10-field date table with 1k inline records",
  runner: "table-create",
  timeoutMs: 600_000,
  config: {
    ...tableCreate1kBase,
    tableNamePrefix: "perf-table-create-1k-date-10f",
    fields: tableCreate1kFields.date10,
    threshold: {
      metric: "createTable1x1kRecordsMs",
      maxMs: 4_000,
    },
  },
});
