import { definePerfCase } from "../../framework/types";
import baseline from "./10k-20f-selflink.case";

export default definePerfCase({
  id: "duplicate-table/10k-20f-selflink-2k-links",
  title:
    "Duplicate a 10k-record mixed 20-field table with 2k populated self links",
  runner: "duplicate-table",
  timeoutMs: 1_800_000,
  config: {
    ...baseline.config,
    sourceTableNamePrefix: "perf-duplicate-table-10k-20f-selflink-2k",
    selfLink: { ...baseline.config.selfLink!, maxLinks: 2_000 },
    duplicate: {
      ...baseline.config.duplicate,
      namePrefix: "perf-duplicate-table-10k-20f-selflink-2k-copy",
    },
    threshold: { metric: "duplicateTableRequestMs", maxMs: 60_000 },
  },
});
