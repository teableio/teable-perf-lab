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
  id: "csv-import/mixed-10k-20fields-create-table-import",
  title: "Create a new table from a 10k-row mixed CSV import",
  runner: "csv-import",
  timeoutMs: 600_000,
  config: {
    baseId: "seed-base",
    targetMode: "create-table",
    tableNamePrefix: "perf-csv-import-mixed-10k-20fields-create-table-import",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "Description", type: FieldType.LongText },
      {
        name: "Status",
        type: FieldType.SingleSelect,
        options: { choices: selectChoices(["T", "D", "N"]) },
      },
      {
        name: "Priority",
        type: FieldType.SingleSelect,
        options: { choices: selectChoices(["0", "1", "2"]) },
      },
      {
        name: "Tags",
        type: FieldType.MultipleSelect,
        options: {
          choices: selectChoices(["A", "B", "C", "D"]),
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
        options: { choices: selectChoices(["R", "B", "G"]) },
      },
      { name: "External ID", type: FieldType.SingleLineText },
      { name: "Source", type: FieldType.SingleLineText },
      { name: "Percent", type: FieldType.Number },
      { name: "Approved", type: FieldType.Checkbox },
      { name: "Comment", type: FieldType.LongText },
    ],
    generator: {
      type: "mixed-csv-import",
      titlePrefix: "Mixed row",
      payloadPrefix: "mixed",
      valuePrefix: "Cell",
      compact: true,
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
    },
    threshold: {
      metric: "csvCreateTableImportCompletedMs",
      maxMs: 60_000,
    },
  },
});
