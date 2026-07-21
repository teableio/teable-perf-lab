import { definePerfCase } from "../../framework/types";
import { tableCreate1kBase, tableCreate1kFields } from "../table-create.shared";

export default definePerfCase({
  id: "table-create/1x-1f-5k-primary-only",
  title: "Create one primary-only table with 5k inline records",
  runner: "table-create",
  timeoutMs: 600_000,
  config: {
    ...tableCreate1kBase,
    tableNamePrefix: "perf-table-create-5k-primary-only",
    fields: tableCreate1kFields.primaryOnly,
    inlineRecords: {
      ...tableCreate1kBase.inlineRecords,
      count: 5_000,
    },
    verify: {
      ...tableCreate1kBase.verify,
      sampleRows: [0, 2_499, 4_999],
    },
    threshold: {
      metric: "createTable1x5kRecordsMs",
      maxMs: 20_000,
    },
  },
});
