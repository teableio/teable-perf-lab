import { definePerfCase } from "../../framework/types";
import { recordPaste1kFields, recordPaste5kBase } from "../record-paste.shared";

export default definePerfCase({
  id: "record-paste/5k-single-line-text-10fields",
  title: "Paste 5k records into a 10-field single-line text table",
  runner: "record-paste",
  timeoutMs: 600_000,
  config: {
    ...recordPaste5kBase,
    tableNamePrefix: "perf-record-paste-5k-text-10fields",
    fields: recordPaste1kFields.singleLineText10,
    threshold: { metric: "paste5kMs", maxMs: 30_000 },
  },
});
