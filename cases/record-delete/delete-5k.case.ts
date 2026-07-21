import { definePerfCase } from "../../framework/types";
import baseline from "./delete-1k.case";

export default definePerfCase({
  id: "record-delete/delete-5k",
  title: "Delete 5k mixed records through selection delete",
  runner: "record-delete",
  timeoutMs: 1_800_000,
  config: {
    ...baseline.config,
    rowCount: 5_000,
    tableNamePrefix: "perf-record-delete-5k",
    verify: {
      ...baseline.config.verify,
      sampleRows: [0, 2_499, 4_999],
    },
    threshold: { metric: "delete5kMs", maxMs: 10_000 },
  },
});
