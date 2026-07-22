// Trusted calibration captured from the complete lightweight artifacts and job
// timing of Actions run 29917985095. Keep the source run beside the numbers so
// a later calibration can be reviewed and replaced as one unit.
//
// Execute durations are case artifact durationMs values and therefore exclude
// Jaeger fetch time. Trace cost uses the current 15s per-case policy bound; the
// planner also caps each shard at the 60s job budget.
import { FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID } from "./full-run-execute-calibration.mjs";

export const FULL_RUN_STAGE_CALIBRATION = {
  sourceRunId: "29917985095",
  sourceUrl:
    "https://github.com/teableio/teable-perf-lab/actions/runs/29917985095",
  cacheMode: "cold",
  observedStages: {
    sourceRunId: "29917985095",
    coldSeedMs: 2_638_000,
    v1Ms: 1_702_000,
    v2SyncMs: 1_568_000,
    v2HybridMs: 232_000,
    traceMs: 239_000,
  },
  caseCosts: {
    ...FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID,
    "record-read/100k-50fields-filter-number-greater-half": {
      ...FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID[
        "record-read/100k-50fields-filter-number-greater-half"
      ],
      coldSeedMs: 1_185_208,
      traceMs: 15_000,
    },
    "record-read/100k-50fields-filter-number-range-middle-half": {
      ...FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID[
        "record-read/100k-50fields-filter-number-range-middle-half"
      ],
      coldSeedMs: 1_173_132,
      traceMs: 15_000,
    },
    "record-read/100k-50fields-filter-number-sort-descending": {
      ...FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID[
        "record-read/100k-50fields-filter-number-sort-descending"
      ],
      coldSeedMs: 929_402,
      traceMs: 15_000,
    },
    "search/search-index-off-100k-20search-fields": {
      ...FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID[
        "search/search-index-off-100k-20search-fields"
      ],
      coldSeedMs: 585_386,
      traceMs: 15_000,
    },
    "search/search-index-on-100k-20search-fields": {
      ...FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID[
        "search/search-index-on-100k-20search-fields"
      ],
      coldSeedMs: 802_007,
      traceMs: 15_000,
    },
  },
};
