import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateFullRunFeedback,
  resolveDuplicateSeeds,
} from "./full-run-feedback-model.mjs";
import {
  evaluateSeedAffinityGate,
  evaluateSeedPlanStatusEvidence,
  resolveSeedPayloadProvenance,
} from "./verify-full-run-seed-affinity.mjs";
import { evaluateFullRunResultAcceptance } from "./verify-full-run-result-acceptance.mjs";

const loadFixture = async (name) =>
  JSON.parse(
    await readFile(
      new URL(`./fixtures/full-run-feedback/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

const acceptanceExecutePlan = [
  {
    name: "v1-shard-1-of-1",
    engine: "v1",
    caseFilter: "case/a,case/b",
  },
  {
    name: "v2-sync-default-shard-1-of-1",
    engine: "v2",
    caseFilter: "case/a,case/b",
  },
];
const traceEvidence = {
  enabled: true,
  traceRefCount: 1,
  uniqueTraceCount: 1,
  selectedTraceCount: 1,
  savedTraceCount: 1,
  failedTraceCount: 0,
  skippedTraceCount: 0,
  missingFetchCount: 0,
  wastedFetchMs: 0,
  traceFetchCaseBudgetMs: 15_000,
  traceFetchJobBudgetMs: 60_000,
  traceFetchWaitMs: 100,
  traceFetchJobWaitMs: 200,
  traceFetchBreakerState: "closed",
  traceFetchRecoveryProbeCount: 0,
  traceFetchRecoverySucceeded: false,
  refs: [{ traceId: "trace-a", stepId: "operation" }],
  savedTraces: [
    { traceId: "trace-a", stepId: "operation", status: "saved" },
  ],
};
const acceptedPayloadEntries = acceptanceExecutePlan.flatMap((plan) =>
  plan.caseFilter.split(",").map((caseId) => ({
    fileName: `${caseId.replace("/", "-")}-${plan.engine}.json`,
    payload: {
      caseId,
      engine: plan.engine,
      result: "pass",
      details: {
        routing: {
          routeMatched: true,
          engineMatched: true,
          featureMatched: true,
        },
        observability: { traces: structuredClone(traceEvidence) },
      },
    },
  })),
);
assert.equal(
  evaluateFullRunResultAcceptance({
    executePlan: acceptanceExecutePlan,
    payloadEntries: acceptedPayloadEntries,
    jobConclusions: {
      resolveInputs: "success",
      seed: "success",
      execute: "success",
    },
  }).passed,
  true,
);
const acceptedMissingTracePayloads = structuredClone(acceptedPayloadEntries);
const missingTrace =
  acceptedMissingTracePayloads[0].payload.details.observability.traces;
missingTrace.savedTraceCount = 0;
missingTrace.failedTraceCount = 1;
missingTrace.missingFetchCount = 1;
missingTrace.wastedFetchMs = 100;
missingTrace.savedTraces[0].status = "error";
assert.equal(
  evaluateFullRunResultAcceptance({
    executePlan: acceptanceExecutePlan,
    payloadEntries: acceptedMissingTracePayloads,
    jobConclusions: {
      resolveInputs: "success",
      seed: "success",
      execute: "success",
    },
  }).passed,
  true,
  "bounded Jaeger misses remain accepted when failed trace evidence reconciles",
);
const acceptedHardOutagePayloads = structuredClone(acceptedPayloadEntries);
const hardOutageTrace =
  acceptedHardOutagePayloads[0].payload.details.observability.traces;
hardOutageTrace.savedTraceCount = 0;
hardOutageTrace.failedTraceCount = 1;
hardOutageTrace.missingFetchCount = 1;
hardOutageTrace.wastedFetchMs = 0;
hardOutageTrace.traceFetchBreakerState = "hard-outage";
hardOutageTrace.traceFetchBreakerReason = "Jaeger connection refused";
hardOutageTrace.savedTraces[0].status = "error";
assert.equal(
  evaluateFullRunResultAcceptance({
    executePlan: acceptanceExecutePlan,
    payloadEntries: acceptedHardOutagePayloads,
    jobConclusions: {
      resolveInputs: "success",
      seed: "success",
      execute: "success",
    },
  }).passed,
  true,
  "an immediate hard outage may account a miss without wasting polling time",
);
const hiddenMissingPayloads = structuredClone(acceptedHardOutagePayloads);
hiddenMissingPayloads[0].payload.details.observability.traces.missingFetchCount = 0;
assert.deepEqual(
  evaluateFullRunResultAcceptance({
    executePlan: acceptanceExecutePlan,
    payloadEntries: hiddenMissingPayloads,
    jobConclusions: {
      resolveInputs: "success",
      seed: "success",
      execute: "success",
    },
  }).failures.map(({ code }) => code),
  ["trace-evidence-incomplete"],
);
const duplicateTraceRefPayloads = structuredClone(acceptedPayloadEntries);
const duplicateTrace =
  duplicateTraceRefPayloads[0].payload.details.observability.traces;
duplicateTrace.traceRefCount = 2;
duplicateTrace.selectedTraceCount = 1;
duplicateTrace.skippedTraceCount = 1;
duplicateTrace.refs.push({ traceId: "trace-a", stepId: "operation" });
duplicateTrace.savedTraces.push({
  traceId: "trace-a",
  stepId: "operation",
  status: "skipped",
});
assert.equal(
  evaluateFullRunResultAcceptance({
    executePlan: acceptanceExecutePlan,
    payloadEntries: duplicateTraceRefPayloads,
    jobConclusions: {
      resolveInputs: "success",
      seed: "success",
      execute: "success",
    },
  }).passed,
  true,
  "duplicate captured refs reconcile against traceRefCount while uniqueTraceCount stays deduplicated",
);
const mismatchedTraceIdentityPayloads = structuredClone(
  acceptedPayloadEntries,
);
mismatchedTraceIdentityPayloads[0].payload.details.observability.traces.savedTraces[0].traceId =
  "unrelated-trace";
assert.deepEqual(
  evaluateFullRunResultAcceptance({
    executePlan: acceptanceExecutePlan,
    payloadEntries: mismatchedTraceIdentityPayloads,
    jobConclusions: {
      resolveInputs: "success",
      seed: "success",
      execute: "success",
    },
  }).failures.map(({ code }) => code),
  ["trace-evidence-incomplete"],
);

const expectedSkipPayloads = structuredClone(acceptedPayloadEntries);
expectedSkipPayloads[0].payload.result = "skipped";
expectedSkipPayloads[0].payload.details = {
  skipped: true,
  skippedReason: "V1 path is not supported.",
  requestedEngine: "v1",
  observability: { traces: structuredClone(traceEvidence) },
};
assert.equal(
  evaluateFullRunResultAcceptance({
    executePlan: acceptanceExecutePlan,
    payloadEntries: expectedSkipPayloads,
    jobConclusions: {
      resolveInputs: "success",
      seed: "success",
      execute: "success",
    },
    caseContracts: [{ id: "case/a", expectedSkipEngines: ["v1"] }],
  }).passed,
  true,
);
assert.deepEqual(
  evaluateFullRunResultAcceptance({
    executePlan: acceptanceExecutePlan,
    payloadEntries: expectedSkipPayloads,
    jobConclusions: {
      resolveInputs: "success",
      seed: "success",
      execute: "success",
    },
  }).failures.map(({ code }) => code),
  ["result-unexpected-skip"],
);

const missingRoutingPayloads = structuredClone(acceptedPayloadEntries);
delete missingRoutingPayloads[0].payload.details.routing;
assert.deepEqual(
  evaluateFullRunResultAcceptance({
    executePlan: acceptanceExecutePlan,
    payloadEntries: missingRoutingPayloads,
    jobConclusions: {
      resolveInputs: "success",
      seed: "success",
      execute: "success",
    },
  }).failures.map(({ code }) => code),
  ["routing-evidence-missing"],
);
assert.equal(
  evaluateFullRunResultAcceptance({
    executePlan: acceptanceExecutePlan,
    payloadEntries: missingRoutingPayloads,
    jobConclusions: {
      resolveInputs: "success",
      seed: "success",
      execute: "success",
    },
    caseContracts: [{ id: "case/a", routingEvidence: "not-applicable" }],
  }).passed,
  true,
);

const duplicateAcceptancePayloads = [
  ...acceptedPayloadEntries,
  acceptedPayloadEntries[0],
];
assert.deepEqual(
  evaluateFullRunResultAcceptance({
    executePlan: acceptanceExecutePlan,
    payloadEntries: duplicateAcceptancePayloads,
    jobConclusions: {
      resolveInputs: "success",
      seed: "success",
      execute: "success",
    },
  }).failures.map(({ code }) => code),
  ["result-identity-duplicate"],
);

const invalidAcceptancePayloads = structuredClone(acceptedPayloadEntries);
invalidAcceptancePayloads[0].payload.details.routing.engineMatched = false;
invalidAcceptancePayloads[1].payload.details.observability.traces.savedTraces =
  [];
invalidAcceptancePayloads[2].payload.result = "fail";
const invalidAcceptance = evaluateFullRunResultAcceptance({
  executePlan: acceptanceExecutePlan,
  payloadEntries: invalidAcceptancePayloads,
  jobConclusions: {
    resolveInputs: "success",
    seed: "failure",
    execute: "success",
  },
});
assert.equal(invalidAcceptance.passed, false);
assert.deepEqual(
  invalidAcceptance.failures.map(({ code }) => code),
  [
    "job-conclusion",
    "result-failed",
    "routing-mismatch",
    "trace-evidence-incomplete",
  ],
);

const missingAcceptancePayloads = acceptedPayloadEntries.slice(1);
assert.deepEqual(
  evaluateFullRunResultAcceptance({
    executePlan: acceptanceExecutePlan,
    payloadEntries: missingAcceptancePayloads,
    jobConclusions: {
      resolveInputs: "success",
      seed: "success",
      execute: "success",
    },
  }).failures.map(({ code }) => code),
  ["result-identity-missing"],
);

assert.throws(
  () =>
    evaluateFullRunFeedback({
      runId: "incomplete",
      cacheMode: "cold",
      workflow: {
        startedAt: "2026-07-22T00:00:00.000Z",
        completedAt: "2026-07-22T00:01:00.000Z",
      },
    }),
  /plan must be an object/,
);

const slowColdFixture = await loadFixture("run-29917985095");
const slowColdRun = evaluateFullRunFeedback(slowColdFixture);

assert.equal(slowColdRun.passed, false);
assert.equal(slowColdRun.timing.activeWallMs, 4_386_000);
assert.equal(slowColdRun.timing.targetWallMs, 2_700_000);
assert.deepEqual(
  Object.fromEntries(
    Object.entries(slowColdRun.phases).map(([phase, window]) => [
      phase,
      window.durationMs,
    ]),
  ),
  {
    seed: 2_638_000,
    execute: 1_702_000,
    report: 26_000,
  },
);
assert.deepEqual(
  Object.fromEntries(
    Object.entries(slowColdRun.criticalJobs).map(([stage, job]) => [
      stage,
      [job.name, job.durationMs],
    ]),
  ),
  {
    seed: ["seed-shard-4-of-8", 2_638_000],
    v1: ["v1-shard-2-of-8", 1_702_000],
    "v2-sync": ["v2-sync-default-shard-2-of-8", 1_568_000],
    "v2-hybrid": ["v2-hybrid-computed-shard-4-of-8", 232_000],
    report: ["report", 26_000],
  },
);
assert.deepEqual(
  slowColdRun.seed.duplicates.map(
    ({
      seedHash,
      affinityIds,
      shards,
      avoidableBuildMs,
      staticAffinityIssue,
    }) => ({
      seedHash,
      affinityIds,
      shards,
      avoidableBuildMs,
      staticAffinityIssue,
    }),
  ),
  [
    {
      seedHash: "755ae561e41223b4",
      affinityIds: ["record-read/100k-50fields"],
      shards: ["shard-3-of-8", "shard-4-of-8", "shard-5-of-8"],
      avoidableBuildMs: 2_102_534,
      staticAffinityIssue: "declared-affinity-spans-shards",
    },
    {
      seedHash: "search-index-100k-shared",
      affinityIds: ["lookup-search-index/100k-20fields"],
      shards: ["shard-2-of-8", "shard-4-of-8"],
      avoidableBuildMs: 585_386,
      staticAffinityIssue: "declared-affinity-spans-shards",
    },
  ],
);
assert.equal(slowColdRun.seed.avoidableBuildMs, 2_687_920);
assert.equal(slowColdRun.trace.missingFetchCount, 2_300);
assert.equal(slowColdRun.trace.wastedFetchMs, 2_987_000);
assert.deepEqual(
  slowColdRun.failures.map((failure) => failure.code),
  [
    "active-wall",
    "cross-shard-seed-duplication",
    "trace-case-budget",
    "trace-job-budget",
  ],
);

const duplicateOnlyFixture = structuredClone(slowColdFixture);
duplicateOnlyFixture.workflow.completedAt = "2026-07-22T12:31:53.000Z";
duplicateOnlyFixture.phases = {
  seed: {
    startedAt: "2026-07-22T12:02:07.000Z",
    completedAt: "2026-07-22T12:12:07.000Z",
  },
  execute: {
    startedAt: "2026-07-22T12:12:09.000Z",
    completedAt: "2026-07-22T12:27:09.000Z",
  },
  report: {
    startedAt: "2026-07-22T12:27:12.000Z",
    completedAt: "2026-07-22T12:27:38.000Z",
  },
};
for (const job of duplicateOnlyFixture.jobs) {
  job.durationMs = {
    seed: 600_000,
    v1: 900_000,
    "v2-sync": 850_000,
    "v2-hybrid": 180_000,
    report: 26_000,
  }[job.stage];
}
duplicateOnlyFixture.trace.cases[0].waitMs = 15_000;
duplicateOnlyFixture.trace.jobs[0].waitMs = 60_000;
const duplicateOnlyRun = evaluateFullRunFeedback(duplicateOnlyFixture);
assert.equal(duplicateOnlyRun.passed, false);
assert.deepEqual(
  duplicateOnlyRun.failures.map((failure) => failure.code),
  ["cross-shard-seed-duplication"],
);

const missingAffinityFixture = structuredClone(duplicateOnlyFixture);
for (const observation of missingAffinityFixture.seedObservations) {
  delete observation.affinityId;
}
const missingAffinityRun = evaluateFullRunFeedback(missingAffinityFixture);
assert.equal(
  missingAffinityRun.seed.duplicates[0].staticAffinityIssue,
  "missing-affinity-declaration",
);

const partialMissingAffinityFixture = structuredClone(duplicateOnlyFixture);
delete partialMissingAffinityFixture.seedObservations[1].affinityId;
const partialMissingAffinityRun = evaluateFullRunFeedback(
  partialMissingAffinityFixture,
);
assert.equal(
  partialMissingAffinityRun.seed.duplicates[0].staticAffinityIssue,
  "missing-affinity-declaration",
);

const affinityDriftFixture = structuredClone(duplicateOnlyFixture);
affinityDriftFixture.seedObservations[1].affinityId =
  "record-read/other-100k-fixture";
const affinityDriftRun = evaluateFullRunFeedback(affinityDriftFixture);
assert.equal(
  affinityDriftRun.seed.duplicates[0].staticAffinityIssue,
  "seed-hash-maps-to-multiple-affinities",
);

const sameShardMissingAffinityFixture = structuredClone(duplicateOnlyFixture);
for (const observation of sameShardMissingAffinityFixture.seedObservations) {
  observation.shard = "shard-1-of-8";
  delete observation.affinityId;
}
const sameShardMissingAffinityRun = evaluateFullRunFeedback(
  sameShardMissingAffinityFixture,
);
assert.equal(sameShardMissingAffinityRun.seed.duplicates.length, 0);
assert.equal(sameShardMissingAffinityRun.seed.affinityIssues.length, 2);
assert.deepEqual(
  sameShardMissingAffinityRun.seed.affinityIssues.map(({ shards }) => shards),
  [["shard-1-of-8"], ["shard-1-of-8"]],
);
assert.deepEqual(
  sameShardMissingAffinityRun.failures.map(({ code }) => code),
  ["seed-affinity"],
);

const affinityHashSetDrift = resolveDuplicateSeeds([
  {
    caseId: "case/a",
    shard: "shard-1-of-1",
    seedHash: "seed-a",
    affinityId: "fixture/shared",
    buildMs: 10,
  },
  {
    caseId: "case/b",
    shard: "shard-1-of-1",
    seedHash: "seed-b",
    affinityId: "fixture/shared",
    buildMs: 10,
  },
]);
assert.deepEqual(affinityHashSetDrift.affinityIssues, [
  {
    affinityIds: ["fixture/shared"],
    caseIds: ["case/a", "case/b"],
    seedHashes: ["seed-a", "seed-b"],
    shards: ["shard-1-of-1"],
    observations: [
      {
        caseId: "case/a",
        seedHashes: ["seed-a"],
        shards: ["shard-1-of-1"],
      },
      {
        caseId: "case/b",
        seedHashes: ["seed-b"],
        shards: ["shard-1-of-1"],
      },
    ],
    issue: "affinity-maps-to-inconsistent-seed-hash-sets",
  },
]);
const sharedMultiHashFixture = resolveDuplicateSeeds([
  ...["case/a", "case/b"].flatMap((caseId) =>
    ["seed-a", "seed-b"].map((seedHash) => ({
      caseId,
      shard: "shard-1-of-1",
      seedHash,
      affinityId: "fixture/shared",
      buildMs: 10,
    })),
  ),
]);
assert.deepEqual(sharedMultiHashFixture.affinityIssues, []);

const completeCoverage = {
  expectedCaseCount: 2,
  observedCaseCount: 2,
  missingCaseIds: [],
  unexpectedCaseIds: [],
  duplicateCaseIds: [],
  complete: true,
};
const sharedAffinity = [
  { id: "fixture/shared", caseIds: ["case/a", "case/b"] },
];
const sharedObservations = [
  {
    caseId: "case/a",
    shard: "shard-1-of-1",
    seedHash: "seed-a",
    affinityId: "fixture/shared",
    buildMs: 10,
  },
  {
    caseId: "case/b",
    shard: "shard-1-of-1",
    seedHash: "seed-a",
    affinityId: "fixture/shared",
    buildMs: 10,
  },
];
assert.equal(
  evaluateSeedAffinityGate({
    cache: {
      mode: "cold",
      statusCount: 1,
      modeCounts: { "cache-miss": 1 },
    },
    coverage: completeCoverage,
    observations: sharedObservations,
    affinities: sharedAffinity,
  }).passed,
  true,
);
const mixedExactGate = evaluateSeedAffinityGate({
  cache: {
    mode: "mixed",
    statusCount: 2,
    modeCounts: { "exact-hit": 1, "cache-miss": 1 },
  },
  coverage: {
    ...completeCoverage,
    observedCaseCount: 1,
    missingCaseIds: ["case/b"],
    complete: false,
  },
  observations: sharedObservations.slice(0, 1),
  affinities: sharedAffinity,
});
assert.equal(mixedExactGate.passed, false);
assert.deepEqual(
  mixedExactGate.evidenceIssues.map(({ issue }) => issue),
  ["mixed-exact-hit-evidence-incomplete", "seed-payload-coverage-incomplete"],
);
assert.equal(
  mixedExactGate.affinityIssues.some(
    ({ issue }) => issue === "affinity-members-missing-seed-identity",
  ),
  true,
);
const missingIdentityIssue = mixedExactGate.affinityIssues.find(
  ({ issue }) => issue === "affinity-members-missing-seed-identity",
);
assert.equal(missingIdentityIssue.seedHash, "missing");
assert.deepEqual(missingIdentityIssue.shards, ["shard-1-of-1"]);
assert.equal(
  evaluateSeedAffinityGate({
    cache: {
      mode: "mixed",
      statusCount: 2,
      modeCounts: { "exact-hit": 1, "cache-miss": 1 },
    },
    coverage: completeCoverage,
    observations: sharedObservations,
    affinities: sharedAffinity,
    resolvedMixedProvenance: true,
  }).passed,
  true,
  "mixed partial reruns may pass only after exact-hit payload provenance is resolved",
);
const exactHitWarmGate = evaluateSeedAffinityGate({
  cache: {
    mode: "warm",
    statusCount: 2,
    modeCounts: { "exact-hit": 2 },
  },
  coverage: {
    expectedCaseCount: 2,
    observedCaseCount: 0,
    missingCaseIds: ["case/a", "case/b"],
    unexpectedCaseIds: [],
    duplicateCaseIds: [],
    complete: false,
  },
  observations: [],
  affinities: sharedAffinity,
});
assert.equal(exactHitWarmGate.passed, true);
assert.match(exactHitWarmGate.skippedReason, /exact-hit/);
const seedPlanIdentity = {
  name: "shard-1-of-1",
  stableSlot: "slot-1",
  caseSetDigest: "digest-a",
  seedContractGeneration: "seed-contract-v1",
};
const exactStatusEntry = {
  artifactName: "teable-ee-e2e-perf-seed-shard-1-of-1-123-1",
  status: {
    mode: "exact-hit",
    stableSlot: "slot-1",
    caseSetDigest: "digest-a",
    seedContractGeneration: "seed-contract-v1",
    cacheNamespace: "acceptance",
    perfLabSha: "perf-sha-a",
    teableEeSha: "teable-sha-a",
    primaryKey: "exact-key",
    matchedKey: "exact-key",
  },
};
assert.deepEqual(
  evaluateSeedPlanStatusEvidence({
    seedPlan: [seedPlanIdentity],
    statusEntries: [exactStatusEntry],
    expectedCacheNamespace: "acceptance",
  }),
  [],
);
const inconsistentSourceStatuses = evaluateSeedPlanStatusEvidence({
  seedPlan: [
    seedPlanIdentity,
    {
      ...seedPlanIdentity,
      name: "shard-2-of-2",
      stableSlot: "slot-2",
    },
  ],
  statusEntries: [
    {
      ...exactStatusEntry,
      artifactName: "teable-ee-e2e-perf-seed-shard-1-of-2-123-1",
    },
    {
      ...exactStatusEntry,
      artifactName: "teable-ee-e2e-perf-seed-shard-2-of-2-123-2",
      status: {
        ...exactStatusEntry.status,
        stableSlot: "slot-2",
        perfLabSha: "perf-sha-b",
        teableEeSha: "teable-sha-b",
      },
    },
  ],
  expectedCacheNamespace: "acceptance",
  expectedPerfLabSha: "perf-sha-a",
});
assert.deepEqual(
  inconsistentSourceStatuses
    .filter(({ issue }) => issue === "seed-plan-status-source-mismatch")
    .map(({ field }) => field),
  ["perfLabSha", "teableEeSha", "perfLabSha"],
  "cross-attempt seed evidence must not mix perf-lab or teable-ee revisions",
);
const mismatchedWarmStatus = evaluateSeedPlanStatusEvidence({
  seedPlan: [seedPlanIdentity],
  statusEntries: [
    {
      ...exactStatusEntry,
      status: {
        ...exactStatusEntry.status,
        caseSetDigest: "stale-digest",
        matchedKey: "compatible-key",
      },
    },
  ],
  expectedCacheNamespace: "acceptance",
});
assert.deepEqual(
  mismatchedWarmStatus[0].mismatches.map(({ field }) => field),
  ["caseSetDigest", "exactCacheKey"],
);

const partialRerunSeedPlan = [
  {
    name: "shard-1-of-2",
    stableSlot: "slot-1",
    caseSetDigest: "digest-a",
    seedContractGeneration: "seed-contract-v1",
    caseFilter: "case/a",
  },
  {
    name: "shard-2-of-2",
    stableSlot: "slot-2",
    caseSetDigest: "digest-b",
    seedContractGeneration: "seed-contract-v1",
    caseFilter: "case/b",
  },
];
const seedStatus = ({
  shard,
  attempt,
  stableSlot,
  caseSetDigest,
  mode,
  teableEeSha = "teable-sha-a",
}) => ({
  artifactName: `teable-ee-e2e-perf-seed-${shard}-123-${attempt}`,
  status: {
    mode,
    stableSlot,
    caseSetDigest,
    seedContractGeneration: "seed-contract-v1",
    cacheNamespace: "acceptance",
    perfLabSha: "perf-sha-a",
    teableEeSha,
    requiresRunnerValidation: mode !== "exact-hit",
  },
});
const seedPayload = ({ caseId, shard, attempt }) => ({
  artifactName: `teable-ee-e2e-perf-seed-${shard}-123-${attempt}`,
  fileName: `teable-ee-e2e-perf-seed-${shard}-123-${attempt}/${caseId.replace("/", "-")}-seed.json`,
  payload: { caseId, engine: "seed", result: "pass" },
});
const resolvedPartialRerun = resolveSeedPayloadProvenance({
  seedPlan: partialRerunSeedPlan,
  latestStatusEntries: [
    seedStatus({
      shard: "shard-1-of-2",
      attempt: 2,
      stableSlot: "slot-1",
      caseSetDigest: "digest-a",
      mode: "exact-hit",
    }),
    seedStatus({
      shard: "shard-2-of-2",
      attempt: 1,
      stableSlot: "slot-2",
      caseSetDigest: "digest-b",
      mode: "cache-miss",
    }),
  ],
  latestPayloadEntries: [
    seedPayload({
      caseId: "case/b",
      shard: "shard-2-of-2",
      attempt: 1,
    }),
  ],
  provenanceStatusEntries: [
    seedStatus({
      shard: "shard-1-of-2",
      attempt: 1,
      stableSlot: "slot-1",
      caseSetDigest: "digest-a",
      mode: "cache-miss",
    }),
  ],
  provenancePayloadEntries: [
    seedPayload({
      caseId: "case/a",
      shard: "shard-1-of-2",
      attempt: 1,
    }),
  ],
});
assert.equal(resolvedPartialRerun.complete, true);
assert.deepEqual(
  resolvedPartialRerun.payloadEntries.map(({ payload }) => payload.caseId),
  ["case/a", "case/b"],
);
assert.deepEqual(resolvedPartialRerun.provenance, [
  {
    shard: "shard-1-of-2",
    statusArtifact: "teable-ee-e2e-perf-seed-shard-1-of-2-123-2",
    payloadArtifact: "teable-ee-e2e-perf-seed-shard-1-of-2-123-1",
  },
]);

const mismatchedPartialRerun = resolveSeedPayloadProvenance({
  seedPlan: partialRerunSeedPlan.slice(0, 1),
  latestStatusEntries: [
    seedStatus({
      shard: "shard-1-of-2",
      attempt: 2,
      stableSlot: "slot-1",
      caseSetDigest: "digest-a",
      mode: "exact-hit",
    }),
  ],
  latestPayloadEntries: [],
  provenanceStatusEntries: [
    seedStatus({
      shard: "shard-1-of-2",
      attempt: 1,
      stableSlot: "slot-1",
      caseSetDigest: "digest-a",
      mode: "cache-miss",
      teableEeSha: "teable-sha-stale",
    }),
  ],
  provenancePayloadEntries: [
    seedPayload({
      caseId: "case/a",
      shard: "shard-1-of-2",
      attempt: 1,
    }),
  ],
});
assert.equal(mismatchedPartialRerun.complete, false);
assert.equal(
  mismatchedPartialRerun.issues[0].issue,
  "seed-shard-payload-provenance-missing",
);

const mixedCacheHitFixture = structuredClone(duplicateOnlyFixture);
mixedCacheHitFixture.seedObservations[1].buildMs = 0;
mixedCacheHitFixture.seedObservations[2].buildMs = 0;
const mixedCacheHitRun = evaluateFullRunFeedback(mixedCacheHitFixture);
assert.deepEqual(
  mixedCacheHitRun.seed.duplicates.find(
    ({ seedHash }) => seedHash === "755ae561e41223b4",
  )?.shards,
  ["shard-3-of-8", "shard-4-of-8", "shard-5-of-8"],
);

const allCacheHitFixture = structuredClone(duplicateOnlyFixture);
for (const observation of allCacheHitFixture.seedObservations) {
  observation.buildMs = 0;
}
const allCacheHitRun = evaluateFullRunFeedback(allCacheHitFixture);
assert.equal(allCacheHitRun.seed.duplicates.length, 2);
assert.equal(allCacheHitRun.seed.avoidableBuildMs, 0);

const acceptedWarmRun = evaluateFullRunFeedback(
  await loadFixture("run-29751280107"),
);
assert.equal(acceptedWarmRun.passed, true);
assert.equal(acceptedWarmRun.timing.activeWallMs, 878_000);
assert.equal(acceptedWarmRun.timing.targetWallMs, 1_500_000);
assert.equal(acceptedWarmRun.criticalJobs.v1.name, "v1-shard-4-of-7");

const invalidStageFixture = await loadFixture("run-29751280107");
invalidStageFixture.jobs[0].stage = "sead";
assert.throws(
  () => evaluateFullRunFeedback(invalidStageFixture),
  /jobs\[seed-shard-7-of-7\]\.stage must be one of/,
);

const duplicatePlanStageFixture = await loadFixture("run-29751280107");
duplicatePlanStageFixture.plan.requiredStages.push("report");
assert.throws(
  () => evaluateFullRunFeedback(duplicatePlanStageFixture),
  /plan\.requiredStages must contain each full-run stage exactly once/,
);

const missingQueueFixture = await loadFixture("run-29751280107");
delete missingQueueFixture.workflow.queuedAt;
assert.throws(
  () => evaluateFullRunFeedback(missingQueueFixture),
  /workflow\.queuedAt must be an ISO timestamp/,
);

const missingShardFixture = await loadFixture("run-29751280107");
delete missingShardFixture.jobs[0].shard;
assert.throws(
  () => evaluateFullRunFeedback(missingShardFixture),
  /jobs\[seed-shard-7-of-7\]\.shard must be a non-empty string/,
);

const incompleteTraceCaseFixture = await loadFixture("run-29751280107");
incompleteTraceCaseFixture.trace.cases[0] = { waitMs: 0 };
assert.throws(
  () => evaluateFullRunFeedback(incompleteTraceCaseFixture),
  /trace\.cases\[\]\.caseId must be a non-empty string/,
);

const incompleteTraceJobFixture = await loadFixture("run-29751280107");
incompleteTraceJobFixture.trace.jobs[0] = { waitMs: 0 };
assert.throws(
  () => evaluateFullRunFeedback(incompleteTraceJobFixture),
  /trace\.jobs\[\]\.name must be a non-empty string/,
);

const incompleteCachedSeedFixture = await loadFixture("run-29751280107");
incompleteCachedSeedFixture.seedObservations[0] = {
  caseId: "   ",
  shard: "",
  seedHash: "",
  buildMs: 0,
};
assert.throws(
  () => evaluateFullRunFeedback(incompleteCachedSeedFixture),
  /seedObservations\[\]\.caseId must be a non-empty string/,
);

const incompleteCachedSeedAffinityFixture =
  await loadFixture("run-29751280107");
incompleteCachedSeedAffinityFixture.seedObservations[0].affinityId = "";
assert.throws(
  () => evaluateFullRunFeedback(incompleteCachedSeedAffinityFixture),
  /seedObservations\[record-read\/10k-50fields-10x1k-pages\]\.affinityId must be a non-empty string/,
);

const acceptedColdRun = evaluateFullRunFeedback(
  await loadFixture("run-29746682913"),
);
assert.equal(acceptedColdRun.passed, true);
assert.equal(acceptedColdRun.timing.activeWallMs, 2_656_000);
assert.equal(acceptedColdRun.timing.targetWallMs, 2_700_000);
assert.equal(acceptedColdRun.seed.duplicates.length, 0);

const cliPath = fileURLToPath(
  new URL("./evaluate-full-run-feedback.mjs", import.meta.url),
);
const acceptedWarmFixturePath = fileURLToPath(
  new URL("./fixtures/full-run-feedback/run-29751280107.json", import.meta.url),
);
const acceptedWarmCli = spawnSync(
  process.execPath,
  [cliPath, acceptedWarmFixturePath, "--assert"],
  { encoding: "utf8" },
);
assert.equal(acceptedWarmCli.status, 0, acceptedWarmCli.stderr);
assert.match(acceptedWarmCli.stdout, /Full CI feedback: PASS/);
assert.match(acceptedWarmCli.stdout, /active 14m38s \/ target 25m00s/);
assert.match(acceptedWarmCli.stdout, /Trace: 0 missing/);

const slowColdFixturePath = fileURLToPath(
  new URL("./fixtures/full-run-feedback/run-29917985095.json", import.meta.url),
);
const slowColdCli = spawnSync(
  process.execPath,
  [cliPath, slowColdFixturePath, "--assert"],
  { encoding: "utf8" },
);
assert.equal(slowColdCli.status, 1, slowColdCli.stderr);
assert.match(slowColdCli.stdout, /Full CI feedback: FAIL/);
assert.match(slowColdCli.stdout, /active 73m06s \/ target 45m00s/);
assert.match(
  slowColdCli.stdout,
  /Phases: seed 43m58s · execute 28m22s · report 26s/,
);
assert.match(slowColdCli.stdout, /v2-sync v2-sync-default-shard-2-of-8 26m08s/);
assert.match(
  slowColdCli.stdout,
  /Seed 755ae561e41223b4: shard-3-of-8, shard-4-of-8, shard-5-of-8/,
);
assert.match(
  slowColdCli.stdout,
  /static affinity declared-affinity-spans-shards/,
);
assert.match(slowColdCli.stdout, /affinity record-read\/100k-50fields/);
assert.match(
  slowColdCli.stdout,
  /record-read\/100k-50fields-filter-number-greater-half/,
);
assert.match(
  slowColdCli.stdout,
  /Trace case: record-duplicate\/single-500-single-line-text-10fields · v1 · shard-2-of-8 · 3m59s/,
);
assert.match(slowColdCli.stdout, /Trace job: v1-shard-2-of-8 · 3m59s/);

const invalidFixtureDirectory = await mkdtemp(
  join(tmpdir(), "teable-full-run-feedback-"),
);
try {
  const invalidFixturePath = join(invalidFixtureDirectory, "incomplete.json");
  await writeFile(
    invalidFixturePath,
    JSON.stringify({ runId: "incomplete" }),
    "utf8",
  );
  const invalidCli = spawnSync(
    process.execPath,
    [cliPath, invalidFixturePath, "--assert"],
    { encoding: "utf8" },
  );
  assert.equal(invalidCli.status, 2);
  assert.match(invalidCli.stderr, /plan must be an object/);
} finally {
  await rm(invalidFixtureDirectory, { recursive: true, force: true });
}

console.log("Full-run feedback model checks ok");
