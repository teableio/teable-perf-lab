import { FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-convert/10k-text-to-date-mixed",
  title: "Convert 10k valid and invalid text values to UTC date",
  runner: "field-convert",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-text-date-mixed",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "Date Text", type: FieldType.SingleLineText },
    ],
    generator: { type: "field-convert-mixed", titlePrefix: "Convert row" },
    convert: {
      sourceFieldName: "Date Text",
      target: {
        type: FieldType.Date,
        options: {
          formatting: {
            date: "YYYY-MM-DD",
            time: "HH:mm",
            timeZone: "utc",
          },
        },
      },
      expected: "textDateMixed",
    },
    verify: {
      sampleRows: [0, 1, 4_999, 9_999],
      timeoutMs: 60_000,
      fullScanPageSize: 1_000,
    },
    threshold: { metric: "convertTextToDateReadyMs", maxMs: 15_000 },
  },
});
