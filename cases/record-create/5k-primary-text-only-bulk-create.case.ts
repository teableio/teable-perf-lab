import { definePerfCase } from "../../framework/types";
import recordCreate1kPrimaryTextOnlyCase from "./1k-primary-text-only-bulk-create.case";

const baseline = recordCreate1kPrimaryTextOnlyCase.config;

export default definePerfCase({
  id: "record-create/5k-primary-text-only-bulk-create",
  title: "Bulk create 5k rows in a one-field table",
  runner: "record-create",
  timeoutMs: 600_000,
  config: {
    ...baseline,
    rowCount: 5_000,
    seedIdentity: "primary-5k-1f",
    tableNamePrefix: "perf-record-create-5k-primary-text-only",
    verify: {
      sampleRows: [0, 2_499, 4_999],
      fullScanPageSize: 1_000,
    },
    threshold: { metric: "bulkCreate5kMs", maxMs: 30_000 },
  },
});
