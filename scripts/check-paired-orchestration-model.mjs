import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertImmutableSha,
  assertSafeInputs,
  markdownOf,
} from "./run-paired-experiment.mjs";

assertImmutableSha("a".repeat(40), "base");
assert.throws(() => assertImmutableSha("main", "base"), /full immutable/);

const root = await mkdtemp(join(tmpdir(), "paired-orchestration-"));
const baseDir = join(root, "base");
const candidateDir = join(root, "candidate");
const dumpPath = join(root, "seed.dump");
const artifactDir = join(root, "artifacts");
for (const directory of [baseDir, candidateDir]) {
  await mkdir(join(directory, ".git"), { recursive: true });
  await writeFile(
    join(directory, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n",
  );
}
await writeFile(dumpPath, "fixture");

await assertSafeInputs({
  baseDir,
  candidateDir,
  dumpPath,
  containerName: "teable-postgres-paired-test",
  cacheContainerName: "teable-cache-paired-test",
  artifactDir,
});
await assert.rejects(
  assertSafeInputs({
    baseDir,
    candidateDir,
    dumpPath,
    containerName: "teable-postgres",
    cacheContainerName: "teable-cache-paired-test",
    artifactDir: join(root, "unsafe-artifacts"),
  }),
  /Refusing database restore/,
);
await assert.rejects(
  assertSafeInputs({
    baseDir,
    candidateDir,
    dumpPath,
    containerName: "teable-postgres-paired-test",
    cacheContainerName: "teable-cache",
    artifactDir: join(root, "unsafe-cache-artifacts"),
  }),
  /Refusing cache reset/,
);
await writeFile(join(artifactDir, "stale.json"), "{}\n");
await assert.rejects(
  assertSafeInputs({
    baseDir,
    candidateDir,
    dumpPath,
    containerName: "teable-postgres-paired-test",
    cacheContainerName: "teable-cache-paired-test",
    artifactDir,
  }),
  /non-empty artifact directory/,
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
      environment: { status: "stable", ratio: 1.01 },
    },
  ],
});
assert.match(markdown, /Only `regression` is evidence/);
assert.match(markdown, /insufficient-pairs/);

console.log("paired orchestration checks passed");
