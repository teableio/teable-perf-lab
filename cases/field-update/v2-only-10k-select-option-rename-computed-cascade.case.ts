import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-update/v2-only-10k-select-option-rename-computed-cascade",
  title: "V2-only: rename a single-select option and wait for computed cascade",
  runner: "field-update",
  routingEvidence: "not-applicable",
  expectedSkipEngines: ["v1"],
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-field-update-select-rename-cascade",
    rowCount: 10_000,
    batchSize: 1_000,
    select: {
      fieldName: "Status",
      optionNames: ["Todo", "Doing", "Done", "Blocked"],
      rename: {
        previous: "Done",
        next: "Closed",
      },
    },
    computedFields: [
      {
        name: "Status Mark",
        expression: '{Status} & "-mark"',
        expected: "statusTextMark",
      },
      {
        name: "Status Score",
        expression:
          'IF({Status Mark} = "Todo-mark", 10, IF({Status Mark} = "Doing-mark", 40, IF({Status Mark} = "Done-mark", 70, IF({Status Mark} = "Closed-mark", 90, 0))))',
        expected: "statusScore",
      },
      {
        name: "Status Bucket",
        expression:
          'IF({Status Score} >= 80, "archived", IF({Status Score} >= 40, "active", "idle"))',
        expected: "statusScoreBucket",
      },
    ],
    generator: {
      type: "select-option-cycle",
      titlePrefix: "Select rename row",
    },
    verify: {
      // Row n holds options[(n - 1) % 4], so offsets 2 / 4,998 / 9,998 are
      // the first, middle, and last "Done" rows whose values must change
      // after the rename; offset 0 (Todo) is the unchanged control row.
      sampleRows: [0, 2, 4_998, 9_998],
      timeoutMs: 60_000,
      pollIntervalMs: 200,
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "updateSelectOptionRenameCascadeReadyMs",
      // Raised after a valid 4451.78ms CI result on 2026-07-24. The 6s guardrail
      // leaves ~35% runtime variance while remaining far below the original 30s.
      maxMs: 6_000,
    },
  },
});
