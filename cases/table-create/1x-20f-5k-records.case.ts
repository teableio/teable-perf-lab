import { recordReplayMixed20Fields } from "../../framework/runners/record-replay.shared";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "table-create/1x-20f-5k-records",
  title: "Create one mixed 20-field table with 5k inline records",
  runner: "table-create",
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-table-create-5k-records",
    tableCount: 1,
    fields: recordReplayMixed20Fields,
    inlineRecords: {
      count: 5_000,
      titlePrefix: "Inline",
    },
    threshold: {
      metric: "createTable1x5kRecordsMs",
      // Initial scale guardrail; tighten after CI history establishes variance.
      maxMs: 30_000,
    },
  },
});
