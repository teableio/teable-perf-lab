import { definePerfCase } from "../../framework/types";
import { mixedRecordUpdate1kBase } from "../record-update.shared";

export default definePerfCase({
  id: "record-update/5k-rating-field-bulk-update",
  title: "Bulk update 5k rows across one rating field",
  runner: "record-update",
  timeoutMs: 600_000,
  config: {
    ...mixedRecordUpdate1kBase,
    rowCount: 5_000,
    seedIdentity: "mixed-5k-20fields",
    tableNamePrefix: "perf-record-update-5k-rating",
    updateFieldNames: ["Score"],
    verify: {
      sampleRows: [0, 2_499, 4_999],
      fullScanPageSize: 1_000,
    },
    threshold: { metric: "bulkUpdate5kMs", maxMs: 30_000 },
  },
});
