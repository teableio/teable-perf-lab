import { definePerfCase } from "../../framework/types";
import { recordPaste1kBase, recordPaste1kFields } from "../record-paste.shared";

// The sibling case pastes into an empty table, which sends
// `selection.recordIds: []`. This one pastes over 1,000 rows that already
// exist, so the body carries all 1,000 ids - the shape the grid sends when a
// user selects a block of rows and pastes over it, and the only paste shape
// where the server has to load every selected record before writing.
export default definePerfCase({
  id: "record-paste/1k-single-line-text-10fields-over-existing-rows",
  title: "Paste 1k records over 1k existing rows selected by id",
  runner: "record-paste",
  timeoutMs: 300_000,
  config: {
    ...recordPaste1kBase,
    tableNamePrefix: "perf-record-paste-1k-text-over-existing",
    fields: recordPaste1kFields.singleLineText10,
    pasteOverSeededRows: true,
    threshold: {
      metric: "pasteOver1kMs",
      // Initial guardrail, not yet calibrated: the create-paste sibling is
      // capped at 6_000ms and this path also loads every selected record
      // first, so it starts at twice that and should be tightened once CI
      // history exists.
      maxMs: 12_000,
    },
  },
});
