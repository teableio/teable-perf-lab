import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  observeStagePlan,
  renderStagePlanObservationMarkdown,
  resolveTraceJobIdentity,
  summarizeSeedCacheStatuses,
} from "./stage-plan-observation-model.mjs";

assert.deepEqual(
  summarizeSeedCacheStatuses([{ mode: "exact-hit" }, { mode: "exact-hit" }]),
  {
    mode: "warm",
    statusCount: 2,
    modeCounts: { "exact-hit": 2 },
  },
);
assert.equal(
  summarizeSeedCacheStatuses([
    { mode: "exact-hit" },
    { mode: "cache-miss" },
  ]).mode,
  "mixed",
);

const planSummary = {
  stagePlan: {
    selectedShardCount: 2,
    activeStages: [
      "coldSeedMs",
      "v1Ms",
      "v2SyncMs",
      "v2HybridMs",
      "traceMs",
    ],
    executionProfile: { engines: ["v1", "v2"], v2Mode: "split" },
    predicted: {
      coldSeedMs: 110,
      warmSeedMs: 30,
      v1Ms: 210,
      v2SyncMs: 190,
      v2HybridMs: 50,
      traceMs: 40,
      coldWallMs: 400,
      warmWallMs: 280,
    },
    candidates: [
      {
        shardCount: 2,
        stageMaxima: {
          coldSeedMs: { shard: "shard-1-of-2" },
          v1Ms: { shard: "shard-1-of-2" },
          v2SyncMs: { shard: "shard-2-of-2" },
          v2HybridMs: { shard: "shard-1-of-2" },
          traceMs: { shard: "shard-2-of-2" },
        },
      },
    ],
  },
};

const job = (name, durationMs) => ({
  name,
  started_at: "2026-07-23T00:00:00.000Z",
  completed_at: new Date(
    Date.parse("2026-07-23T00:00:00.000Z") + durationMs,
  ).toISOString(),
});
const jobs = [
  job("Resolve workflow inputs", 5),
  job("Prepare perf seed DB (shard-1-of-2)", 100),
  job("Prepare perf seed DB (shard-2-of-2)", 120),
  job("Run perf cases (v1-shard-1-of-2)", 200),
  job("Run perf cases (v1-shard-2-of-2)", 180),
  job("Run perf cases (v2-sync-default-shard-1-of-2)", 170),
  job("Run perf cases (v2-sync-default-shard-2-of-2)", 190),
  job("Run perf cases (v2-hybrid-computed-shard-1-of-2)", 50),
  {
    name: "Report perf results",
    started_at: "2026-07-23T00:00:00.000Z",
    completed_at: null,
  },
];

assert.deepEqual(
  resolveTraceJobIdentity(
    "teable-ee-e2e-perf-results-v1-shard-2-of-7-123-1/traces/a/manifest.json",
  ),
  { stage: "v1Ms", shard: "shard-2-of-7" },
);
assert.deepEqual(
  resolveTraceJobIdentity(
    "teable-ee-e2e-perf-results-v2-hybrid-computed-shard-5-of-7-123-1/traces/a/manifest.json",
  ),
  { stage: "v2HybridMs", shard: "shard-5-of-7" },
);
assert.deepEqual(
  resolveTraceJobIdentity(
    "teable-ee-e2e-perf-v2-shard-3-of-7-123-1/traces/a/manifest.json",
  ),
  { stage: "v2SyncMs", shard: "shard-3-of-7" },
);

const observation = observeStagePlan({
  planSummary,
  jobs,
  traceObservation: {
    durationMs: 60,
    shard: "shard-2-of-2",
    source: "trace manifest job wait",
    jobWaits: [
      { stage: "v1Ms", shard: "shard-1-of-2", durationMs: 20 },
      { stage: "v2SyncMs", shard: "shard-2-of-2", durationMs: 10 },
    ],
  },
  seedCacheObservation: {
    mode: "cold",
    statusCount: 2,
    modeCounts: { "cache-miss": 2 },
  },
  sourceRunId: "current-run",
});

assert.equal(observation.complete, true);
assert.equal(observation.sourceRunId, "current-run");
assert.equal(observation.cacheMode, "cold");
assert.equal(observation.seedPredictionStage, "coldSeedMs");
assert.deepEqual(observation.observed.coldSeedMs, {
  durationMs: 120,
  rawDurationMs: 120,
  traceWaitMs: 0,
  shard: "shard-2-of-2",
  jobName: "Prepare perf seed DB (shard-2-of-2)",
});
assert.deepEqual(observation.observed.v1Ms, {
  durationMs: 180,
  rawDurationMs: 200,
  traceWaitMs: 20,
  shard: "shard-1-of-2",
  jobName: "Run perf cases (v1-shard-1-of-2)",
});
assert.equal(observation.observed.v2SyncMs.durationMs, 180);
assert.equal(observation.observed.v2HybridMs.durationMs, 50);
assert.deepEqual(observation.observed.traceMs, {
  durationMs: 60,
  shard: "shard-2-of-2",
  jobName: "trace manifest job wait",
});
assert.deepEqual(observation.driftMs, {
  coldSeedMs: 10,
  v1Ms: -30,
  v2SyncMs: -10,
  v2HybridMs: 0,
  traceMs: 20,
});
assert.equal(observation.predicted.coldSeedMs.shard, "shard-1-of-2");

const markdown = renderStagePlanObservationMarkdown(observation);
assert.match(markdown, /Current-run predicted vs observed stages/);
assert.match(markdown, /current-run/);
assert.match(markdown, /Observed - predicted/);
assert.match(markdown, /shard-2-of-2/);

const partial = observeStagePlan({
  planSummary,
  jobs: jobs.filter(({ name }) => !name.includes("v2-hybrid")),
  traceObservation: { durationMs: 0, shard: "none" },
  seedCacheObservation: {
    mode: "cold",
    statusCount: 2,
    modeCounts: { "cache-miss": 2 },
  },
  sourceRunId: "partial-run",
});
assert.equal(partial.complete, false);
assert.deepEqual(partial.missingStages, ["v2HybridMs"]);
assert.match(
  renderStagePlanObservationMarkdown(partial),
  /Missing observed stages: v2HybridMs/,
);

const warm = observeStagePlan({
  planSummary,
  jobs,
  traceObservation: { durationMs: 0, shard: "none" },
  seedCacheObservation: {
    mode: "warm",
    statusCount: 2,
    modeCounts: { "exact-hit": 2 },
  },
  sourceRunId: "warm-run",
});
assert.equal(warm.cacheMode, "warm");
assert.equal(warm.seedPredictionStage, "warmSeedMs");
assert.equal(warm.predicted.warmSeedMs.durationMs, 30);
assert.equal(warm.observed.warmSeedMs.durationMs, 120);
assert.equal(warm.driftMs.warmSeedMs, 90);
assert.equal(warm.observed.coldSeedMs, undefined);

const missingTrace = observeStagePlan({
  planSummary,
  jobs,
  traceObservation: null,
  seedCacheObservation: {
    mode: "cold",
    statusCount: 2,
    modeCounts: { "cache-miss": 2 },
  },
  sourceRunId: "missing-trace-run",
});
assert.equal(missingTrace.complete, false);
assert.ok(missingTrace.missingStages.includes("traceMs"));
assert.equal(missingTrace.observed.traceMs, undefined);

const explicitHybridPlanSummary = structuredClone(planSummary);
explicitHybridPlanSummary.stagePlan.activeStages = [
  "coldSeedMs",
  "v2HybridMs",
  "traceMs",
];
explicitHybridPlanSummary.stagePlan.executionProfile = {
  engines: ["v2"],
  v2Mode: "hybrid",
};
const explicitHybrid = observeStagePlan({
  planSummary: explicitHybridPlanSummary,
  jobs: [
    job("Prepare perf seed DB (shard-1-of-2)", 100),
    job("Prepare perf seed DB (shard-2-of-2)", 90),
    job("Run perf cases (v2-shard-1-of-2)", 80),
  ],
  traceObservation: { durationMs: 0, shard: "none" },
  seedCacheObservation: {
    mode: "cold",
    statusCount: 2,
    modeCounts: { "cache-miss": 2 },
  },
  sourceRunId: "hybrid-run",
});
assert.equal(explicitHybrid.complete, true);
assert.equal(explicitHybrid.observed.v2HybridMs.durationMs, 80);
assert.equal(explicitHybrid.observed.v2SyncMs, undefined);

assert.equal(
  observeStagePlan({
    planSummary: {},
    jobs,
    sourceRunId: "targeted-run",
  }),
  null,
  "targeted runs without a stage plan are a no-op",
);

const workflow = parse(
  await readFile(
    new URL("../.github/workflows/teable-ee-e2e-perf.yml", import.meta.url),
    "utf8",
  ),
);
assert.deepEqual(workflow.jobs.report.needs, ["resolve_inputs", "execute"]);
const observeStep = workflow.jobs.report.steps.find(
  ({ name }) => name === "Publish current-run stage observation",
);
assert.equal(observeStep.run, "node scripts/observe-stage-plan.mjs");
assert.equal(
  observeStep.env.PERF_LAB_PLAN_SUMMARY,
  "${{ needs.resolve_inputs.outputs.plan_summary }}",
);
assert.ok(observeStep.env.PERF_LAB_ARTIFACT_DIR);
assert.ok(observeStep.env.PERF_LAB_SEED_ARTIFACT_DIR);
const downloadSeedStep = workflow.jobs.report.steps.find(
  ({ name }) => name === "Download seed cache status artifacts",
);
assert.ok(downloadSeedStep);
assert.equal(downloadSeedStep.with["merge-multiple"], false);
const uploadStep = workflow.jobs.report.steps.find(
  ({ name }) => name === "Upload current-run stage observation",
);
assert.equal(uploadStep.with["if-no-files-found"], "ignore");

console.log("Stage plan observation checks passed.");
