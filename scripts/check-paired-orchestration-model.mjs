import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPairedArtifactIdentities,
  main,
  markdownOf,
} from "./evaluate-paired-experiment.mjs";
import {
  assertFullCommitSha,
  buildPairedPlan,
  measurementContractIdOf,
} from "./paired-experiment-model.mjs";

const baseSha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const perfLabSha = "c".repeat(40);
assertFullCommitSha(baseSha, "base");
assert.throws(() => assertFullCommitSha("main", "base"), /full immutable/);

const measurementContractWithoutId = {
  protocolVersion: "v1",
  caseId: "record-read/example",
  runner: "record-read",
  workloadDigest: "e".repeat(24),
  primaryMetric: {
    name: "durationMs",
    unit: "ms",
    direction: "lower-is-better",
  },
  engine: "v2",
  computedUpdateMode: "sync",
  sampleCount: 1,
  seedSchemaSignature: "schema-a",
};
const measurementContract = {
  id: measurementContractIdOf(measurementContractWithoutId),
  ...measurementContractWithoutId,
};

const plan = buildPairedPlan({
  experimentId: "experiment-a",
  baseSha,
  candidateSha,
  perfLabSha,
  caseFilter: "record-read/example",
  caseIds: ["record-read/example"],
  pairs: 10,
  schemaSignature: "schema-a",
  caseContracts: { "record-read/example": measurementContract },
});
assert.equal(plan.order.length, 10);
assert.equal(
  plan.order.filter((pair) => pair.order === "base-candidate").length,
  5,
);

const artifact = ({ variant, sha, pair = plan.order[0] }) => ({
  caseId: "record-read/example",
  engine: "v2",
  thresholds: [{ metric: "durationMs", unit: "ms", actual: 100, passed: true }],
  measurement: {
    contract: measurementContract,
    execution: {
      lane: "paired",
      experimentId: "experiment-a",
      variant,
      teableEeSha: sha,
      pairId: pair.pairId,
      pairOrder: pair.order,
      sampleIndex: pair.sampleIndex,
      perfLabSha,
      jobId: "paired-job",
      shardId: "paired-single-host",
    },
  },
});
const singlePairPlan = { ...plan, order: [plan.order[0]] };
assert.doesNotThrow(() =>
  assertPairedArtifactIdentities({
    payloads: [
      artifact({ variant: "base", sha: baseSha }),
      artifact({ variant: "candidate", sha: candidateSha }),
    ],
    plan: singlePairPlan,
  }),
);
assert.throws(
  () =>
    assertPairedArtifactIdentities({
      payloads: [artifact({ variant: "candidate", sha: baseSha })],
      plan: singlePairPlan,
    }),
  /invalid variant or product SHA/,
);
assert.throws(
  () =>
    assertPairedArtifactIdentities({
      payloads: [
        { ...artifact({ variant: "base", sha: baseSha }), engine: "v1" },
        artifact({ variant: "candidate", sha: candidateSha }),
      ],
      plan: singlePairPlan,
    }),
  /planned engine or schema contract/,
);
assert.throws(
  () =>
    assertPairedArtifactIdentities({
      payloads: [
        {
          ...artifact({ variant: "base", sha: baseSha }),
          measurement: {
            ...artifact({ variant: "base", sha: baseSha }).measurement,
            contract: {
              ...measurementContract,
              computedUpdateMode: "hybrid",
            },
          },
        },
        artifact({ variant: "candidate", sha: candidateSha }),
      ],
      plan: singlePairPlan,
    }),
  /planned engine or schema contract/,
);
assert.throws(
  () =>
    assertPairedArtifactIdentities({
      payloads: [
        {
          ...artifact({ variant: "base", sha: baseSha }),
          measurement: {
            ...artifact({ variant: "base", sha: baseSha }).measurement,
            execution: {
              ...artifact({ variant: "base", sha: baseSha }).measurement
                .execution,
              perfLabSha: "d".repeat(40),
            },
          },
        },
        artifact({ variant: "candidate", sha: candidateSha }),
      ],
      plan: singlePairPlan,
    }),
  /missing immutable execution provenance/,
);

const markdown = markdownOf({
  status: "inconclusive",
  policy: {
    practicalRegression: 0.1,
    minPairs: 10,
    confidence: 0.95,
    falseDiscoveryRate: 0.05,
  },
  cases: [
    {
      caseId: "record-read/example",
      status: "inconclusive",
      pairs: 4,
      reason: "insufficient-pairs",
      environment: { status: "stable" },
    },
  ],
});
assert.match(markdown, /Only `regression` is evidence/);
assert.match(markdown, /insufficient-pairs/);

const artifactDir = await mkdtemp(join(tmpdir(), "paired-offline-verdict-"));
for (let index = 0; index < 10; index += 1) {
  const plannedPair = plan.order[index];
  for (const variant of ["base", "candidate"]) {
    const payload = {
      caseId: "record-read/example",
      engine: "v2",
      result: "pass",
      thresholds: [
        { metric: "durationMs", unit: "ms", actual: 100, passed: true },
      ],
      measurement: {
        contract: {
          ...measurementContract,
        },
        environment: {
          class: "runner:Linux:X64:postgres-e2e",
          fingerprint: "environment-a",
          cpuCanaryMs: 10,
          databaseCanaryMs: 5,
        },
        execution: {
          lane: "paired",
          experimentId: "experiment-a",
          variant,
          pairId: plannedPair.pairId,
          pairOrder: plannedPair.order,
          sampleIndex: plannedPair.sampleIndex,
          teableEeSha: variant === "base" ? baseSha : candidateSha,
          perfLabSha,
          jobId: "paired-job",
          shardId: "paired-single-host",
        },
      },
    };
    await writeFile(
      join(artifactDir, `${index}-${variant}.json`),
      JSON.stringify(payload),
    );
  }
}
process.env.PERF_LAB_ARTIFACT_DIR = artifactDir;
const planPath = join(artifactDir, "paired-plan.json");
await writeFile(planPath, JSON.stringify(plan));
process.env.PERF_LAB_PAIRED_PLAN_PATH = planPath;
process.env.PERF_LAB_PAIRED_BASE_DIR = artifactDir;
process.env.PERF_LAB_PAIRED_CANDIDATE_DIR = artifactDir;
await main({
  verifySchema: async () => ({ compatible: true, baseDigest: "schema-a" }),
  readPerfLabIdentity: async () => perfLabSha,
});
const verdict = JSON.parse(
  await readFile(join(artifactDir, "paired-verdict.json"), "utf8"),
);
assert.equal(verdict.status, "pass");
assert.equal(verdict.experiment.baseSha, baseSha);
assert.equal(verdict.experiment.perfLabSha, perfLabSha);
assert.deepEqual(verdict.experiment.jobIds, ["paired-job"]);
assert.deepEqual(verdict.experiment.pairOrders.sort(), [
  "base-candidate",
  "candidate-base",
]);
assert.deepEqual(verdict.cases[0].identity.contractIds, [
  measurementContract.id,
]);
await assert.rejects(
  main({
    verifySchema: async () => ({ compatible: true, baseDigest: "schema-a" }),
    readPerfLabIdentity: async () => "f".repeat(40),
  }),
  /Evaluator checkout HEAD does not match/,
);

console.log("paired orchestration checks passed");
