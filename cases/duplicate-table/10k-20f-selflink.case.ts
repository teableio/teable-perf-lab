import { Colors, FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

const selectChoices = (names: string[]) =>
  names.map((name, index) => ({
    name,
    color: [
      Colors.BlueBright,
      Colors.GreenBright,
      Colors.OrangeBright,
      Colors.PurpleBright,
      Colors.CyanBright,
    ][index % 5],
  }));

const dateOptions = {
  formatting: {
    date: "YYYY-MM-DD",
    time: "None",
    timeZone: "UTC",
  },
};

export default definePerfCase({
  id: "duplicate-table/10k-20f-selflink",
  title:
    "Duplicate a 10k-record mixed 20-field table with a self manyMany link",
  runner: "duplicate-table",
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    sourceTableNamePrefix: "perf-duplicate-table-10k-20f-selflink",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "Description", type: FieldType.LongText },
      {
        name: "Status",
        type: FieldType.SingleSelect,
        options: { choices: selectChoices(["Todo", "Doing", "Done"]) },
      },
      {
        name: "Priority",
        type: FieldType.SingleSelect,
        options: { choices: selectChoices(["P0", "P1", "P2"]) },
      },
      {
        name: "Tags",
        type: FieldType.MultipleSelect,
        options: {
          choices: selectChoices(["Alpha", "Beta", "Gamma", "Delta"]),
        },
      },
      { name: "Amount", type: FieldType.Number },
      { name: "Quantity", type: FieldType.Number },
      { name: "Start Date", type: FieldType.Date, options: dateOptions },
      { name: "Due Date", type: FieldType.Date, options: dateOptions },
      { name: "Active", type: FieldType.Checkbox },
      {
        name: "Score",
        type: FieldType.Rating,
        options: {
          icon: "star",
          color: Colors.YellowBright,
          max: 5,
        },
      },
      { name: "Owner Text", type: FieldType.SingleLineText },
      { name: "Notes", type: FieldType.LongText },
      {
        name: "Category",
        type: FieldType.SingleSelect,
        options: { choices: selectChoices(["A", "B", "C"]) },
      },
      {
        name: "Labels",
        type: FieldType.MultipleSelect,
        options: { choices: selectChoices(["Red", "Blue", "Green"]) },
      },
      { name: "External ID", type: FieldType.SingleLineText },
      { name: "Source", type: FieldType.SingleLineText },
      { name: "Percent", type: FieldType.Number },
      { name: "Approved", type: FieldType.Checkbox },
      { name: "Comment", type: FieldType.LongText },
    ],
    selfLink: {
      name: "Related",
      // One-way + sparse links: full 10k link updates exceed CI timeouts;
      // 500 rows still populate junction/cell jsonb for physical bulk.
      isOneWay: true,
      batchSize: 50,
      maxLinks: 500,
    },
    generator: {
      type: "mixed-duplicate-table",
      titlePrefix: "Duplicated row",
      payloadPrefix: "duplicate-table-selflink",
      valuePrefix: "Cell",
    },
    duplicate: {
      namePrefix: "perf-duplicate-table-10k-20f-selflink-copy",
      includeRecords: true,
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      fullScanPageSize: 1_000,
      timeoutMs: 120_000,
      pollIntervalMs: 2_000,
    },
    threshold: {
      metric: "duplicateTableRequestMs",
      // Self-link tables previously forced hydrate (~15s+). Physical path
      // should land near no-link bulk; keep a generous CI guardrail.
      maxMs: 40_000,
    },
  },
});
