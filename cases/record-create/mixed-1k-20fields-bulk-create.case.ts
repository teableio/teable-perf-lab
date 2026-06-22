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
  id: "record-create/mixed-1k-20fields-bulk-create",
  title: "Create 1k mixed records through the record create endpoint",
  runner: "record-create",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-record-create-mixed-1k-20fields-bulk-create",
    rowCount: 1_000,
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
    generator: {
      type: "mixed-record-create",
      titlePrefix: "Mixed row",
      payloadPrefix: "mixed",
      valuePrefix: "Cell",
    },
    verify: {
      sampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "bulkCreate1kMs",
      // Calibrated 2026-06-22 from 248 CI runs (v1+v2, Apr-Jun 2026): p95 ~2257ms,
      // worst ~2775ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 90_000).
      maxMs: 6_000,
    },
  },
});
