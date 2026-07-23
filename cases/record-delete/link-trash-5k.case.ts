import { definePerfCase } from "../../framework/types";
import baseline from "./link-trash-1k.case";

export default definePerfCase({
  id: "record-delete/link-trash-5k",
  title: "Delete 5k records that are referenced by populated link cells",
  runner: "record-delete-link",
  routingEvidence: "not-applicable",
  timeoutMs: 1_800_000,
  config: {
    ...baseline.config,
    rowCount: 5_000,
    tableNamePrefix: "perf-record-delete-link-trash-5k",
    link: {
      ...baseline.config.link,
      foreignTable: {
        ...baseline.config.link.foreignTable,
        rowCount: 5_000,
      },
    },
    verify: {
      ...baseline.config.verify,
      sampleRows: [0, 2_499, 4_999],
    },
    threshold: { metric: "deleteLinked5kMs", maxMs: 10_000 },
  },
});
