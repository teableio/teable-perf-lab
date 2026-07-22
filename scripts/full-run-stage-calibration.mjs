// Trusted calibration captured from the complete lightweight artifacts and job
// timing of cold run 29951887405 plus exact-hit warm run 29955363070. Keep the
// source pair beside the numbers so a later calibration can replace it as one unit.
//
// Execute durations are case artifact durationMs values and therefore exclude
// Jaeger fetch time. Cold-seed and trace attribution are also captured for all
// 316 selected cases; the planner caps each shard at the 60s trace job budget.
import { FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID } from "./full-run-execute-calibration.mjs";

export const FULL_RUN_STAGE_CALIBRATION = {
  sourceRunId: "29951887405",
  sourceUrl:
    "https://github.com/teableio/teable-perf-lab/actions/runs/29951887405",
  pairedWarmRunId: "29955363070",
  pairedWarmRunUrl:
    "https://github.com/teableio/teable-perf-lab/actions/runs/29955363070",
  cacheMode: "cold",
  observedStages: {
    sourceRunId: "29951887405",
    coldSeedMs: 1_893_000,
    v1Ms: 1_003_026,
    v2SyncMs: 691_894,
    v2HybridMs: 199_636,
    traceMs: 28_138,
  },
  fixedCosts: {
    // The observed medians are roughly 150s seed setup, 120s execute setup,
    // and 38s report. Keep a small orchestration/variance reserve so a plan
    // predicted only seconds below the external SLO is not accepted.
    coldSeedSetupMs: 180_000,
    warmSeedMs: 30_000,
    executeSetupMs: 130_000,
    reportMs: 60_000,
    traceJobBudgetMs: 60_000,
  },
  caseCosts: FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID,
};
