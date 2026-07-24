import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  observeStagePlan,
  renderStagePlanObservationMarkdown,
  resolveTraceJobIdentity,
  selectLatestLogicalJobs,
  summarizeSeedCacheStatuses,
} from "./stage-plan-observation-model.mjs";
import { selectLatestReportArtifacts } from "./select-report-artifacts.mjs";

assert.deepEqual(
  summarizeSeedCacheStatuses([{ mode: "exact-hit" }, { mode: "exact-hit" }]),
  {
    mode: "warm",
    statusCount: 2,
    modeCounts: { "exact-hit": 2 },
  },
);
assert.equal(
  summarizeSeedCacheStatuses([{ mode: "exact-hit" }, { mode: "cache-miss" }])
    .mode,
  "mixed",
);

const planSummary = {
  stagePlan: {
    selectedShardCount: 2,
    activeStages: ["coldSeedMs", "v1Ms", "v2SyncMs", "v2HybridMs", "traceMs"],
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
  selectLatestLogicalJobs([
    {
      ...job("Prepare perf seed DB (shard-1-of-2)", 100),
      id: 1,
      run_attempt: 1,
    },
    {
      ...job("Prepare perf seed DB (shard-2-of-2)", 120),
      id: 2,
      run_attempt: 1,
    },
    {
      ...job("Prepare perf seed DB (shard-1-of-2)", 80),
      id: 3,
      run_attempt: 2,
    },
  ]).map(({ id }) => id),
  [3, 2],
  "a failed-job rerun must keep successful logical siblings from older attempts",
);

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

const missingPlannedJob = observeStagePlan({
  planSummary,
  jobs,
  traceObservation: { durationMs: 0, shard: "none" },
  seedCacheObservation: {
    mode: "cold",
    statusCount: 2,
    modeCounts: { "cache-miss": 2 },
  },
  sourceRunId: "missing-planned-job-run",
  expectedJobNames: [
    "Prepare perf seed DB (shard-1-of-2)",
    "Prepare perf seed DB (shard-2-of-2)",
    "Run perf cases (v2-hybrid-computed-shard-2-of-2)",
  ],
});
assert.equal(missingPlannedJob.complete, false);
assert.deepEqual(missingPlannedJob.missingJobs, [
  "Run perf cases (v2-hybrid-computed-shard-2-of-2)",
]);
assert.match(
  renderStagePlanObservationMarkdown(missingPlannedJob),
  /Missing planned jobs: Run perf cases \(v2-hybrid-computed-shard-2-of-2\)/,
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

const reportArtifacts = selectLatestReportArtifacts({
  runId: "123",
  artifacts: [
    {
      id: 1,
      name: "teable-ee-e2e-perf-results-v1-shard-1-of-2-123-1",
      expired: false,
    },
    {
      id: 2,
      name: "teable-ee-e2e-perf-results-v1-shard-2-of-2-123-1",
      expired: false,
    },
    {
      id: 3,
      name: "teable-ee-e2e-perf-results-v1-shard-1-of-2-123-2",
      expired: false,
    },
    {
      id: 4,
      name: "teable-ee-e2e-perf-v1-shard-2-of-2-123-2",
      expired: false,
    },
    {
      id: 5,
      name: "teable-ee-e2e-perf-seed-shard-1-of-2-123-2",
      expired: false,
    },
    {
      id: 6,
      name: "teable-ee-e2e-perf-seed-shard-2-of-2-123-1",
      expired: false,
    },
    {
      id: 7,
      name: "teable-ee-e2e-perf-seed-shard-2-of-2-123-2",
      expired: true,
    },
    {
      id: 8,
      name: "teable-ee-e2e-perf-results-v1-shard-2-of-2-other-2",
      expired: false,
    },
    {
      id: 9,
      name: "teable-ee-e2e-perf-seed-shard-1-of-2-123-1",
      expired: false,
    },
  ],
});
assert.deepEqual(reportArtifacts.executeArtifactIds, [3, 4]);
assert.deepEqual(reportArtifacts.seedArtifactIds, [5, 6]);
assert.deepEqual(reportArtifacts.seedProvenanceArtifactIds, [9]);
assert.deepEqual(
  reportArtifacts.execute.map(({ logicalName, attempt, lightweight }) => ({
    logicalName,
    attempt,
    lightweight,
  })),
  [
    { logicalName: "v1-shard-1-of-2", attempt: 2, lightweight: true },
    { logicalName: "v1-shard-2-of-2", attempt: 2, lightweight: false },
  ],
  "each logical shard must use its newest artifact and prefer lightweight within one attempt",
);

const workflow = parse(
  await readFile(
    new URL("../.github/workflows/teable-ee-e2e-perf.yml", import.meta.url),
    "utf8",
  ),
);
assert.deepEqual(workflow.jobs.report.needs, [
  "resolve_inputs",
  "seed",
  "execute",
]);
assert.equal(
  workflow.jobs.resolve_inputs.outputs.case_filter_is_all,
  "${{ steps.engines.outputs.case_filter_is_all }}",
);
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
assert.equal(
  observeStep.env.PERF_LAB_SEED_PLAN,
  "${{ needs.resolve_inputs.outputs.seed_plan }}",
);
assert.equal(
  observeStep.env.PERF_LAB_EXECUTE_PLAN,
  "${{ needs.resolve_inputs.outputs.execute_plan }}",
);
const resultAcceptanceStep = workflow.jobs.report.steps.find(
  ({ name }) => name === "Verify full-run result acceptance",
);
assert.equal(
  resultAcceptanceStep.run,
  "node scripts/verify-full-run-result-acceptance.mjs",
);
assert.equal(resultAcceptanceStep["continue-on-error"], true);
assert.equal(
  resultAcceptanceStep.env.PERF_LAB_EXECUTE_PLAN,
  "${{ needs.resolve_inputs.outputs.execute_plan }}",
);
const runVerdictStep = workflow.jobs.report.steps.find(
  ({ name }) => name === "Resolve perf run verdict",
);
assert.equal(runVerdictStep.id, "run-verdict");
assert.equal(runVerdictStep.if, "always()");
assert.equal(runVerdictStep.run, "node scripts/write-full-run-verdict.mjs");
assert.equal(
  runVerdictStep.env.PERF_LAB_SEED_AFFINITY_OUTCOME,
  "${{ steps.seed-affinity.outcome }}",
);
assert.equal(
  runVerdictStep.env.PERF_LAB_RESULT_ACCEPTANCE_OUTCOME,
  "${{ steps.result-acceptance.outcome }}",
);
for (const stepName of [
  "Report perf results to Teable",
  "Send Feishu perf summary",
  "Publish combined summary",
]) {
  const reportStep = workflow.jobs.report.steps.find(
    ({ name }) => name === stepName,
  );
  assert.equal(
    reportStep["continue-on-error"],
    true,
    `${stepName} must expose an independent outcome to the final full-run gate`,
  );
}
assert.ok(
  workflow.jobs.report.steps.some(
    ({ name }) => name === "Enforce full-run result and report acceptance",
  ),
);
const observeScript = await readFile(
  new URL("./observe-stage-plan.mjs", import.meta.url),
  "utf8",
);
assert.match(observeScript, /jobs\?filter=all/);
assert.doesNotMatch(observeScript, /loadCurrentAttemptJobs/);
const downloadSeedStep = workflow.jobs.report.steps.find(
  ({ name }) => name === "Download seed cache status artifacts",
);
assert.ok(downloadSeedStep);
assert.equal(downloadSeedStep.with["merge-multiple"], false);
assert.equal(
  downloadSeedStep.with["artifact-ids"],
  "${{ steps.perf_artifacts.outputs.seed_artifact_ids }}",
);
assert.equal(
  downloadSeedStep.if,
  "steps.perf_artifacts.outputs.seed_artifact_ids != ''",
);
const downloadSeedProvenanceStep = workflow.jobs.report.steps.find(
  ({ name }) => name === "Download prior seed payload provenance",
);
assert.equal(downloadSeedProvenanceStep.with["merge-multiple"], false);
assert.equal(
  downloadSeedProvenanceStep.with["artifact-ids"],
  "${{ steps.perf_artifacts.outputs.seed_provenance_artifact_ids }}",
);
assert.equal(
  downloadSeedProvenanceStep.if,
  "steps.perf_artifacts.outputs.seed_provenance_artifact_ids != ''",
);
const resolveArtifactsStep = workflow.jobs.report.steps.find(
  ({ name }) => name === "Resolve perf and seed artifact attempts",
);
assert.match(resolveArtifactsStep.run, /--slurp/);
assert.match(resolveArtifactsStep.run, /select-report-artifacts\.mjs/);
const downloadExecuteStep = workflow.jobs.report.steps.find(
  ({ name }) => name === "Download perf artifacts",
);
assert.equal(
  downloadExecuteStep.with["artifact-ids"],
  "${{ steps.perf_artifacts.outputs.execute_artifact_ids }}",
);
const uploadStep = workflow.jobs.report.steps.find(
  ({ name }) => name === "Upload current-run stage observation",
);
assert.equal(uploadStep.with["if-no-files-found"], "ignore");
assert.equal(uploadStep.if, "always()");
assert.equal(uploadStep.with.path, "perf-plan-observation");
const verifySeedAffinityStep = workflow.jobs.report.steps.find(
  ({ name }) => name === "Verify physical seed affinity",
);
assert.equal(
  verifySeedAffinityStep.if,
  "always() && needs.resolve_inputs.outputs.case_filter_is_all == 'true'",
);
assert.equal(verifySeedAffinityStep.id, "seed-affinity");
assert.equal(verifySeedAffinityStep["continue-on-error"], true);
assert.equal(
  verifySeedAffinityStep.run,
  "node scripts/verify-full-run-seed-affinity.mjs",
);
assert.ok(verifySeedAffinityStep.env.PERF_LAB_PLAN_SUMMARY);
assert.equal(
  verifySeedAffinityStep.env.PERF_LAB_SEED_PLAN,
  "${{ needs.resolve_inputs.outputs.seed_plan }}",
);
assert.ok(verifySeedAffinityStep.env.PERF_LAB_SEED_ARTIFACT_DIR);
assert.ok(verifySeedAffinityStep.env.PERF_LAB_SEED_PROVENANCE_ARTIFACT_DIR);
assert.ok(verifySeedAffinityStep.env.PERF_LAB_SEED_AFFINITY_OBSERVATION_PATH);
const reportStepNames = workflow.jobs.report.steps.map(({ name }) => name);
for (const reporterName of [
  "Report perf results to Teable",
  "Send Feishu perf summary",
  "Publish combined summary",
]) {
  const reporterStep = workflow.jobs.report.steps.find(
    ({ name }) => name === reporterName,
  );
  assert.ok(
    reportStepNames.indexOf(reporterName) >
      reportStepNames.indexOf("Resolve perf run verdict"),
    `${reporterName} must run after the run verdict`,
  );
  assert.equal(
    reporterStep.env.PERF_LAB_JOB_RESULT,
    "${{ steps.run-verdict.outputs.status }}",
  );
}
const enforceFullRunStep = workflow.jobs.report.steps.find(
  ({ name }) => name === "Enforce full-run result and report acceptance",
);
assert.match(
  enforceFullRunStep.if,
  /steps\.run-verdict\.outputs\.status != 'success'/,
);
assert.ok(
  reportStepNames.indexOf("Enforce full-run result and report acceptance") >
    reportStepNames.indexOf("Upload current-run stage observation"),
);

console.log("Stage plan observation checks passed.");
