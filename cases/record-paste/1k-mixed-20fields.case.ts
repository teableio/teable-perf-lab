import { definePerfCase } from "../../framework/types";
import { recordPaste1kBase, recordPaste1kFields } from "../record-paste.shared";

export default definePerfCase({
  id: "record-paste/1k-mixed-20fields",
  title: "Paste 1k records into a 20-field mixed table",
  runner: "record-paste",
  timeoutMs: 300_000,
  config: {
    ...recordPaste1kBase,
    tableNamePrefix: "perf-record-paste-1k-mixed-20fields",
    fields: recordPaste1kFields.mixed20,
    threshold: {
      metric: "paste1kMs",
      maxMs: 6_000,
    },
  },
});
