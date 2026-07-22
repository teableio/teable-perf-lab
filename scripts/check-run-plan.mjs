import assert from "node:assert/strict";
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
import {
  buildCaseFilterKey,
  buildFullRunShardCaseFilterKey,
  HYBRID_COMPUTED_CASES,
  loadRegisteredCases,
  parseCaseSeedAffinity,
  renderPlanSummaryMarkdown,
  resolveRunPlan,
} from "./run-plan.mjs";
import {
  buildCaseSetDigest,
  SEED_CONTRACT_GENERATION,
} from "./seed-cache-model.mjs";

const registeredCases = await loadRegisteredCases();
const allCaseIds = registeredCases.map(({ id }) => id);
const expectedFullRunCaseIds = resolveFullRunCaseIds({ allCaseIds });
const hybridCaseIdSet = new Set(HYBRID_COMPUTED_CASES);
const fullRunShardCount = resolveFullRunShardCount(
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
  assert.equal(plans.length, shardCount);
  plans.forEach((plan, index) => {
    const shardNumber = index + 1;
    const shardLabel = `shard-${shardNumber}-of-${shardCount}`;
    assert.deepEqual(plan, {
      name: `${name}-${shardLabel}`,
      engine,
      caseFilter: expectedCaseShards[index].join(","),
      excludeCaseFilter: "",
      computedUpdateMode,
      artifactSuffix: `${artifactSuffix}-${shardLabel}`,
      otelServiceSuffix: `${otelServiceSuffix}-${shardLabel}`,
      seedArtifactSuffix: shardLabel,
    });
  });

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
assert.equal(defaultFullRunPlan.caseFilterKey, "all");
assert.equal(defaultFullRunPlan.seedPlan.length, fullRunShardCount);
assert.equal(defaultFullRunPlan.executePlan.length, fullRunShardCount * 3);
assert.deepEqual(defaultFullRunPlan.planSummary, {
  shardCount: 8,
  stableSlotCount: 8,
  preservedAffinityCount: 12,
  movedAffinities: [],
  estimatedCacheImpactMs: 0,
});
const fullRunCaseShards = defaultFullRunPlan.seedPlan.map((plan, index) => {
  const shardLabel = `shard-${index + 1}-of-${fullRunShardCount}`;
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
assert.equal(fullRunShardCount, 8);
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
]) {
  const caseIds = targetSeedAffinityDeclarations
    .filter((declaration) => declaration.affinityId === affinityId)
    .map((declaration) => declaration.caseId);
  assert.equal(
    new Set(caseIds.map((caseId) => shardIndexByCaseId.get(caseId))).size,
    1,
    `${affinityId} authoritative seed affinity must stay in one seed shard`,
  );
}

assertShardedPlan({
  plans: defaultFullRunPlan.executePlan.slice(0, fullRunShardCount),
  expectedCaseShards: fullRunCaseShards,
  name: "v1",
  engine: "v1",
  computedUpdateMode: "",
  artifactSuffix: "v1",
  otelServiceSuffix: "v1",
});
assertShardedPlan({
  plans: defaultFullRunPlan.executePlan.slice(
    fullRunShardCount,
    fullRunShardCount * 2,
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
  plans: defaultFullRunPlan.executePlan.slice(fullRunShardCount * 2),
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
  explicitHybridFullRunPlan.seedPlan,
  defaultFullRunPlan.seedPlan,
);

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
  expectedCaseShards: fullRunCaseShards,
  name: "v2",
  engine: "v2",
  computedUpdateMode: "hybrid",
  artifactSuffix: "v2",
  otelServiceSuffix: "v2",
});

assert.deepEqual(
  resolveRunPlan({
    engineFilter: " v2, v1, v2 ",
    caseFilter: " formula/10k-calc,smoke/auth-user ",
    computedUpdateMode: "",
    allCaseIds,
  }),
  {
    engines: ["v2", "v1"],
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
    planSummary: {
      shardCount: 1,
      stableSlotCount: 1,
      preservedAffinityCount: 0,
      movedAffinities: [],
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
    preservedAffinityCount: 1,
    movedAffinities: forcedStableMovement.movedAffinities,
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

console.log("Run plan checks ok");
