import { definePerfCase } from "../../framework/types";
import { mixedRecordCreate1kBase } from "../record-create.shared";

export default definePerfCase({
  id: "record-create/5k-checkbox-fields-bulk-create",
  title: "Bulk create 5k rows across two checkbox fields",
  runner: "record-create",
  timeoutMs: 600_000,
  config: {
    ...mixedRecordCreate1kBase,
    rowCount: 5_000,
    seedIdentity: "mixed-5k-20fields",
    tableNamePrefix: "perf-record-create-5k-checkbox",
    createFieldNames: ["Active", "Approved"],
    verify: {
      sampleRows: [0, 2_499, 4_999],
      fullScanPageSize: 1_000,
    },
    threshold: { metric: "bulkCreate5kMs", maxMs: 30_000 },
  },
});
