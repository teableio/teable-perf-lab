import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateFullRunFeedback } from "./full-run-feedback-model.mjs";

const loadFixture = async (name) =>
  JSON.parse(
    await readFile(
      new URL(`./fixtures/full-run-feedback/${name}.json`, import.meta.url),
      "utf8",
    ),
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
