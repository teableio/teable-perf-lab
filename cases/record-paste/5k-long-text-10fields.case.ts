import { definePerfCase } from "../../framework/types";
import { recordPaste1kFields, recordPaste5kBase } from "../record-paste.shared";

export default definePerfCase({
  id: "record-paste/5k-long-text-10fields",
  title: "Paste 5k records into a 10-field long-text table",
  runner: "record-paste",
  timeoutMs: 600_000,
  config: {
    ...recordPaste5kBase,
    tableNamePrefix: "perf-record-paste-5k-long-text-10fields",
    fields: recordPaste1kFields.longText10,
    threshold: { metric: "paste5kMs", maxMs: 30_000 },
  },
});
