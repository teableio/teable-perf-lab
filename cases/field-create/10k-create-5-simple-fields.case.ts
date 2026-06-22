import { Colors, FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

const dateOptions = {
  formatting: {
    date: "YYYY-MM-DD",
    time: "None",
    timeZone: "Asia/Shanghai",
  },
};

const selectChoices = ["Todo", "Doing", "Done"].map((name, index) => ({
  name,
  color: [Colors.BlueBright, Colors.GreenBright, Colors.OrangeBright][index],
}));

export default definePerfCase({
  id: "field-create/10k-create-5-simple-fields",
  title: "Create 5 simple fields on a 10k-record table",
  runner: "field-create",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-field-create-simple-10k-5fields",
    rowCount: 10_000,
    batchSize: 1_000,
    baseFields: [{ name: "Title", type: FieldType.SingleLineText }],
    fields: [
      { name: "Description", type: FieldType.LongText },
      { name: "Amount", type: FieldType.Number },
      { name: "Due Date", type: FieldType.Date, options: dateOptions },
      { name: "Approved", type: FieldType.Checkbox },
      {
        name: "Status",
        type: FieldType.SingleSelect,
        options: { choices: selectChoices },
      },
    ],
    generator: {
      type: "title-sequence",
      titlePrefix: "Item",
    },
    verify: {
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "create5SimpleFieldsMs",
      // Calibrated 2026-06-22 from 168 CI runs (v1+v2, Apr-Jun 2026): p95 ~4703ms,
      // worst ~5087ms. Guardrail ~2x worst - catches a real ~2x regression without
      // flaking on CI variance (was 120_000).
      maxMs: 12_000,
    },
  },
});
