import assert from "node:assert/strict";
import {
  buildAffinityStageBundles,
  planStageAwareShards,
  renderStagePlanSummaryMarkdown,
  simulateStageAwareShardPlans,
  STAGE_COST_KEYS,
} from "./stage-aware-shard-model.mjs";
import { FULL_RUN_STAGE_CALIBRATION } from "./full-run-stage-calibration.mjs";
import { validateFullRunCalibrationInputs } from "./refresh-full-run-calibration.mjs";
import { validateHistoricalSlotRefreshInputs } from "./refresh-full-run-historical-slots.mjs";
import { validateFullRunWarmCalibrationInputs } from "./accept-full-run-warm-calibration.mjs";
import {
  buildCaseSetDigest,
  SEED_CONTRACT_GENERATION,
} from "./seed-cache-model.mjs";

assert.deepEqual(STAGE_COST_KEYS, [
  "coldSeedMs",
  "v1Ms",
  "v2SyncMs",
  "v2HybridMs",
  "traceMs",
]);

assert.equal(FULL_RUN_STAGE_CALIBRATION.sourceRunId, "29979412537");
assert.equal(
  FULL_RUN_STAGE_CALIBRATION.sourcePerfLabSha,
  "b2c1530e85503db8d982d98c2b3047c7284ba73c",
);
assert.equal(
  FULL_RUN_STAGE_CALIBRATION.sourceCacheNamespace,
  "accept-b2c1530-20260723-01",
);
assert.equal(FULL_RUN_STAGE_CALIBRATION.pairedWarmRunId, "29981325193");
assert.equal(
  FULL_RUN_STAGE_CALIBRATION.pairedWarmRunUrl,
  "https://github.com/teableio/teable-perf-lab/actions/runs/29981325193",
);
assert.equal(FULL_RUN_STAGE_CALIBRATION.sourceSeedPlan.length, 8);
assert.equal(
  FULL_RUN_STAGE_CALIBRATION.caseCosts[
    "record-read/100k-50fields-filter-number-range-middle-half"
  ].v2Ms,
  64_208.23,
);
assert.equal(
  Object.keys(FULL_RUN_STAGE_CALIBRATION.caseCosts).length,
  316,
  "the trusted run must calibrate the complete default full selection",
);
assert.equal(
  FULL_RUN_STAGE_CALIBRATION.caseCosts[
    "record-duplicate/single-500-checkbox-500fields"
  ].v1Ms,
  173_813.28,
  "historical execute stragglers must not use the 10s default",
);
assert.ok(
  FULL_RUN_STAGE_CALIBRATION.caseCosts[
    "record-read/100k-50fields-filter-number-greater-half"
  ].coldSeedMs > 1_000_000,
  "100k record-read must not fall back to the old 1s seed estimate",
);
assert.ok(
  FULL_RUN_STAGE_CALIBRATION.caseCosts[
    "search/search-index-off-100k-20search-fields"
  ].coldSeedMs > 500_000,
  "100k search must not fall back to the old 1s seed estimate",
);
for (const [caseId, costs] of Object.entries(
  FULL_RUN_STAGE_CALIBRATION.caseCosts,
)) {
  for (const stage of ["coldSeedMs", "v1Ms", "v2Ms", "traceMs"]) {
    assert.ok(
      Number.isFinite(costs[stage]) && costs[stage] >= 0,
      `${caseId}.${stage} must come from the complete trusted run`,
    );
  }
}

const historicalSlotSeedPlan = [
  {
    name: "shard-1-of-1",
    stableSlot: "slot-1",
    caseSetDigest: buildCaseSetDigest(["case/a"]),
    seedContractGeneration: SEED_CONTRACT_GENERATION,
    caseFilter: "case/a",
  },
];
assert.deepEqual(
  validateHistoricalSlotRefreshInputs({
    sourceRunId: "12345",
    calibration: {
      sourceRunId: "12345",
      sourceSeedPlan: historicalSlotSeedPlan,
    },
    selectedCaseIds: ["case/a"],
  }),
  historicalSlotSeedPlan,
);
assert.throws(
  () =>
    validateHistoricalSlotRefreshInputs({
      sourceRunId: "12345",
      calibration: { sourceRunId: "12345", sourceSeedPlan: null },
      selectedCaseIds: ["case/a"],
    }),
  /non-empty validated calibration source seed plan/,
);
assert.throws(
  () =>
    validateHistoricalSlotRefreshInputs({
      sourceRunId: "12345",
      calibration: {
        sourceRunId: "12345",
        sourceSeedPlan: [
          { ...historicalSlotSeedPlan[0], caseSetDigest: "stale-digest" },
        ],
      },
      selectedCaseIds: ["case/a"],
    }),
  /invalid plan identity/,
);

const calibrationFixture = {
  sourceRunId: "12345",
  selectedCaseIds: ["case/a"],
  expectedShardCount: 1,
  seedStatusEntries: [
    {
      artifactName: "teable-ee-e2e-perf-seed-shard-1-of-1-12345-1",
      status: {
        mode: "cache-miss",
        requiresRunnerValidation: true,
        stableSlot: "slot-1",
        perfLabSha: "perf-sha",
        teableEeSha: "ee-sha",
      },
    },
  ],
  seedPayloadEntries: [
    {
      artifactName: "teable-ee-e2e-perf-seed-shard-1-of-1-12345-1",
      payload: {
        caseId: "case/a",
        engine: "seed",
        runId: "12345-1",
        result: "pass",
      },
    },
  ],
  resultPayloadEntries: [
    ...["v1", "v2"].map((engine) => ({
      artifactName: `teable-ee-e2e-perf-results-${engine}-shard-1-of-1-12345-1`,
      payload: {
        caseId: "case/a",
        engine,
        runId: "12345-1",
        result: "pass",
      },
    })),
  ],
  stageObservation: {
    sourceRunId: "12345",
    selectedShardCount: 1,
    cacheMode: "cold",
    complete: true,
    seedCacheObservation: {
      statusCount: 1,
      detectedMode: "cold",
    },
    observed: Object.fromEntries(
      ["coldSeedMs", "v1Ms", "v2SyncMs", "v2HybridMs", "traceMs"].map(
        (stage, index) => [stage, { durationMs: index + 1 }],
      ),
    ),
  },
  seedGate: {
    duplicates: [],
    affinityIssues: [],
    evidenceIssues: [],
  },
};
const validatedCalibration =
  validateFullRunCalibrationInputs(calibrationFixture);
assert.equal(validatedCalibration.perfLabSha, "perf-sha");
assert.equal(validatedCalibration.teableEeSha, "ee-sha");
assert.equal(validatedCalibration.artifactRunId, "12345-1");
assert.equal(validatedCalibration.resultsByCaseId.get("case/a").size, 2);
assert.throws(
  () =>
    validateFullRunCalibrationInputs({
      ...calibrationFixture,
      seedStatusEntries: calibrationFixture.seedStatusEntries.map((entry) => ({
        ...entry,
        status: { ...entry.status, mode: "exact-hit" },
      })),
    }),
  /all-cache-miss cold run/,
);
assert.throws(
  () =>
    validateFullRunCalibrationInputs({
      ...calibrationFixture,
      seedGate: {
        ...calibrationFixture.seedGate,
        duplicates: [{ seedHash: "duplicate" }],
      },
    }),
  /cross-shard duplicate/,
);

const warmCalibrationFixture = {
  sourceRunId: "12346",
  selectedCaseIds: ["case/a"],
  expectedShardCount: 1,
  seedPlan: [
    {
      name: "shard-1-of-1",
      stableSlot: "slot-1",
      caseSetDigest: "digest-a",
      seedContractGeneration: "seed-contract-v1",
      caseFilter: "case/a",
    },
  ],
  seedStatusEntries: [
    {
      artifactName: "teable-ee-e2e-perf-seed-shard-1-of-1-12346-1",
      status: {
        mode: "exact-hit",
        requiresRunnerValidation: false,
        stableSlot: "slot-1",
        caseSetDigest: "digest-a",
        seedContractGeneration: "seed-contract-v1",
        cacheNamespace: "acceptance",
        perfLabSha: "perf-sha",
        teableEeSha: "ee-sha",
        primaryKey: "exact-key",
        matchedKey: "exact-key",
      },
    },
  ],
  resultPayloadEntries: [
    ...["v1", "v2"].map((engine) => ({
      artifactName: `teable-ee-e2e-perf-results-${engine}-shard-1-of-1-12346-1`,
      payload: {
        caseId: "case/a",
        engine,
        runId: "12346-1",
        result: "pass",
      },
    })),
  ],
  stageObservation: {
    sourceRunId: "12346",
    selectedShardCount: 1,
    cacheMode: "warm",
    complete: true,
    seedCacheObservation: {
      statusCount: 1,
      detectedMode: "warm",
    },
    observed: Object.fromEntries(
      ["warmSeedMs", "v1Ms", "v2SyncMs", "v2HybridMs", "traceMs"].map(
        (stage, index) => [stage, { durationMs: index + 1 }],
      ),
    ),
  },
  coldCalibration: {
    sourceRunId: "12345",
    sourcePerfLabSha: "perf-sha",
    sourceTeableEeSha: "ee-sha",
    sourceCacheNamespace: "acceptance",
  },
};
const validatedWarmCalibration = validateFullRunWarmCalibrationInputs(
  warmCalibrationFixture,
);
assert.equal(validatedWarmCalibration.perfLabSha, "perf-sha");
assert.equal(validatedWarmCalibration.teableEeSha, "ee-sha");
assert.equal(validatedWarmCalibration.artifactRunId, "12346-1");
assert.equal(validatedWarmCalibration.observedStages.warmSeedMs, 1);
assert.throws(
  () =>
    validateFullRunWarmCalibrationInputs({
      ...warmCalibrationFixture,
      seedStatusEntries: warmCalibrationFixture.seedStatusEntries.map(
        (entry) => ({
          ...entry,
          status: { ...entry.status, teableEeSha: "different-ee-sha" },
        }),
      ),
    }),
  /does not match cold calibration/,
);
assert.throws(
  () =>
    validateFullRunWarmCalibrationInputs({
      ...warmCalibrationFixture,
      seedStatusEntries: warmCalibrationFixture.seedStatusEntries.map(
        (entry) => ({
          ...entry,
          status: {
            ...entry.status,
            mode: "compatible-candidate",
            requiresRunnerValidation: true,
          },
        }),
      ),
    }),
  /all-exact-hit warm run/,
);

const syntheticCaseCosts = {
  "shared-a": {
    coldSeedMs: 120,
    v1Ms: 10,
    v2SyncMs: 20,
    traceMs: 2,
  },
  "shared-b": {
    coldSeedMs: 100,
    v1Ms: 5,
    v2SyncMs: 25,
    traceMs: 3,
  },
  "execute-heavy": {
    coldSeedMs: 1,
    v1Ms: 120,
    v2SyncMs: 110,
    traceMs: 4,
  },
  "hybrid-heavy": {
    coldSeedMs: 1,
    v1Ms: 10,
    v2HybridMs: 100,
    traceMs: 4,
  },
};
const syntheticAffinities = [
  { id: "shared-fixture", caseIds: ["shared-a", "shared-b"] },
];
const syntheticBundles = buildAffinityStageBundles({
  caseIds: ["shared-a", "shared-b", "execute-heavy", "hybrid-heavy"],
  hybridCaseIds: ["hybrid-heavy"],
  affinities: syntheticAffinities,
  caseCosts: syntheticCaseCosts,
});
assert.deepEqual(
  syntheticBundles.find(({ id }) => id === "shared-fixture").stageCosts,
  {
    coldSeedMs: 120,
    v1Ms: 15,
    v2SyncMs: 45,
    v2HybridMs: 0,
    traceMs: 5,
  },
  "one physical seed is built once, while execute and trace costs remain per case",
);

const syntheticPlan = planStageAwareShards({
  caseIds: ["shared-a", "shared-b", "execute-heavy", "hybrid-heavy"],
  hybridCaseIds: ["hybrid-heavy"],
  shardCount: 2,
  affinities: syntheticAffinities,
  caseCosts: syntheticCaseCosts,
});
assert.equal(syntheticPlan.preservedBundleCount, 0);
assert.deepEqual(syntheticPlan.movedBundles, []);
assert.equal("preservedAffinityCount" in syntheticPlan, false);
assert.equal("movedAffinities" in syntheticPlan, false);
const shardOf = (plan, caseId) =>
  plan.caseShards.findIndex((caseIds) => caseIds.includes(caseId));
assert.equal(
  shardOf(syntheticPlan, "shared-a"),
  shardOf(syntheticPlan, "shared-b"),
);
assert.notEqual(
  shardOf(syntheticPlan, "shared-a"),
  shardOf(syntheticPlan, "execute-heavy"),
  "the seed straggler and execute straggler should not stack on one shard",
);
assert.equal(syntheticPlan.stageMaxima.coldSeedMs.bundleId, "shared-fixture");
assert.equal(syntheticPlan.stageMaxima.v1Ms.bundleId, "case:execute-heavy");
assert.equal(syntheticPlan.stageMaxima.v2HybridMs.durationMs, 100);

const modeIssues = () =>
  planStageAwareShards({
    caseIds: ["sync", "hybrid"],
    hybridCaseIds: ["hybrid"],
    shardCount: 2,
    affinities: [{ id: "cross-mode", caseIds: ["sync", "hybrid"] }],
    caseCosts: {
      sync: { coldSeedMs: 1, v1Ms: 1, v2SyncMs: 1, traceMs: 1 },
      hybrid: { coldSeedMs: 1, v1Ms: 1, v2HybridMs: 1, traceMs: 1 },
    },
  });
assert.throws(modeIssues, /crosses V2 sync and hybrid pools/);

const scalableCaseIds = Array.from(
  { length: 36 },
  (_, index) => `case-${String(index + 1).padStart(2, "0")}`,
);
const scalableCaseCosts = Object.fromEntries(
  scalableCaseIds.map((caseId, index) => [
    caseId,
    {
      coldSeedMs: index === 0 ? 1_000 : 100,
      v1Ms: index === 1 ? 900 : 100,
      v2SyncMs: index === 2 ? 800 : 100,
      traceMs: 10,
    },
  ]),
);
const simulationOptions = {
  caseIds: scalableCaseIds,
  hybridCaseIds: [],
  affinities: [],
  caseCosts: scalableCaseCosts,
  shardCounts: [6, 7, 8, 9, 10, 11, 12],
  coldSloMs: 2_400,
  warmSloMs: 1_300,
  fixedCosts: {
    coldSeedSetupMs: 100,
    warmSeedMs: 50,
    executeSetupMs: 100,
    reportMs: 50,
    traceJobBudgetMs: 60,
  },
  observedStages: {
    sourceRunId: "synthetic-observed",
    coldSeedMs: 2_600,
    v1Ms: 1_700,
    v2SyncMs: 1_600,
    v2HybridMs: 0,
    traceMs: 300,
  },
};
const firstSimulation = simulateStageAwareShardPlans(simulationOptions);
const secondSimulation = simulateStageAwareShardPlans(simulationOptions);
assert.deepEqual(
  firstSimulation,
  secondSimulation,
  "planning must be deterministic",
);
assert.deepEqual(
  firstSimulation.candidates.map(({ shardCount }) => shardCount),
  [6, 7, 8, 9, 10, 11, 12],
);
assert.equal(
  firstSimulation.selected.shardCount,
  firstSimulation.candidates.find(
    ({ criticalPath }) =>
      criticalPath.meetsColdSlo && criticalPath.meetsWarmSlo,
  ).shardCount,
  "select the lowest concurrency that meets both SLOs",
);
for (const candidate of firstSimulation.candidates) {
  assert.equal(candidate.caseShards.flat().length, scalableCaseIds.length);
  assert.equal(
    new Set(candidate.caseShards.flat()).size,
    scalableCaseIds.length,
  );
  assert.ok(candidate.concurrencyCost.seedJobs >= 6);
  assert.equal(
    candidate.concurrencyCost.peakJobs,
    Math.max(
      candidate.concurrencyCost.seedJobs,
      candidate.concurrencyCost.executeJobs,
    ),
  );
  assert.ok(candidate.stageMaxima.coldSeedMs.shard.startsWith("shard-"));
  assert.ok(Number.isFinite(candidate.estimatedCacheImpactMs));
}
assert.deepEqual(firstSimulation.summary.predicted, {
  coldSeedMs:
    firstSimulation.selected.stageMaxima.coldSeedMs.durationMs +
    simulationOptions.fixedCosts.coldSeedSetupMs,
  v1Ms:
    firstSimulation.selected.stageMaxima.v1Ms.durationMs +
    simulationOptions.fixedCosts.executeSetupMs,
  v2SyncMs:
    firstSimulation.selected.stageMaxima.v2SyncMs.durationMs +
    simulationOptions.fixedCosts.executeSetupMs,
  v2HybridMs: 0,
  traceMs: firstSimulation.selected.stageMaxima.traceMs.durationMs,
  warmSeedMs: simulationOptions.fixedCosts.warmSeedMs,
  coldWallMs: firstSimulation.selected.criticalPath.coldWallMs,
  warmWallMs: firstSimulation.selected.criticalPath.warmWallMs,
});
assert.equal(
  firstSimulation.summary.observed.sourceRunId,
  "synthetic-observed",
);
assert.equal(
  firstSimulation.summary.calibrationDeltaMs.coldSeedMs,
  firstSimulation.summary.predicted.coldSeedMs - 2_600,
);
assert.match(
  renderStagePlanSummaryMarkdown(firstSimulation),
  /Predicted vs observed stage maxima/,
);
assert.match(
  renderStagePlanSummaryMarkdown(firstSimulation),
  /6 through 12 shards/,
);
assert.match(
  renderStagePlanSummaryMarkdown(firstSimulation),
  /shard-\d+-of-\d+/,
);
assert.match(
  renderStagePlanSummaryMarkdown(firstSimulation),
  /Peak \/ total jobs/,
);

const v1OnlySimulation = simulateStageAwareShardPlans({
  ...simulationOptions,
  activeExecuteStages: ["v1Ms"],
});
assert.deepEqual(v1OnlySimulation.summary.activeStages, [
  "coldSeedMs",
  "v1Ms",
  "traceMs",
]);
assert.equal(v1OnlySimulation.selected.stageMaxima.v2SyncMs.durationMs, 0);
assert.equal(v1OnlySimulation.selected.stageMaxima.v2HybridMs.durationMs, 0);
assert.equal(v1OnlySimulation.selected.concurrencyCost.v2SyncJobs, 0);
assert.equal(v1OnlySimulation.selected.concurrencyCost.v2HybridJobs, 0);
assert.equal(v1OnlySimulation.summary.predicted.warmSeedMs, 50);

console.log("Stage-aware shard model checks passed.");
