import { Colors, FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "selection-duplicate/flat-1k-row-duplicate-stream",
  title: "Duplicate 1k selected rows through the selection stream",
  runner: "selection-duplicate",
  timeoutMs: 600_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-selection-duplicate-flat-1k-row-duplicate-stream",
    rowCount: 1_000,
    batchSize: 1_000,
    fields: [
      {
        name: "Name",
        type: FieldType.SingleLineText,
      },
      {
        name: "Index",
        type: FieldType.Number,
      },
      {
        name: "Group",
        type: FieldType.SingleSelect,
        options: {
          choices: [
            { name: "A", color: Colors.BlueBright },
            { name: "B", color: Colors.GreenBright },
            { name: "C", color: Colors.OrangeBright },
            { name: "D", color: Colors.PurpleBright },
            { name: "E", color: Colors.CyanBright },
          ],
        },
      },
      {
        name: "Payload",
        type: FieldType.LongText,
      },
    ],
    generator: {
      type: "flat-table-operation",
      titlePrefix: "Duplicate row",
      groups: ["A", "B", "C", "D", "E"],
      payloadPrefix: "duplicate",
    },
    verify: {
      sampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "duplicate1kMs",
      maxMs: 180_000,
    },
  },
});
