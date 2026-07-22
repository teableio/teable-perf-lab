import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  buildCaseSetDigest,
  buildSeedCacheIdentity,
  buildSeedCacheStatus,
  normalizeSeedCacheNamespace,
  resolveSeedCacheOutcome,
  SEED_CONTRACT_GENERATION,
} from "./seed-cache-model.mjs";

assert.equal(normalizeSeedCacheNamespace(), "");
assert.equal(normalizeSeedCacheNamespace(" ticket-07-cold-warm "), "ticket-07-cold-warm");
assert.throws(
  () => normalizeSeedCacheNamespace("unsafe/cache"),
  /seed_cache_namespace must contain only/,
);
assert.throws(
  () => normalizeSeedCacheNamespace("x".repeat(41)),
  /seed_cache_namespace must be at most 40 characters/,
);

const commonIdentity = {
  runnerOs: "Linux",
  schemaHash: "schema-abc",
  seedContractGeneration: SEED_CONTRACT_GENERATION,
  stableSlot: "slot-3",
};
const firstCaseSetDigest = buildCaseSetDigest(["case/b", "case/a"]);
const reorderedCaseSetDigest = buildCaseSetDigest(["case/a", "case/b"]);
const expandedCaseSetDigest = buildCaseSetDigest([
  "case/a",
  "case/b",
  "case/c",
]);
assert.equal(firstCaseSetDigest, reorderedCaseSetDigest);
assert.notEqual(firstCaseSetDigest, expandedCaseSetDigest);

const firstIdentity = buildSeedCacheIdentity({
  ...commonIdentity,
  caseSetDigest: firstCaseSetDigest,
  sourceHash: "source-1",
});
const catalogChangedIdentity = buildSeedCacheIdentity({
  ...commonIdentity,
  caseSetDigest: expandedCaseSetDigest,
  sourceHash: "source-2",
});
const isolatedIdentity = buildSeedCacheIdentity({
  ...commonIdentity,
  cacheNamespace: "ticket-07-cold-warm",
  caseSetDigest: firstCaseSetDigest,
  sourceHash: "source-1",
});
assert.notEqual(firstIdentity.exactKey, catalogChangedIdentity.exactKey);
assert.notEqual(firstIdentity.exactKey, isolatedIdentity.exactKey);
assert.match(
  isolatedIdentity.compatibleRestorePrefix,
  /^perf-seed-db-ticket-07-cold-warm-Linux-/,
);
assert.equal(
  firstIdentity.compatibleRestorePrefix,
  catalogChangedIdentity.compatibleRestorePrefix,
);
for (const incompatibleChange of [
  { schemaHash: "schema-next" },
  { seedContractGeneration: "seed-contract-next" },
  { stableSlot: "slot-4" },
]) {
  const incompatible = buildSeedCacheIdentity({
    ...commonIdentity,
    ...incompatibleChange,
    caseSetDigest: expandedCaseSetDigest,
    sourceHash: "source-2",
  });
  assert.notEqual(
    firstIdentity.compatibleRestorePrefix,
    incompatible.compatibleRestorePrefix,
  );
}

assert.deepEqual(
  resolveSeedCacheOutcome({
    exactKey: firstIdentity.exactKey,
    compatibleRestorePrefix: firstIdentity.compatibleRestorePrefix,
    matchedKey: "",
    dumpPresent: false,
    dumpRestored: false,
    fixtureValidation: [],
  }),
  {
    mode: "cache-miss",
    requiresRunnerValidation: true,
    reusedFixtureCount: 0,
    rebuiltFixtureCount: 0,
  },
);
assert.deepEqual(
  resolveSeedCacheOutcome({
    exactKey: catalogChangedIdentity.exactKey,
    compatibleRestorePrefix: catalogChangedIdentity.compatibleRestorePrefix,
    matchedKey: firstIdentity.exactKey,
    dumpPresent: true,
    dumpRestored: false,
    fixtureValidation: ["missing", "stale"],
  }),
  {
    mode: "compatible-restore-failed",
    requiresRunnerValidation: true,
    reusedFixtureCount: 0,
    rebuiltFixtureCount: 2,
  },
);
assert.throws(
  () =>
    resolveSeedCacheOutcome({
      exactKey: catalogChangedIdentity.exactKey,
      compatibleRestorePrefix: catalogChangedIdentity.compatibleRestorePrefix,
      matchedKey: firstIdentity.exactKey,
      dumpPresent: true,
      dumpRestored: true,
      fixtureValidation: ["invalid"],
    }),
  /Unsupported fixture validation status/,
);

const commonStatus = {
  primaryKey: catalogChangedIdentity.exactKey,
  caseSetDigest: expandedCaseSetDigest,
  stableSlot: commonIdentity.stableSlot,
  seedContractGeneration: SEED_CONTRACT_GENERATION,
  perfLabSha: "a".repeat(40),
  teableEeSha: "b".repeat(40),
};
assert.deepEqual(
  buildSeedCacheStatus({
    ...commonStatus,
    cacheHit: true,
    matchedKey: catalogChangedIdentity.exactKey,
  }),
  {
    mode: "exact-hit",
    requiresRunnerValidation: false,
    primaryKey: catalogChangedIdentity.exactKey,
    matchedKey: catalogChangedIdentity.exactKey,
    caseSetDigest: expandedCaseSetDigest,
    stableSlot: "slot-3",
    seedContractGeneration: SEED_CONTRACT_GENERATION,
    cacheNamespace: "",
    perfLabSha: "a".repeat(40),
    teableEeSha: "b".repeat(40),
  },
);
assert.throws(
  () => buildSeedCacheStatus({ ...commonStatus, perfLabSha: "branch-name" }),
  /perfLabSha must be a 40-character commit SHA/,
);
assert.equal(
  buildSeedCacheStatus({
    ...commonStatus,
    cacheHit: false,
    matchedKey: firstIdentity.exactKey,
  }).mode,
  "compatible-candidate",
);
assert.equal(
  buildSeedCacheStatus({
    ...commonStatus,
    cacheHit: false,
  }).mode,
  "cache-miss",
);

const statusTempDir = await mkdtemp(join(tmpdir(), "perf-seed-cache-status-"));
try {
  for (const path of [
    {
      name: "exact",
      cacheHit: "true",
      matchedKey: catalogChangedIdentity.exactKey,
      expectedMode: "exact-hit",
      expectedValidation: "false",
    },
    {
      name: "compatible",
      cacheHit: "false",
      matchedKey: firstIdentity.exactKey,
      expectedMode: "compatible-candidate",
      expectedValidation: "true",
    },
    {
      name: "miss",
      cacheHit: "false",
      matchedKey: "",
      expectedMode: "cache-miss",
      expectedValidation: "true",
    },
  ]) {
    const outputPath = join(statusTempDir, `${path.name}.json`);
    const githubOutputPath = join(statusTempDir, `${path.name}.output`);
    const result = spawnSync(
      process.execPath,
      ["scripts/write-seed-cache-status.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CACHE_HIT: path.cacheHit,
          CACHE_PRIMARY_KEY: catalogChangedIdentity.exactKey,
          CACHE_MATCHED_KEY: path.matchedKey,
          CASE_SET_DIGEST: expandedCaseSetDigest,
          STABLE_SLOT: "slot-3",
          SEED_CONTRACT_GENERATION,
          SEED_CACHE_NAMESPACE: "ticket-07-cold-warm",
          PERF_LAB_SHA: "a".repeat(40),
          TEABLE_EE_SHA: "b".repeat(40),
          OUTPUT_PATH: outputPath,
          GITHUB_OUTPUT: githubOutputPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const writtenStatus = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(writtenStatus.mode, path.expectedMode);
    assert.equal(
      String(writtenStatus.requiresRunnerValidation),
      path.expectedValidation,
    );
    assert.equal(writtenStatus.cacheNamespace, "ticket-07-cold-warm");
    assert.equal(writtenStatus.perfLabSha, "a".repeat(40));
    assert.equal(writtenStatus.teableEeSha, "b".repeat(40));
    const githubOutput = await readFile(githubOutputPath, "utf8");
    assert.match(githubOutput, new RegExp(`cache_mode=${path.expectedMode}`));
    assert.match(
      githubOutput,
      new RegExp(`requires_seed_validation=${path.expectedValidation}`),
    );
  }
} finally {
  await rm(statusTempDir, { recursive: true, force: true });
}
assert.deepEqual(
  resolveSeedCacheOutcome({
    exactKey: firstIdentity.exactKey,
    compatibleRestorePrefix: firstIdentity.compatibleRestorePrefix,
    matchedKey: firstIdentity.exactKey,
    dumpPresent: true,
    dumpRestored: true,
    fixtureValidation: [],
  }),
  {
    mode: "exact-hit",
    requiresRunnerValidation: false,
    reusedFixtureCount: 0,
    rebuiltFixtureCount: 0,
  },
);
assert.throws(
  () =>
    resolveSeedCacheOutcome({
      exactKey: firstIdentity.exactKey,
      compatibleRestorePrefix: firstIdentity.compatibleRestorePrefix,
      matchedKey: firstIdentity.exactKey,
      dumpPresent: false,
      dumpRestored: false,
      fixtureValidation: [],
    }),
  /Exact seed cache hit is missing its database dump/,
);
assert.deepEqual(
  resolveSeedCacheOutcome({
    exactKey: catalogChangedIdentity.exactKey,
    compatibleRestorePrefix: catalogChangedIdentity.compatibleRestorePrefix,
    matchedKey: firstIdentity.exactKey,
    dumpPresent: true,
    dumpRestored: true,
    fixtureValidation: ["valid", "valid"],
  }),
  {
    mode: "compatible-restore",
    requiresRunnerValidation: true,
    reusedFixtureCount: 2,
    rebuiltFixtureCount: 0,
  },
);
assert.deepEqual(
  resolveSeedCacheOutcome({
    exactKey: catalogChangedIdentity.exactKey,
    compatibleRestorePrefix: catalogChangedIdentity.compatibleRestorePrefix,
    matchedKey: firstIdentity.exactKey,
    dumpPresent: true,
    dumpRestored: true,
    fixtureValidation: ["valid", "missing", "stale"],
  }),
  {
    mode: "compatible-self-healed",
    requiresRunnerValidation: true,
    reusedFixtureCount: 1,
    rebuiltFixtureCount: 2,
  },
);

const workflow = parse(
  await readFile(".github/workflows/teable-ee-e2e-perf.yml", "utf8"),
);
assert.equal(
  workflow.on.workflow_dispatch.inputs.seed_cache_namespace.default,
  "",
);
assert.equal(
  workflow.on.workflow_dispatch.inputs.expected_perf_lab_sha.default,
  "",
);
assert.equal(
  workflow.jobs.resolve_inputs.outputs.seed_cache_namespace,
  "${{ steps.engines.outputs.seed_cache_namespace }}",
);
assert.equal(
  workflow.jobs.resolve_inputs.outputs.seed_cache_namespace_segment,
  "${{ steps.engines.outputs.seed_cache_namespace_segment }}",
);
const seedSteps = workflow.jobs.seed.steps;
const revisionStep = workflow.jobs.resolve_inputs.steps.find(
  (step) => step.name === "Verify pinned perf-lab revision",
);
assert.equal(revisionStep.if, "inputs.expected_perf_lab_sha != ''");
assert.equal(
  revisionStep.env.EXPECTED_PERF_LAB_SHA,
  "${{ inputs.expected_perf_lab_sha }}",
);
assert.match(revisionStep.run, /GITHUB_SHA/);
const teableEeRevisionStep = seedSteps.find(
  (step) => step.id === "teable-ee-revision",
);
assert.equal(teableEeRevisionStep["working-directory"], "teable-ee");
assert.match(teableEeRevisionStep.run, /git rev-parse HEAD/);
const restoreStep = seedSteps.find((step) => step.id === "seed-db-cache");
assert.match(restoreStep.with.key, /seed_cache_namespace_segment/);
assert.match(restoreStep.with.key, /matrix\.plan\.caseSetDigest/);
assert.match(restoreStep.with.key, /matrix\.plan\.stableSlot/);
assert.match(restoreStep.with.key, /matrix\.plan\.seedContractGeneration/);
assert.doesNotMatch(restoreStep.with["restore-keys"], /caseFilterKey/);
assert.match(
  restoreStep.with["restore-keys"],
  /seed_cache_namespace_segment/,
);
assert.doesNotMatch(restoreStep.with.key, /inputs\.seed_cache_namespace/);
assert.match(restoreStep.with["restore-keys"], /matrix\.plan\.stableSlot/);
assert.match(
  restoreStep.with["restore-keys"],
  /matrix\.plan\.seedContractGeneration/,
);
const saveStep = seedSteps.find(
  (step) => step.name === "Save perf seed database cache",
);
assert.equal(saveStep.with.key, restoreStep.with.key);

const statusStep = seedSteps.find(
  (step) => step.name === "Record seed database cache mode",
);
assert.equal(statusStep.id, "seed-cache-mode");
assert.equal(
  statusStep.env.CACHE_MATCHED_KEY,
  "${{ steps.seed-db-cache.outputs.cache-matched-key }}",
);
assert.equal(
  statusStep.env.CASE_SET_DIGEST,
  "${{ matrix.plan.caseSetDigest }}",
);
assert.equal(
  statusStep.env.SEED_CACHE_NAMESPACE,
  "${{ needs.resolve_inputs.outputs.seed_cache_namespace }}",
);
assert.equal(statusStep.env.PERF_LAB_SHA, "${{ github.sha }}");
assert.equal(
  statusStep.env.TEABLE_EE_SHA,
  "${{ steps.teable-ee-revision.outputs.sha }}",
);

const buildStep = seedSteps.find((step) => step.name === "Build perf seed DB");
assert.equal(
  buildStep.if,
  "steps.seed-cache-mode.outputs.requires_seed_validation == 'true'",
);
const exactHitStep = seedSteps.find(
  (step) => step.name === "Publish seed database cache hit summary",
);
assert.equal(
  exactHitStep.if,
  "steps.seed-cache-mode.outputs.requires_seed_validation == 'false'",
);
for (const stepName of [
  "Setup pnpm",
  "Setup Node.js",
  "Install teable-ee dependencies",
  "Generate Prisma clients",
  "Install perf cases",
  "Start e2e services",
  "Prepare e2e database",
  "Build perf seed DB",
  "Dump perf seed database",
  "Save perf seed database cache",
  "Cleanup teable-ee e2e services",
]) {
  const step = seedSteps.find(({ name }) => name === stepName);
  assert.match(
    step.if,
    /steps\.seed-cache-mode\.outputs\.requires_seed_validation == 'true'/,
  );
}
const uploadSeedStatusStep = seedSteps.find(
  (step) => step.name === "Upload perf seed artifacts",
);
assert.equal(uploadSeedStatusStep.if, "always()");

const downloadStep = workflow.jobs.execute.steps.find(
  (step) => step.name === "Download perf seed database dump",
);
assert.match(downloadStep.with.name, /matrix\.plan\.seedArtifactSuffix/);

console.log("Seed cache identity and workflow checks ok");
