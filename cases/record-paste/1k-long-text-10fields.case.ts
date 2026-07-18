import { definePerfCase } from "../../framework/types";
import { recordPaste1kBase, recordPaste1kFields } from "../record-paste.shared";

export default definePerfCase({
  id: "record-paste/1k-long-text-10fields",
  title: "Paste 1k records into a 10-field long-text table",
  runner: "record-paste",
  timeoutMs: 300_000,
  config: {
    ...recordPaste1kBase,
    tableNamePrefix: "perf-record-paste-1k-long-text-10fields",
    fields: recordPaste1kFields.longText10,
    threshold: {
      metric: "paste1kMs",
      maxMs: 15_000,
    },
  },
});
