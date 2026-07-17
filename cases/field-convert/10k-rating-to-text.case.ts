import { Colors, FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-convert/10k-rating-to-text",
  title: "Convert a 10k-row rating field to single-line text",
  runner: "field-convert",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-rating-text",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      {
        name: "Score",
        type: FieldType.Rating,
        options: { icon: "star", color: Colors.YellowBright, max: 5 },
      },
    ],
    generator: { type: "field-convert-mixed", titlePrefix: "Convert row" },
    convert: {
      sourceFieldName: "Score",
      target: { type: FieldType.SingleLineText },
      expected: "ratingText",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      timeoutMs: 60_000,
      fullScanPageSize: 1_000,
    },
    threshold: { metric: "convertRatingToTextReadyMs", maxMs: 15_000 },
  },
});
