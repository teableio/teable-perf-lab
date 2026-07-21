import { definePerfCase } from "../../framework/types";
import baseline from "./search-index-off-50k-20search-fields.case";

export default definePerfCase({
  id: "search/search-index-off-100k-20search-fields",
  title: "100k lookup global search without table search index",
  runner: "lookup-search-index",
  timeoutMs: 1_800_000,
  runtimeEnv: baseline.runtimeEnv,
  config: {
    ...baseline.config,
    sourceTableNamePrefix: "perf-lookup-search-index-source-100k",
    hostTableNamePrefix: "perf-lookup-search-index-host-100k",
    recordCount: 100_000,
    generator: {
      ...baseline.config.generator,
      permutation: { multiplier: 73, offset: 19 },
    },
    keywords: baseline.config.keywords.map((keyword) => ({
      ...keyword,
      value:
        keyword.value === "A1-Value-9522"
          ? "A1-Value-99999"
          : keyword.value === "A-Key-9999"
            ? "A-Key-99999"
            : keyword.value === "HostText1-Value-9522"
              ? "HostText1-Value-99999"
              : keyword.value,
    })),
    verify: {
      sampleRows: [0, 49_999, 99_999],
      timeoutMs: 240_000,
      pollIntervalMs: 500,
    },
    threshold: { metric: "lookupSearchIndexP95Ms", maxMs: 10_000 },
  },
});
