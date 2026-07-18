import { definePerfCase } from "../../framework/types";
import { recordPaste1kBase, recordPaste1kFields } from "../record-paste.shared";

export default definePerfCase({
  id: "record-paste/1k-primary-only",
  title: "Paste 1k records into a primary-only table",
  runner: "record-paste",
  timeoutMs: 300_000,
  config: {
    ...recordPaste1kBase,
    tableNamePrefix: "perf-record-paste-1k-primary-only",
    fields: recordPaste1kFields.primaryOnly,
    threshold: {
      metric: "paste1kMs",
      maxMs: 15_000,
    },
  },
});
