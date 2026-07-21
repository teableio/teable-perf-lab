import { definePerfCase } from "../../framework/types";
import baseline from "./10k-20f.case";

export default definePerfCase({
  id: "table-restore/50k-20f",
  title: "Restore a 50k-record mixed 20-field table from trash",
  runner: "table-restore",
  timeoutMs: 1_800_000,
  config: {
    ...baseline.config,
    tableNamePrefix: "perf-table-restore-50k-20f",
    rowCount: 50_000,
    verify: {
      sampleRows: [0, 24_999, 49_999],
      fullScanPageSize: 1_000,
    },
    threshold: { metric: "restoreTableP95Ms", maxMs: 2_000 },
  },
});
