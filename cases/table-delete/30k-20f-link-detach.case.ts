import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-20f-link-detach.case";

export default definePerfCase({
  id: "table-delete/30k-20f-link-detach",
  title:
    "Archive a table that a 30k-record 20-field table still links to (detachLink)",
  runner: "table-delete-link",
  timeoutMs: 1_800_000,
  watchdogMs: 300_000,
  config: {
    ...baseCase.config,
    rowCount: 30_000,
    tableNamePrefix: "perf-table-delete-link-30k",
    verify: {
      ...baseCase.config.verify,
      sampleRows: [0, 14_999, 29_999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "deleteTableDetachLinkP95Ms",
      // Initial 30k scale guardrail; tighten after runtime history.
      maxMs: 30_000,
    },
  },
});
