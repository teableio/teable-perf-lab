import { definePerfCase } from "../../framework/types";
import recordUpdate1kPrimaryTextOnlyCase from "./1k-primary-text-only-bulk-update.case";

const baseline = recordUpdate1kPrimaryTextOnlyCase.config;

export default definePerfCase({
  id: "record-update/5k-primary-text-only-bulk-update",
  title: "Bulk update 5k rows in a one-field table",
  runner: "record-update",
  timeoutMs: 600_000,
  config: {
    ...baseline,
    rowCount: 5_000,
    seedIdentity: "primary-5k-1f",
    tableNamePrefix: "perf-record-update-5k-primary-text-only",
    verify: {
      sampleRows: [0, 2_499, 4_999],
      fullScanPageSize: 1_000,
    },
    threshold: { metric: "bulkUpdate5kMs", maxMs: 30_000 },
  },
});
