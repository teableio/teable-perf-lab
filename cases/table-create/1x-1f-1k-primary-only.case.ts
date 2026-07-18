import { definePerfCase } from "../../framework/types";
import { tableCreate1kBase, tableCreate1kFields } from "../table-create.shared";

export default definePerfCase({
  id: "table-create/1x-1f-1k-primary-only",
  title: "Create one primary-only table with 1k inline records",
  runner: "table-create",
  timeoutMs: 600_000,
  config: {
    ...tableCreate1kBase,
    tableNamePrefix: "perf-table-create-1k-primary-only",
    fields: tableCreate1kFields.primaryOnly,
    threshold: {
      metric: "createTable1x1kRecordsMs",
      maxMs: 4_000,
    },
  },
});
