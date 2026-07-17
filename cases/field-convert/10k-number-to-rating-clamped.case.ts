import { Colors, FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "field-convert/10k-number-to-rating-clamped",
  title: "Convert 10k numbers to a five-star rating with clamping",
  runner: "field-convert",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-convert-number-rating-clamped",
    rowCount: 10_000,
    batchSize: 1_000,
    fields: [
      { name: "Title", type: FieldType.SingleLineText },
      { name: "Rating Input", type: FieldType.Number },
    ],
    generator: { type: "field-convert-mixed", titlePrefix: "Convert row" },
    convert: {
      sourceFieldName: "Rating Input",
      target: {
        type: FieldType.Rating,
        options: { icon: "star", color: Colors.YellowBright, max: 5 },
      },
      expected: "numberRatingClamped",
    },
    verify: {
      sampleRows: [0, 4, 5, 7, 4_999, 9_999],
      timeoutMs: 60_000,
      fullScanPageSize: 1_000,
      targetRatingMax: 5,
    },
    threshold: {
      metric: "convertNumberToRatingReadyMs",
      maxMs: 15_000,
    },
  },
});
