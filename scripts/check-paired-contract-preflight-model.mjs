import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPairedContractPreflight } from "./build-paired-contract-preflight.mjs";
import { measurementContractIdOf } from "./paired-experiment-model.mjs";

const root = await mkdtemp(join(tmpdir(), "paired-preflight-"));
const baseContractPath = join(root, "base.json");
const candidateContractPath = join(root, "candidate.json");
const baseSha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const perfLabSha = "c".repeat(40);
const contractWithoutId = {
  protocolVersion: "v1",
  caseId: "record-read/example",
  runner: "record-read",
  engine: "v2",
  workloadDigest: "d".repeat(24),
  primaryMetric: {
    name: "durationMs",
    unit: "ms",
    direction: "lower-is-better",
  },
  computedUpdateMode: "sync",
  sampleCount: 1,
  seedSchemaSignature: "schema-a",
};
const contract = {
  id: measurementContractIdOf(contractWithoutId),
  ...contractWithoutId,
};
const writeContracts = async ({ path, variant, sha, value = contract }) =>
  writeFile(
    path,
    JSON.stringify({
      variant,
      teableEeSha: sha,
      perfLabSha,
      contracts: { [contract.caseId]: value },
    }),
  );
await Promise.all([
  writeContracts({ path: baseContractPath, variant: "base", sha: baseSha }),
  writeContracts({
    path: candidateContractPath,
    variant: "candidate",
    sha: candidateSha,
  }),
]);

const options = {
  baseContractPath,
  candidateContractPath,
  baseSha,
  candidateSha,
  perfLabSha,
  engine: "v2",
  computedUpdateMode: "sync",
  sampleCount: 1,
  schemaSignature: "schema-a",
};
const manifest = await buildPairedContractPreflight(options);
assert.equal(manifest.revision, "paired-contract-preflight-v1");
assert.deepEqual(manifest.cases[contract.caseId], {
  base: contract,
  candidate: contract,
});

await writeContracts({
  path: candidateContractPath,
  variant: "candidate",
  sha: candidateSha,
  value: { ...contract, sampleCount: 2 },
});
await assert.rejects(
  buildPairedContractPreflight(options),
  /measurement contract is invalid|contracts differ/,
);

console.log("paired contract preflight checks passed");
