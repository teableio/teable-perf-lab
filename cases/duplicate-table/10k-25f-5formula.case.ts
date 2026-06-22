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
  id: "duplicate-table/10k-25f-5formula",
  title:
    "Duplicate a 10k-record complex mixed 25-field table with 5 formulas and records",
  runner: "duplicate-table",
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    sourceTableNamePrefix: "perf-duplicate-table-10k-25f-5formula",
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
      { name: "URL", type: FieldType.SingleLineText },
      { name: "Email", type: FieldType.SingleLineText },
      { name: "Reviewer", type: FieldType.SingleLineText },
      { name: "Region", type: FieldType.SingleLineText },
      { name: "Department", type: FieldType.SingleLineText },
    ],
    formulas: [
      {
        name: "Total Value",
        expression: "{Amount} * {Quantity}",
        expected: "amountTimesQuantity",
      },
      {
        name: "Amount Plus Quantity",
        expression: "{Amount} + {Quantity}",
        expected: "amountPlusQuantity",
      },
      {
        name: "Percent Score",
        expression: "{Percent} * 100",
        expected: "percentTimes100",
      },
      {
        name: "Quantity Plus Percent",
        expression: "{Quantity} + {Percent}",
        expected: "quantityPlusPercent",
      },
      {
        name: "Amount Times Percent",
        expression: "{Amount} * {Percent}",
        expected: "amountTimesPercent",
      },
    ],
    generator: {
      type: "mixed-duplicate-table",
      titlePrefix: "Complex duplicated row",
      payloadPrefix: "duplicate-table-complex",
      valuePrefix: "Complex",
    },
    duplicate: {
      namePrefix: "perf-duplicate-table-10k-25f-5formula-copy",
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
      // Calibrated 2026-06-22 from 154 CI runs (v1+v2, Apr-Jun 2026): p95 ~19286ms,
      // worst ~22090ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 180_000).
      maxMs: 45_000,
    },
  },
});
