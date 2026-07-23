import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSeedIdentityCaseId } from "../framework/seed-contract.ts";
import {
  FULL_RUN_FIXTURE_AFFINITIES,
  FULL_RUN_MAX_SHARD_COUNT,
  FULL_RUN_SCALE_REPLACEMENTS,
  FULL_RUN_TARGET_CASES_PER_SHARD,
  planCaseIdsByFixtureAffinity,
  resolveFullRunCaseIds,
  resolveFixtureAffinities,
  resolveFullRunShardCount,
  shardCaseIdsByFixtureAffinity,
  validateFullRunScaleReplacements,
  validateFixtureAffinities,
  validateShardAffinityAssignments,
} from "./full-run-shard-model.mjs";
import { FULL_RUN_HISTORICAL_BUNDLE_SLOTS } from "./full-run-historical-bundle-slots.mjs";
import { FULL_RUN_STAGE_CALIBRATION } from "./full-run-stage-calibration.mjs";
import {
  buildCaseFilterKey,
  buildFullRunShardCaseFilterKey,
  HYBRID_COMPUTED_CASES,
  loadRegisteredCases,
  parseCaseAcceptanceContract,
  parseCaseSeedAffinity,
  renderPlanSummaryMarkdown,
  resolveRunPlan,
  writeGithubOutputs,
} from "./run-plan.mjs";
import {
  buildCaseSetDigest,
  SEED_CONTRACT_GENERATION,
} from "./seed-cache-model.mjs";
import {
  buildAffinityStageBundles,
  simulateStageAwareShardPlans,
} from "./stage-aware-shard-model.mjs";

const registeredCases = await loadRegisteredCases();
const allCaseIds = registeredCases.map(({ id }) => id);
const observedSeedAffinityFixture = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/full-run-feedback/run-29957965247-seed-affinities.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const expectedFullRunCaseIds = resolveFullRunCaseIds({ allCaseIds });
assert.deepEqual(
  Object.keys(FULL_RUN_STAGE_CALIBRATION.caseCosts).sort(),
  expectedFullRunCaseIds.slice().sort(),
  "the trusted calibration must cover exactly the default full-run case set",
);
const hybridCaseIdSet = new Set(HYBRID_COMPUTED_CASES);
for (const caseId of observedSeedAffinityFixture.affinities
  .filter(({ affinityId }) => affinityId.startsWith("computed-chain/"))
  .flatMap(({ caseIds }) => caseIds)) {
  assert.equal(
    hybridCaseIdSet.has(caseId),
    true,
    `${caseId} uses the computed-chain runner and must execute in the hybrid V2 pool`,
  );
}
const legacyFullRunShardCount = resolveFullRunShardCount(
  expectedFullRunCaseIds.length,
);
const targetSeedAffinityDeclarations = [
  {
    caseId: "record-read/100k-50fields-filter-number-greater-half",
    affinityId: "record-read/100k-50fields",
  },
  {
    caseId: "record-read/100k-50fields-filter-number-range-middle-half",
    affinityId: "record-read/100k-50fields",
  },
  {
    caseId: "record-read/100k-50fields-filter-number-sort-descending",
    affinityId: "record-read/100k-50fields",
  },
  {
    caseId: "search/search-index-off-100k-20search-fields",
    affinityId: "lookup-search-index/100k-20fields",
  },
  {
    caseId: "search/search-index-on-100k-20search-fields",
    affinityId: "lookup-search-index/100k-20fields",
  },
];
const registeredSeedAffinityDeclarations = registeredCases
  .filter(({ seedAffinity }) => seedAffinity != null)
  .map(({ id, seedAffinity }) => ({
    caseId: id,
    affinityId: seedAffinity,
  }));
for (const observedAffinity of observedSeedAffinityFixture.affinities) {
  const actualCaseIds = registeredSeedAffinityDeclarations
    .filter(({ affinityId }) => affinityId === observedAffinity.affinityId)
    .map(({ caseId }) => caseId)
    .sort();
  assert.deepEqual(
    actualCaseIds,
    observedAffinity.caseIds.slice().sort(),
    `${observedAffinity.affinityId} must declare every case observed with seed ${observedAffinity.seedHash}`,
  );
}
assert.deepEqual(
  registeredSeedAffinityDeclarations
    .filter(({ caseId }) =>
      targetSeedAffinityDeclarations.some(
        (declaration) => declaration.caseId === caseId,
      ),
    )
    .sort((left, right) => left.caseId.localeCompare(right.caseId)),
  targetSeedAffinityDeclarations
    .slice()
    .sort((left, right) => left.caseId.localeCompare(right.caseId)),
);
assert.equal(
  resolveSeedIdentityCaseId(
    {
      id: "record-read/query-a",
      seedAffinity: "record-read/100k-50fields",
    },
    "record-read/shared-fixture",
  ),
  resolveSeedIdentityCaseId(
    {
      id: "record-read/query-b",
      seedAffinity: "record-read/100k-50fields",
    },
    "record-read/shared-fixture",
  ),
);
assert.equal(
  resolveSeedIdentityCaseId(
    { id: "record-read/legacy-query" },
    "record-read/shared-fixture",
  ),
  "record-read/shared-fixture",
);
assert.throws(
  () =>
    parseCaseSeedAffinity(`
      seedAffinity: "fixture/first",
      seedAffinity: "fixture/second",
    `),
  /seedAffinity must be declared at most once per case/,
);
assert.throws(
  () => parseCaseSeedAffinity('seedAffinity: "   ",'),
  /seedAffinity must be a non-empty string literal/,
);
assert.deepEqual(
  parseCaseAcceptanceContract(`
    routingEvidence: "not-applicable",
    expectedSkipEngines: ["v1"],
  `),
  {
    routingEvidence: "not-applicable",
    expectedSkipEngines: ["v1"],
  },
);
assert.throws(
  () => parseCaseAcceptanceContract('routingEvidence: "optional",'),
  /routingEvidence must be declared at most once/,
);
assert.throws(
  () => parseCaseAcceptanceContract("expectedSkipEngines: [],"),
  /expectedSkipEngines must not be empty/,
);
assert.throws(
  () => parseCaseSeedAffinity("seedAffinity: sharedSeedAffinity,"),
  /seedAffinity must be a non-empty string literal/,
);
assert.throws(
  () =>
    resolveFixtureAffinities({
      affinities: [
        { id: "duplicate", caseIds: ["a"] },
        { id: "duplicate", caseIds: ["b"] },
      ],
    }),
  /Duplicate fixture affinity id: duplicate/,
);
assert.throws(
  () =>
    resolveFixtureAffinities({
      affinities: [],
      seedAffinityDeclarations: [
        { caseId: "a", affinityId: "shared-a" },
        { caseId: "a", affinityId: "shared-a" },
      ],
    }),
  /Duplicate seed affinity declaration for case a/,
);
assert.deepEqual(
  validateShardAffinityAssignments({
    caseShards: [["a", "c"], ["b"]],
    affinities: [{ id: "shared-ab", caseIds: ["a", "b"] }],
  }),
  ["Fixture affinity shared-ab spans seed shards: shard-1=[a], shard-2=[b]"],
);
assert.throws(
  () =>
    resolveFixtureAffinities({
      affinities: [],
      seedAffinityDeclarations: [{ caseId: "", affinityId: "shared" }],
    }),
  /Seed affinity declaration caseId must be a non-empty string/,
);
assert.throws(
  () =>
    resolveFixtureAffinities({
      affinities: [],
      seedAffinityDeclarations: [{ caseId: "a", affinityId: "   " }],
    }),
  /Seed affinity declaration affinityId must be a non-empty string/,
);
const declaredUnknownAffinity = resolveFixtureAffinities({
  affinities: [],
  seedAffinityDeclarations: [
    { caseId: "missing", affinityId: "declared-unknown" },
  ],
});
assert.deepEqual(
  validateFixtureAffinities({
    allCaseIds: ["known"],
    affinities: declaredUnknownAffinity,
  }),
  ["Fixture affinity declared-unknown references unknown case missing"],
);
const declaredCrossModeAffinity = resolveFixtureAffinities({
  affinities: [],
  seedAffinityDeclarations: [
    { caseId: "sync", affinityId: "declared-cross-mode" },
    { caseId: "hybrid", affinityId: "declared-cross-mode" },
  ],
});
assert.deepEqual(
  validateFixtureAffinities({
    allCaseIds: ["sync", "hybrid"],
    hybridCaseIds: ["hybrid"],
    affinities: declaredCrossModeAffinity,
  }),
  ["Fixture affinity declared-cross-mode crosses V2 sync and hybrid pools"],
);

const assertShardedPlan = ({
  plans,
  expectedCaseShards,
  name,
  engine,
  computedUpdateMode,
  artifactSuffix,
  otelServiceSuffix,
}) => {
  const shardCount = expectedCaseShards.length;
  const expectedPlans = expectedCaseShards.flatMap((caseIds, index) => {
    if (caseIds.length === 0) {
      return [];
    }
    const shardNumber = index + 1;
    const shardLabel = `shard-${shardNumber}-of-${shardCount}`;
    return [
      {
        name: `${name}-${shardLabel}`,
        engine,
        caseFilter: caseIds.join(","),
        excludeCaseFilter: "",
        computedUpdateMode,
        artifactSuffix: `${artifactSuffix}-${shardLabel}`,
        otelServiceSuffix: `${otelServiceSuffix}-${shardLabel}`,
        seedArtifactSuffix: shardLabel,
      },
    ];
  });
  assert.deepEqual(plans, expectedPlans);

  const shardedCaseIds = plans.flatMap((plan) => plan.caseFilter.split(","));
  const expectedCaseIds = expectedCaseShards.flat();
  assert.equal(new Set(shardedCaseIds).size, expectedCaseIds.length);
  assert.deepEqual(
    shardedCaseIds.slice().sort(),
    expectedCaseIds.slice().sort(),
  );
};

const assertThrowsMessage = (label, fn, expectedMessage) => {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error?.message, expectedMessage, label);
      return true;
    },
    label,
  );
};

const defaultFullRunPlan = resolveRunPlan({
  engineFilter: "v1,v2",
  caseFilter: "all",
  computedUpdateMode: "",
  allCaseIds,
  seedAffinityDeclarations: registeredSeedAffinityDeclarations,
});

assert.deepEqual(defaultFullRunPlan.engines, ["v1", "v2"]);
assert.equal(defaultFullRunPlan.caseFilterIsAll, true);
assert.equal(defaultFullRunPlan.caseFilterKey, "all");
assert.equal(defaultFullRunPlan.seedCacheNamespace, "");
const selectedFullRunShardCount = defaultFullRunPlan.planSummary.shardCount;
assert.equal(selectedFullRunShardCount, 8);
assert.equal(defaultFullRunPlan.seedPlan.length, selectedFullRunShardCount);
assert.deepEqual(
  defaultFullRunPlan.planSummary.stagePlan.candidateShardCounts,
  [6, 7, 8, 9, 10, 11, 12],
);
assert.equal(
  defaultFullRunPlan.planSummary.stagePlan.selectedShardCount,
  selectedFullRunShardCount,
);
assert.equal(
  defaultFullRunPlan.planSummary.stagePlan.calibrationSource.sourceRunId,
  "29979412537",
);
assert.equal(
  defaultFullRunPlan.planSummary.stagePlan.calibrationSource.pairedWarmRunId,
  "29981325193",
);
assert.equal(defaultFullRunPlan.planSummary.stagePlan.observed, null);
assert.equal(defaultFullRunPlan.planSummary.stagePlan.calibrationDeltaMs, null);
assert.deepEqual(defaultFullRunPlan.planSummary.stagePlan.activeStages, [
  "coldSeedMs",
  "v1Ms",
  "v2SyncMs",
  "v2HybridMs",
  "traceMs",
]);
assert.deepEqual(defaultFullRunPlan.planSummary.stagePlan.executionProfile, {
  engines: ["v1", "v2"],
  v2Mode: "split",
});
assert.deepEqual(
  defaultFullRunPlan.planSummary.movedBundles,
  [],
  "the accepted calibrated plan must be the stable cache baseline",
);
assert.equal(
  defaultFullRunPlan.planSummary.estimatedCacheImpactMs,
  defaultFullRunPlan.planSummary.movedBundles.reduce(
    (total, movement) => total + movement.estimatedCacheImpactMs,
    0,
  ),
);
assert.ok(
  defaultFullRunPlan.planSummary.stagePlan.predicted.coldWallMs <=
    defaultFullRunPlan.planSummary.stagePlan.baselineCriticalPath.coldWallMs,
  "selected stage-aware plan must not regress the scalar baseline cold path",
);
assert.ok(
  defaultFullRunPlan.planSummary.stagePlan.predicted.warmWallMs <=
    defaultFullRunPlan.planSummary.stagePlan.baselineCriticalPath.warmWallMs,
  "selected stage-aware plan must not regress the scalar baseline warm path",
);
const observedColdWallMs =
  FULL_RUN_STAGE_CALIBRATION.observedStages.coldSeedMs +
  Math.max(
    FULL_RUN_STAGE_CALIBRATION.observedStages.v1Ms,
    FULL_RUN_STAGE_CALIBRATION.observedStages.v2SyncMs,
    FULL_RUN_STAGE_CALIBRATION.observedStages.v2HybridMs,
  ) +
  FULL_RUN_STAGE_CALIBRATION.observedStages.traceMs +
  FULL_RUN_STAGE_CALIBRATION.fixedCosts.reportMs;
assert.ok(
  observedColdWallMs <= 45 * 60_000,
  "the trusted cold observation must remain within the 45 minute SLO",
);
assert.ok(
  defaultFullRunPlan.planSummary.stagePlan.predicted.coldWallMs <=
    observedColdWallMs + FULL_RUN_STAGE_CALIBRATION.fixedCosts.executeSetupMs,
  "the conservative cold prediction must stay within one execute setup envelope of the accepted observation",
);
assert.ok(
  defaultFullRunPlan.planSummary.stagePlan.predicted.warmWallMs <= 25 * 60_000,
  "the trusted warm calibration must select a plan within the 25 minute SLO",
);
const firstEligibleCandidate =
  defaultFullRunPlan.planSummary.stagePlan.candidates.find(
    ({ criticalPath }) =>
      criticalPath.meetsColdSlo &&
      criticalPath.meetsWarmSlo &&
      criticalPath.coldWallMs <=
        defaultFullRunPlan.planSummary.stagePlan.baselineCriticalPath
          .coldWallMs &&
      criticalPath.warmWallMs <=
        defaultFullRunPlan.planSummary.stagePlan.baselineCriticalPath
          .warmWallMs,
  );
if (firstEligibleCandidate) {
  assert.equal(firstEligibleCandidate.shardCount, selectedFullRunShardCount);
} else {
  const bestConservativeCandidate =
    defaultFullRunPlan.planSummary.stagePlan.candidates
      .slice()
      .sort(
        (left, right) =>
          left.criticalPath.coldWallMs - right.criticalPath.coldWallMs ||
          left.criticalPath.warmWallMs - right.criticalPath.warmWallMs ||
          left.shardCount - right.shardCount,
      )[0];
  assert.equal(
    bestConservativeCandidate.shardCount,
    selectedFullRunShardCount,
    "when preserved historical maxima exceed the SLO, select the best conservative plan backed by the accepted observation",
  );
}
assert.equal(
  defaultFullRunPlan.planSummary.stagePlan.candidates[0].stageMaxima.coldSeedMs
    .bundleId,
  "record-read/100k-50fields",
);
assert.ok(
  defaultFullRunPlan.planSummary.stagePlan.candidates[0].stageMaxima.v1Ms
    .durationMs > 100_000,
  "historical execute telemetry must identify a real execute straggler instead of the 10s default",
);
const fullRunCaseShards = defaultFullRunPlan.seedPlan.map((plan, index) => {
  const shardLabel = `shard-${index + 1}-of-${selectedFullRunShardCount}`;
  assert.equal(plan.name, shardLabel);
  const caseIds = plan.caseFilter.split(",");
  assert.equal(
    plan.caseFilterKey,
    buildFullRunShardCaseFilterKey(shardLabel, caseIds),
  );
  assert.equal(plan.caseSetDigest, buildCaseSetDigest(caseIds));
  assert.equal(plan.stableSlot, `slot-${index + 1}`);
  assert.equal(plan.seedContractGeneration, SEED_CONTRACT_GENERATION);
  assert.equal(plan.artifactSuffix, shardLabel);
  return caseIds;
});
assert.equal(legacyFullRunShardCount, 8);
assert.deepEqual(
  fullRunCaseShards.flat().slice().sort(),
  expectedFullRunCaseIds.slice().sort(),
);
assert.equal(Object.keys(FULL_RUN_SCALE_REPLACEMENTS).length, 71);
assert.equal(expectedFullRunCaseIds.length, allCaseIds.length - 71);
for (const [omittedCaseId, replacementCaseId] of Object.entries(
  FULL_RUN_SCALE_REPLACEMENTS,
)) {
  assert.equal(
    fullRunCaseShards.flat().includes(omittedCaseId),
    false,
    `${omittedCaseId} must be omitted from full runs`,
  );
  assert.equal(
    fullRunCaseShards.flat().includes(replacementCaseId),
    true,
    `${replacementCaseId} must replace ${omittedCaseId} in full runs`,
  );
}
const [targetedOmittedCaseId] = Object.keys(FULL_RUN_SCALE_REPLACEMENTS);
const targetedOmittedCasePlan = resolveRunPlan({
  engineFilter: "v1",
  caseFilter: targetedOmittedCaseId,
  computedUpdateMode: "",
  allCaseIds,
});
assert.equal(
  targetedOmittedCasePlan.executePlan[0].caseFilter,
  targetedOmittedCaseId,
  "small-scale cases omitted from full runs must remain runnable by exact filter",
);
assert.equal(targetedOmittedCasePlan.caseFilterIsAll, false);
const normalizedFullRunPlan = resolveRunPlan({
  engineFilter: "v1,v2",
  caseFilter: " ALL ",
  computedUpdateMode: "",
  allCaseIds,
  seedAffinityDeclarations: registeredSeedAffinityDeclarations,
});
assert.equal(normalizedFullRunPlan.caseFilterIsAll, true);
const isolatedCachePlan = resolveRunPlan({
  engineFilter: "v1,v2",
  caseFilter: "all",
  computedUpdateMode: "",
  seedCacheNamespace: " ticket-07-cold-warm ",
  allCaseIds,
  seedAffinityDeclarations: registeredSeedAffinityDeclarations,
});
assert.equal(isolatedCachePlan.seedCacheNamespace, "ticket-07-cold-warm");
assert.equal(
  isolatedCachePlan.planSummary.seedCacheNamespace,
  "ticket-07-cold-warm",
);
assert.match(
  renderPlanSummaryMarkdown(isolatedCachePlan.planSummary),
  /Seed cache namespace: ticket-07-cold-warm/,
);
const outputTempDir = await mkdtemp(join(tmpdir(), "perf-run-plan-output-"));
try {
  const defaultOutputPath = join(outputTempDir, "default.output");
  const isolatedOutputPath = join(outputTempDir, "isolated.output");
  writeGithubOutputs(defaultFullRunPlan, defaultOutputPath);
  writeGithubOutputs(isolatedCachePlan, isolatedOutputPath);
  const defaultOutput = await readFile(defaultOutputPath, "utf8");
  const isolatedOutput = await readFile(isolatedOutputPath, "utf8");
  assert.match(defaultOutput, /^seed_cache_namespace=$/m);
  assert.match(defaultOutput, /^case_filter_is_all=true$/m);
  assert.match(defaultOutput, /^seed_cache_namespace_segment=$/m);
  assert.match(isolatedOutput, /^seed_cache_namespace=ticket-07-cold-warm$/m);
  assert.match(
    isolatedOutput,
    /^seed_cache_namespace_segment=ticket-07-cold-warm-$/m,
  );
} finally {
  await rm(outputTempDir, { recursive: true, force: true });
}

const shardIndexByCaseId = new Map();
fullRunCaseShards.forEach((caseIds, shardIndex) =>
  caseIds.forEach((caseId) => shardIndexByCaseId.set(caseId, shardIndex)),
);
for (const affinity of FULL_RUN_FIXTURE_AFFINITIES) {
  const activeAffinityCaseIds = affinity.caseIds.filter((caseId) =>
    shardIndexByCaseId.has(caseId),
  );
  if (activeAffinityCaseIds.length < 2) {
    continue;
  }
  assert.equal(
    new Set(
      activeAffinityCaseIds.map((caseId) => shardIndexByCaseId.get(caseId)),
    ).size,
    1,
    `${affinity.id} must stay in one seed shard`,
  );
}
for (const affinityId of [
  "record-read/100k-50fields",
  "lookup-search-index/100k-20fields",
  ...observedSeedAffinityFixture.affinities.map(({ affinityId }) => affinityId),
]) {
  const caseIds = registeredSeedAffinityDeclarations
    .filter((declaration) => declaration.affinityId === affinityId)
    .map((declaration) => declaration.caseId);
  assert.equal(
    new Set(caseIds.map((caseId) => shardIndexByCaseId.get(caseId))).size,
    1,
    `${affinityId} authoritative seed affinity must stay in one seed shard`,
  );
}

const resolvedFullRunAffinities = resolveFixtureAffinities({
  seedAffinityDeclarations: registeredSeedAffinityDeclarations,
});
const currentBundleIds = buildAffinityStageBundles({
  caseIds: expectedFullRunCaseIds,
  hybridCaseIds: HYBRID_COMPUTED_CASES,
  affinities: resolvedFullRunAffinities,
  caseCosts: FULL_RUN_STAGE_CALIBRATION.caseCosts,
}).map(({ id }) => id);
assert.equal(currentBundleIds.length, 205);
assert.deepEqual(
  currentBundleIds.filter(
    (bundleId) => FULL_RUN_HISTORICAL_BUNDLE_SLOTS[bundleId] == null,
  ),
  [],
  "historical slots must cover singleton and shared-affinity bundles",
);
const unrelatedRemovedCaseId = "record-update/1k-number-fields-bulk-update";
const planCalibratedShards = (caseIds) =>
  simulateStageAwareShardPlans({
    caseIds,
    hybridCaseIds: HYBRID_COMPUTED_CASES,
    affinities: resolvedFullRunAffinities,
    caseCosts: FULL_RUN_STAGE_CALIBRATION.caseCosts,
    preferredSlotByBundle: FULL_RUN_HISTORICAL_BUNDLE_SLOTS,
    shardCounts: [selectedFullRunShardCount],
  }).selected;
const stableFullPlan = planCalibratedShards(expectedFullRunCaseIds);
const stableAfterUnrelatedRemoval = planCalibratedShards(
  expectedFullRunCaseIds.filter((caseId) => caseId !== unrelatedRemovedCaseId),
);
const slotsByCaseId = (plan) =>
  new Map(
    plan.caseShards.flatMap((caseIds, shardIndex) =>
      caseIds.map((caseId) => [caseId, shardIndex + 1]),
    ),
  );
const stableFullSlots = slotsByCaseId(stableFullPlan);
const stableAfterRemovalSlots = slotsByCaseId(stableAfterUnrelatedRemoval);
const unrelatedMovedCaseIds = expectedFullRunCaseIds.filter(
  (caseId) =>
    caseId !== unrelatedRemovedCaseId &&
    stableFullSlots.get(caseId) !== stableAfterRemovalSlots.get(caseId),
);
assert.ok(
  unrelatedMovedCaseIds.length <= 2,
  `one cheap catalog removal moved ${unrelatedMovedCaseIds.length} unrelated cases`,
);

assertShardedPlan({
  plans: defaultFullRunPlan.executePlan.filter(({ name }) =>
    name.startsWith("v1-shard-"),
  ),
  expectedCaseShards: fullRunCaseShards,
  name: "v1",
  engine: "v1",
  computedUpdateMode: "",
  artifactSuffix: "v1",
  otelServiceSuffix: "v1",
});
assertShardedPlan({
  plans: defaultFullRunPlan.executePlan.filter(({ name }) =>
    name.startsWith("v2-sync-default-shard-"),
  ),
  expectedCaseShards: fullRunCaseShards.map((caseIds) =>
    caseIds.filter((caseId) => !hybridCaseIdSet.has(caseId)),
  ),
  name: "v2-sync-default",
  engine: "v2",
  computedUpdateMode: "",
  artifactSuffix: "v2",
  otelServiceSuffix: "v2-sync",
});
assertShardedPlan({
  plans: defaultFullRunPlan.executePlan.filter(({ name }) =>
    name.startsWith("v2-hybrid-computed-shard-"),
  ),
  expectedCaseShards: fullRunCaseShards.map((caseIds) =>
    caseIds.filter((caseId) => hybridCaseIdSet.has(caseId)),
  ),
  name: "v2-hybrid-computed",
  engine: "v2",
  computedUpdateMode: "hybrid",
  artifactSuffix: "v2-hybrid-computed",
  otelServiceSuffix: "v2-hybrid",
});

const explicitHybridFullRunPlan = resolveRunPlan({
  engineFilter: "v2",
  caseFilter: "all",
  computedUpdateMode: "hybrid",
  allCaseIds,
  seedAffinityDeclarations: registeredSeedAffinityDeclarations,
});

assert.deepEqual(explicitHybridFullRunPlan.engines, ["v2"]);
assert.equal(explicitHybridFullRunPlan.caseFilterKey, "all");
assert.deepEqual(
  explicitHybridFullRunPlan.planSummary.stagePlan.executionProfile,
  { engines: ["v2"], v2Mode: "hybrid" },
);
assert.deepEqual(explicitHybridFullRunPlan.planSummary.stagePlan.activeStages, [
  "coldSeedMs",
  "v2HybridMs",
  "traceMs",
]);
for (const candidate of explicitHybridFullRunPlan.planSummary.stagePlan
  .candidates) {
  assert.equal(candidate.stageMaxima.v1Ms.durationMs, 0);
  assert.equal(candidate.stageMaxima.v2SyncMs.durationMs, 0);
  assert.ok(candidate.stageMaxima.v2HybridMs.durationMs > 0);
  assert.equal(candidate.concurrencyCost.v1Jobs, 0);
  assert.equal(candidate.concurrencyCost.v2SyncJobs, 0);
}

assert.deepEqual(
  validateFullRunScaleReplacements({
    allCaseIds: ["small", "large"],
    replacements: { small: "large" },
  }),
  [],
);
assert.deepEqual(
  validateFullRunScaleReplacements({
    allCaseIds: ["small", "large"],
    replacements: {
      missing: "large",
      small: "missing-replacement",
      large: "large",
    },
  }),
  [
    "Full-run scale policy references unknown case missing",
    "Full-run scale policy replacement is also omitted: missing -> large",
    "Full-run scale policy replacement is unknown: small -> missing-replacement",
    "Full-run scale policy replaces large with itself",
    "Full-run scale policy replacement is also omitted: large -> large",
  ],
);
assertShardedPlan({
  plans: explicitHybridFullRunPlan.executePlan,
  expectedCaseShards: explicitHybridFullRunPlan.seedPlan.map((plan) =>
    plan.caseFilter.split(","),
  ),
  name: "v2",
  engine: "v2",
  computedUpdateMode: "hybrid",
  artifactSuffix: "v2",
  otelServiceSuffix: "v2",
});

const v1OnlyFullRunPlan = resolveRunPlan({
  engineFilter: "v1",
  caseFilter: "all",
  computedUpdateMode: "",
  allCaseIds,
  seedAffinityDeclarations: registeredSeedAffinityDeclarations,
});
assert.deepEqual(v1OnlyFullRunPlan.planSummary.stagePlan.executionProfile, {
  engines: ["v1"],
  v2Mode: "none",
});
assert.deepEqual(v1OnlyFullRunPlan.planSummary.stagePlan.activeStages, [
  "coldSeedMs",
  "v1Ms",
  "traceMs",
]);
for (const candidate of v1OnlyFullRunPlan.planSummary.stagePlan.candidates) {
  assert.equal(candidate.stageMaxima.v2SyncMs.durationMs, 0);
  assert.equal(candidate.stageMaxima.v2HybridMs.durationMs, 0);
  assert.equal(candidate.concurrencyCost.v2SyncJobs, 0);
  assert.equal(candidate.concurrencyCost.v2HybridJobs, 0);
}

assert.deepEqual(
  resolveRunPlan({
    engineFilter: " v2, v1, v2 ",
    caseFilter: " formula/10k-calc,smoke/auth-user ",
    computedUpdateMode: "",
    allCaseIds,
  }),
  {
    engines: ["v2", "v1"],
    caseFilterIsAll: false,
    caseFilterKey: "formula-10k-calc__smoke-auth-user",
    seedPlan: [
      {
        name: "seed",
        caseFilter: " formula/10k-calc,smoke/auth-user ",
        caseFilterKey: "formula-10k-calc__smoke-auth-user",
        caseSetDigest: buildCaseSetDigest([
          "formula/10k-calc",
          "smoke/auth-user",
        ]),
        stableSlot: "targeted",
        seedContractGeneration: SEED_CONTRACT_GENERATION,
        artifactSuffix: "seed",
      },
    ],
    executePlan: [
      {
        name: "v2",
        engine: "v2",
        caseFilter: " formula/10k-calc,smoke/auth-user ",
        excludeCaseFilter: "",
        computedUpdateMode: "",
        artifactSuffix: "v2",
        otelServiceSuffix: "v2",
        seedArtifactSuffix: "seed",
      },
      {
        name: "v1",
        engine: "v1",
        caseFilter: " formula/10k-calc,smoke/auth-user ",
        excludeCaseFilter: "",
        computedUpdateMode: "",
        artifactSuffix: "v1",
        otelServiceSuffix: "v1",
        seedArtifactSuffix: "seed",
      },
    ],
    seedCacheNamespace: "",
    planSummary: {
      shardCount: 1,
      stableSlotCount: 1,
      preservedBundleCount: 0,
      movedBundles: [],
      estimatedCacheImpactMs: 0,
    },
  },
);

const syntheticAffinityShards = shardCaseIdsByFixtureAffinity({
  caseIds: ["a", "b", "c", "d", "e"],
  shardCount: 2,
  affinities: [{ id: "shared-ab", caseIds: ["a", "b"] }],
});
assert.equal(
  syntheticAffinityShards.findIndex((caseIds) => caseIds.includes("a")),
  syntheticAffinityShards.findIndex((caseIds) => caseIds.includes("b")),
);
assert.deepEqual(syntheticAffinityShards.flat().slice().sort(), [
  "a",
  "b",
  "c",
  "d",
  "e",
]);
const stableAffinityConfig = [
  { id: "stable-a", caseIds: ["a-1", "a-2"] },
  { id: "stable-b", caseIds: ["b-1", "b-2"] },
];
const stablePreferredSlots = { "stable-a": 1, "stable-b": 2 };
const stableBaseline = planCaseIdsByFixtureAffinity({
  caseIds: ["a-1", "a-2", "b-1", "b-2", "loose-1"],
  shardCount: 2,
  affinities: stableAffinityConfig,
  caseWeight: () => 1,
  preferredSlotByAffinity: stablePreferredSlots,
});
const stableAfterUnrelatedAdd = planCaseIdsByFixtureAffinity({
  caseIds: ["a-1", "a-2", "b-1", "b-2", "loose-1", "loose-2"],
  shardCount: 2,
  affinities: stableAffinityConfig,
  caseWeight: () => 1,
  preferredSlotByAffinity: stablePreferredSlots,
});
for (const [affinityId, expectedSlot] of Object.entries(stablePreferredSlots)) {
  const caseId = stableAffinityConfig.find(({ id }) => id === affinityId)
    .caseIds[0];
  assert.equal(
    stableBaseline.caseShards.findIndex((caseIds) => caseIds.includes(caseId)) +
      1,
    expectedSlot,
  );
  assert.equal(
    stableAfterUnrelatedAdd.caseShards.findIndex((caseIds) =>
      caseIds.includes(caseId),
    ) + 1,
    expectedSlot,
  );
}
assert.deepEqual(stableAfterUnrelatedAdd.movedAffinities, []);

const forcedStableMovement = planCaseIdsByFixtureAffinity({
  caseIds: ["heavy-a", "heavy-b", "light-c", "light-d"],
  shardCount: 2,
  affinities: [
    { id: "heavy-a", caseIds: ["heavy-a"] },
    { id: "heavy-b", caseIds: ["heavy-b"] },
  ],
  caseWeight: (caseId) => (caseId.startsWith("heavy") ? 100 : 1),
  caseCacheImpact: (caseId) => (caseId.startsWith("heavy") ? 75 : 1),
  preferredSlotByAffinity: { "heavy-a": 1, "heavy-b": 1 },
  maxStableLoadRatio: 1.05,
});
assert.deepEqual(forcedStableMovement.movedAffinities, [
  {
    affinityId: "heavy-a",
    fromStableSlot: 1,
    toStableSlot: 2,
    caseIds: ["heavy-a"],
    estimatedCacheImpactMs: 75,
    reason: "stable slot exceeded the load tolerance",
  },
]);
assert.deepEqual(forcedStableMovement.shardLoads, [101, 101]);
assert.match(
  renderPlanSummaryMarkdown({
    shardCount: 2,
    stableSlotCount: 2,
    preservedBundleCount: 1,
    movedBundles: forcedStableMovement.movedAffinities.map(
      ({ affinityId, ...movement }) => ({
        bundleId: affinityId,
        ...movement,
      }),
    ),
    estimatedCacheImpactMs: 75,
  }),
  /heavy-a: slot-1 -> slot-2; 75 ms cache impact/,
);

const plateauStableMovement = planCaseIdsByFixtureAffinity({
  caseIds: ["a", "b", "c", "d", "e", "f"],
  shardCount: 3,
  affinities: ["a", "b", "c", "d", "e", "f"].map((id) => ({
    id,
    caseIds: [id],
  })),
  caseWeight: () => 100,
  caseCacheImpact: () => 40,
  preferredSlotByAffinity: {
    a: 1,
    b: 1,
    c: 1,
    d: 2,
    e: 2,
    f: 2,
  },
  maxStableLoadRatio: 1,
});
assert.deepEqual(plateauStableMovement.shardLoads, [200, 200, 200]);
assert.deepEqual(
  plateauStableMovement.movedAffinities.map(
    ({ affinityId, fromStableSlot, toStableSlot, estimatedCacheImpactMs }) => ({
      affinityId,
      fromStableSlot,
      toStableSlot,
      estimatedCacheImpactMs,
    }),
  ),
  [
    {
      affinityId: "a",
      fromStableSlot: 1,
      toStableSlot: 3,
      estimatedCacheImpactMs: 40,
    },
    {
      affinityId: "d",
      fromStableSlot: 2,
      toStableSlot: 3,
      estimatedCacheImpactMs: 40,
    },
  ],
);

const neutralTransitionStableMovement = planCaseIdsByFixtureAffinity({
  caseIds: ["a", "b", "c", "d", "e", "f"],
  shardCount: 3,
  affinities: ["a", "b", "c", "d", "e", "f"].map((id) => ({
    id,
    caseIds: [id],
  })),
  caseWeight: (caseId) => (caseId === "e" || caseId === "f" ? 2 : 1),
  caseCacheImpact: () => 1,
  preferredSlotByAffinity: {
    a: 1,
    b: 1,
    c: 2,
    d: 2,
    e: 3,
    f: 3,
  },
  maxStableLoadRatio: 1,
});
assert.deepEqual(
  neutralTransitionStableMovement.shardLoads
    .slice()
    .sort((left, right) => right - left),
  [3, 3, 2],
);
assert.equal(neutralTransitionStableMovement.movedAffinities.length, 2);

const nineteenStableAffinities = [
  ...Array.from({ length: 8 }, (_, index) => `slot-1-${index + 1}`),
  ...Array.from({ length: 6 }, (_, index) => `slot-2-${index + 1}`),
  ...Array.from({ length: 5 }, (_, index) => `slot-3-${index + 1}`),
];
const nineteenStableMovement = planCaseIdsByFixtureAffinity({
  caseIds: nineteenStableAffinities,
  shardCount: 3,
  affinities: nineteenStableAffinities.map((id) => ({ id, caseIds: [id] })),
  caseWeight: () => 1,
  caseCacheImpact: () => 1,
  preferredSlotByAffinity: Object.fromEntries(
    nineteenStableAffinities.map((id) => [
      id,
      Number(/^slot-(\d+)-/.exec(id)[1]),
    ]),
  ),
  maxStableLoadRatio: 1,
});
assert.deepEqual(nineteenStableMovement.shardLoads, [7, 6, 6]);
assert.equal(nineteenStableMovement.movedAffinities.length, 1);

const actualMovementOptimized = planCaseIdsByFixtureAffinity({
  caseIds: ["a", "b", "c", "d", "e", "f", "g"],
  shardCount: 3,
  affinities: ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({
    id,
    caseIds: [id],
  })),
  caseWeight: (caseId) =>
    ({ a: 4, b: 2, c: 7, d: 7, e: 1, f: 1, g: 5 })[caseId],
  caseCacheImpact: () => 1,
  preferredSlotByAffinity: { a: 1, b: 2, c: 2, d: 2, e: 1, f: 1, g: 2 },
  maxStableLoadRatio: 1,
});
assert.deepEqual(actualMovementOptimized.shardLoads, [9, 9, 9]);
assert.equal(actualMovementOptimized.movedAffinities.length, 3);

const unavailableStableSlot = planCaseIdsByFixtureAffinity({
  caseIds: ["stable", "loose"],
  shardCount: 2,
  affinities: [{ id: "stable", caseIds: ["stable"] }],
  caseWeight: () => 1,
  caseCacheImpact: () => 25,
  preferredSlotByAffinity: { stable: 8 },
});
assert.deepEqual(unavailableStableSlot.movedAffinities, [
  {
    affinityId: "stable",
    fromStableSlot: 8,
    toStableSlot: 1,
    caseIds: ["stable"],
    estimatedCacheImpactMs: 25,
    reason: "stable slot is unavailable at this shard count",
  },
]);
const weightedShards = shardCaseIdsByFixtureAffinity({
  caseIds: ["heavy", "light-a", "light-b", "light-c"],
  shardCount: 2,
  affinities: [],
  caseWeight: (caseId) => (caseId === "heavy" ? 100 : 1),
});
assert.deepEqual(weightedShards, [
  ["heavy"],
  ["light-a", "light-b", "light-c"],
]);
assert.equal(resolveFullRunShardCount(FULL_RUN_TARGET_CASES_PER_SHARD), 1);
assert.equal(resolveFullRunShardCount(FULL_RUN_TARGET_CASES_PER_SHARD + 1), 2);
assert.equal(
  resolveFullRunShardCount(Number.MAX_SAFE_INTEGER),
  FULL_RUN_MAX_SHARD_COUNT,
);
assert.deepEqual(
  validateFixtureAffinities({
    allCaseIds: ["sync", "hybrid"],
    hybridCaseIds: ["hybrid"],
    affinities: [
      { id: "cross-mode", caseIds: ["sync", "hybrid"] },
      { id: "unknown", caseIds: ["missing"] },
    ],
  }),
  [
    "Fixture affinity unknown references unknown case missing",
    "Fixture affinity cross-mode crosses V2 sync and hybrid pools",
  ],
);
assert.deepEqual(
  validateFixtureAffinities({
    allCaseIds,
    hybridCaseIds: HYBRID_COMPUTED_CASES,
  }),
  [],
);

assert.equal(
  buildCaseFilterKey("z/case,a/case,z/case," + "x".repeat(180)).length,
  160,
);

assertThrowsMessage(
  "empty engine list",
  () =>
    resolveRunPlan({
      engineFilter: " , ",
      caseFilter: "all",
      allCaseIds,
    }),
  "engine_filter must include at least one engine.",
);

assertThrowsMessage(
  "invalid engine",
  () =>
    resolveRunPlan({
      engineFilter: "v1,v3",
      caseFilter: "all",
      allCaseIds,
    }),
  "Unsupported engine_filter value(s): v3. Use v1, v2, or v1,v2.",
);

assertThrowsMessage(
  "empty case filter",
  () =>
    resolveRunPlan({
      engineFilter: "v1",
      caseFilter: " , ",
      allCaseIds,
    }),
  "case_filter must include at least one case id or all.",
);

assertThrowsMessage(
  "full run requires the catalog",
  () =>
    resolveRunPlan({
      engineFilter: "v1",
      caseFilter: "all",
    }),
  "allCaseIds must include the registered cases for a full run.",
);

assertThrowsMessage(
  "unsafe seed cache namespace",
  () =>
    resolveRunPlan({
      engineFilter: "v1",
      caseFilter: "all",
      seedCacheNamespace: "unsafe/cache",
      allCaseIds,
    }),
  "seed_cache_namespace must contain only letters, digits, dots, underscores, and hyphens.",
);

console.log("Run plan checks ok");
