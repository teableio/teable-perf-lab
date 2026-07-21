import { definePerfCase } from "../../framework/types";
import { recordPaste1kBase, recordPaste1kFields } from "../record-paste.shared";

export default definePerfCase({
  id: "record-paste/10k-primary-only",
  title: "Paste 10k records into a primary-only table",
  runner: "record-paste",
  timeoutMs: 600_000,
  config: {
    ...recordPaste1kBase,
    rowCount: 10_000,
    maxPasteCells: 10_000,
    tableNamePrefix: "perf-record-paste-10k-primary-only",
    fields: recordPaste1kFields.primaryOnly,
    verify: {
      sampleRows: [0, 4_999, 9_999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "paste10kMs",
      maxMs: 20_000,
    },
  },
});
