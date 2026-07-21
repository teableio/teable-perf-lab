import { definePerfCase } from "../../framework/types";
import duplicateTable10k20fCase from "./10k-20f.case";

const baseline = duplicateTable10k20fCase.config;

export default definePerfCase({
  id: "duplicate-table/50k-20f",
  title: "Duplicate a 50k-record mixed 20-field table with records",
  runner: "duplicate-table",
  timeoutMs: 1_200_000,
  config: {
    ...baseline,
    sourceTableNamePrefix: "perf-duplicate-table-50k-20f",
    rowCount: 50_000,
    duplicate: {
      ...baseline.duplicate,
      namePrefix: "perf-duplicate-table-50k-20f-copy",
    },
    verify: {
      ...baseline.verify,
      sampleRows: [0, 24_999, 49_999],
      timeoutMs: 300_000,
    },
    threshold: {
      metric: "duplicateTableRequestMs",
      maxMs: 60_000,
    },
  },
});
