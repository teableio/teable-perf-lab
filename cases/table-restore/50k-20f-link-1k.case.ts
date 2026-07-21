import { definePerfCase } from "../../framework/types";
import baseline from "./10k-20f-link-1k.case";

export default definePerfCase({
  id: "table-restore/50k-20f-link-1k",
  title:
    "Restore a 50k-record 20-field table owning a populated link field from trash",
  runner: "table-restore-link",
  timeoutMs: 2_400_000,
  watchdogMs: 600_000,
  runtimeEnv: baseline.runtimeEnv,
  config: {
    ...baseline.config,
    tableNamePrefix: "perf-table-restore-link-50k",
    rowCount: 50_000,
    verify: {
      sampleRows: [0, 24_999, 49_999],
      fullScanPageSize: 1_000,
    },
    threshold: { metric: "restoreTableP95Ms", maxMs: 2_000 },
  },
});
