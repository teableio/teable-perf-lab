import assert from "node:assert/strict";
import {
  buildCaseFilterKey,
  FULL_RUN_SHARD_COUNT,
  HYBRID_COMPUTED_CASES,
  loadRegisteredCaseIds,
  resolveRunPlan,
} from "./run-plan.mjs";

const allCaseIds = await loadRegisteredCaseIds();
const hybridCaseIdSet = new Set(HYBRID_COMPUTED_CASES);

const assertShardedPlan = ({
  plans,
  expectedCaseIds,
  name,
  engine,
  computedUpdateMode,
  artifactSuffix,
  otelServiceSuffix,
}) => {
  assert.equal(plans.length, FULL_RUN_SHARD_COUNT);
  plans.forEach((plan, index) => {
    const shardNumber = index + 1;
    const shardLabel = `shard-${shardNumber}-of-${FULL_RUN_SHARD_COUNT}`;
    assert.deepEqual(plan, {
      name: `${name}-${shardLabel}`,
      engine,
      caseFilter: expectedCaseIds
        .filter((_, caseIndex) => caseIndex % FULL_RUN_SHARD_COUNT === index)
        .join(","),
      excludeCaseFilter: "",
      computedUpdateMode,
      artifactSuffix: `${artifactSuffix}-${shardLabel}`,
      otelServiceSuffix: `${otelServiceSuffix}-${shardLabel}`,
    });
  });

  const shardedCaseIds = plans.flatMap((plan) => plan.caseFilter.split(","));
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
assert.equal(defaultFullRunPlan.executePlan.length, FULL_RUN_SHARD_COUNT * 3);
assertShardedPlan({
  plans: defaultFullRunPlan.executePlan.slice(0, FULL_RUN_SHARD_COUNT),
  expectedCaseIds: allCaseIds,
  name: "v1",
  engine: "v1",
  computedUpdateMode: "",
  artifactSuffix: "v1",
  otelServiceSuffix: "v1",
});
assertShardedPlan({
  plans: defaultFullRunPlan.executePlan.slice(
    FULL_RUN_SHARD_COUNT,
    FULL_RUN_SHARD_COUNT * 2,
  ),
  expectedCaseIds: allCaseIds.filter((caseId) => !hybridCaseIdSet.has(caseId)),
  name: "v2-sync-default",
  engine: "v2",
  computedUpdateMode: "",
  artifactSuffix: "v2",
  otelServiceSuffix: "v2-sync",
});
assertShardedPlan({
  plans: defaultFullRunPlan.executePlan.slice(FULL_RUN_SHARD_COUNT * 2),
  expectedCaseIds: allCaseIds.filter((caseId) => hybridCaseIdSet.has(caseId)),
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
assertShardedPlan({
  plans: explicitHybridFullRunPlan.executePlan,
  expectedCaseIds: allCaseIds,
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
    executePlan: [
      {
        name: "v2",
        engine: "v2",
        caseFilter: " formula/10k-calc,smoke/auth-user ",
        excludeCaseFilter: "",
        computedUpdateMode: "",
        artifactSuffix: "v2",
        otelServiceSuffix: "v2",
      },
      {
        name: "v1",
        engine: "v1",
        caseFilter: " formula/10k-calc,smoke/auth-user ",
        excludeCaseFilter: "",
        computedUpdateMode: "",
        artifactSuffix: "v1",
        otelServiceSuffix: "v1",
      },
    ],
  },
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
