// Complete calibration envelope through cold run 29957965247, retaining
// larger per-case observations from cold run 29951887405 and exact-hit warm run
// 29955363070. Keep the source runs beside the numbers so later calibration can
// extend the envelope without silently lowering a known straggler.
// This source predates the physical-affinity gate; its duplicate rebuilds make
// cold costs conservative. The guarded refresh command rejects such a source.
//
// Execute durations are case artifact durationMs values and therefore exclude
// Jaeger fetch time. Cold-seed and trace attribution are also captured for all
// 316 selected cases; the planner caps each shard at the 60s trace job budget.
import { FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID } from "./full-run-execute-calibration.mjs";

export const FULL_RUN_STAGE_CALIBRATION = {
  sourceRunId: "29957965247",
  sourceUrl:
    "https://github.com/teableio/teable-perf-lab/actions/runs/29957965247",
  sourcePerfLabSha: "47259c6cbdef0652e98efb4caea4122b544c211f",
  sourceTeableEeSha: "0725368fe370202b79bb18271aeeeb8c626213b6",
  sourceCacheNamespace: "cw-47259c6-20260723-c1",
  sourceArtifactRunId: "29957965247-1",
  sourceSeedPlan: null,
  pairedWarmRunId: null,
  pairedWarmRunUrl: null,
  cacheMode: "cold",
  observedStages: {
    sourceRunId: "29957965247",
    coldSeedMs: 2_089_000,
    v1Ms: 1_021_736,
    v2SyncMs: 651_849,
    v2HybridMs: 162_046,
    traceMs: 34_471,
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
