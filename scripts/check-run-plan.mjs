import assert from "node:assert/strict";
import {
  FULL_RUN_FIXTURE_AFFINITIES,
  FULL_RUN_MAX_SHARD_COUNT,
  FULL_RUN_SCALE_REPLACEMENTS,
  FULL_RUN_TARGET_CASES_PER_SHARD,
  resolveFullRunCaseIds,
  resolveFullRunShardCount,
  shardCaseIdsByFixtureAffinity,
  validateFullRunScaleReplacements,
  validateFixtureAffinities,
} from "./full-run-shard-model.mjs";
import {
  buildCaseFilterKey,
  buildFullRunShardCaseFilterKey,
  HYBRID_COMPUTED_CASES,
  loadRegisteredCaseIds,
  resolveRunPlan,
} from "./run-plan.mjs";

const allCaseIds = await loadRegisteredCaseIds();
const expectedFullRunCaseIds = resolveFullRunCaseIds({ allCaseIds });
const hybridCaseIdSet = new Set(HYBRID_COMPUTED_CASES);
const fullRunShardCount = resolveFullRunShardCount(
  expectedFullRunCaseIds.length,
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
});

assert.deepEqual(defaultFullRunPlan.engines, ["v1", "v2"]);
assert.equal(defaultFullRunPlan.caseFilterKey, "all");
assert.equal(defaultFullRunPlan.seedPlan.length, fullRunShardCount);
assert.equal(defaultFullRunPlan.executePlan.length, fullRunShardCount * 3);
const fullRunCaseShards = defaultFullRunPlan.seedPlan.map((plan, index) => {
  const shardLabel = `shard-${index + 1}-of-${fullRunShardCount}`;
  assert.equal(plan.name, shardLabel);
  const caseIds = plan.caseFilter.split(",");
  assert.equal(
    plan.caseFilterKey,
    buildFullRunShardCaseFilterKey(shardLabel, caseIds),
  );
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
