import { definePerfCase } from "../../framework/types";
import { recordReplay10kBaseConfig } from "../../framework/runners/record-replay.shared";

export default definePerfCase({
  id: "record-delete/link-trash-1k",
  title: "Delete 1k records that are referenced by populated link cells",
  runner: "record-delete-link",
  timeoutMs: 900_000,
  config: {
    ...recordReplay10kBaseConfig,
    rowCount: 1_000,
    tableNamePrefix: "perf-record-delete-link-trash-1k",
    link: {
      fieldName: "Linked Foreign",
      foreignTable: {
        rowCount: 1_000,
        batchSize: 1_000,
        keyPrefix: "DELETE-LINK",
      },
      permutation: {
        multiplier: 7,
        offset: 3,
      },
    },
    verify: {
      ...recordReplay10kBaseConfig.verify,
      sampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "deleteLinked1kMs",
      maxMs: 30_000,
    },
  },
});
