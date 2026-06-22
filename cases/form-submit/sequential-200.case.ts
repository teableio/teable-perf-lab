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
  id: "form-submit/sequential-200",
  title: "Submit 200 records sequentially through a Form view",
  runner: "form-submit",
  timeoutMs: 900_000,
  runtimeEnv: {
    PERF_LAB_TRACE_INCLUDE_STEP_PATTERN: "^formSubmitP95Ms:(1|50|100|150)$",
    PERF_LAB_TRACE_FALLBACK_STEP_PATTERN: "^formSubmitP95Ms:\\d+$",
    PERF_LAB_TRACE_FALLBACK_MAX_ATTEMPTS: 3,
  },
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-form-submit-sequential-200",
    rowCount: 200,
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
      type: "mixed-form-submit",
      titlePrefix: "Form row",
      payloadPrefix: "form",
      valuePrefix: "Cell",
    },
    verify: {
      sampleRows: [0, 99, 199],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "formSubmitP95Ms",
      // Calibrated 2026-06-22 from 143 CI runs (v1+v2, Apr-Jun 2026): p95 ~253ms,
      // worst ~273ms. Sub-second metric floored at 2_000ms (not 2x worst) to keep
      // headroom for CI variance on a noisy small metric (was 4_000).
      maxMs: 2_000,
    },
  },
});
