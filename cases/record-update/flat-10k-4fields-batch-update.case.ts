import { Colors, FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-update/flat-10k-4fields-batch-update",
  title: "Update 10k flat records in a 4-field table",
  runner: "record-update",
  timeoutMs: 600_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-record-update-flat-10k-4fields-batch-update",
    rowCount: 10_000,
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
      titlePrefix: "Update row",
      groups: ["A", "B", "C", "D", "E"],
      payloadPrefix: "seed",
      updatePayloadPrefix: "updated",
    },
    verify: {
      sampleRows: [0, 4_999, 9_999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "update10kMs",
      maxMs: 180_000,
    },
  },
});
