import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { requiredEnv } from "./env.mjs";
import { measurementContractIdOf } from "./paired-experiment-model.mjs";
import { PAIRED_CONTRACT_MANIFEST_REVISION } from "./create-paired-plan.mjs";

const fullSha = (value, label) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(
      `${label} must be a full immutable 40-character commit SHA`,
    );
  }
  return normalized;
};

const positiveInteger = (value, label) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
};

const contractsByCase = async ({
  contractPath,
  variant,
  expectedSha,
  perfLabSha,
}) => {
  const document = JSON.parse(await readFile(resolve(contractPath), "utf8"));
  if (
    document?.variant !== variant ||
    String(document?.teableEeSha ?? "").toLowerCase() !== expectedSha ||
    String(document?.perfLabSha ?? "").toLowerCase() !== perfLabSha
  ) {
    throw new Error(
      `Preflight ${variant} contract document identity is invalid`,
    );
  }
  const contracts = new Map();
  for (const [caseId, contract] of Object.entries(document?.contracts ?? {})) {
    if (
      contract?.caseId !== caseId ||
      contract.id !== measurementContractIdOf(contract)
    ) {
      throw new Error(
        `Preflight measurement contract is invalid for ${caseId}`,
      );
    }
    contracts.set(caseId, contract);
  }
  return contracts;
};

export const buildPairedContractPreflight = async ({
  baseContractPath,
  candidateContractPath,
  baseSha,
  candidateSha,
  perfLabSha,
  engine,
  computedUpdateMode,
  sampleCount,
  schemaSignature,
}) => {
  if (!["v1", "v2"].includes(engine)) {
    throw new Error(`engine must be v1 or v2, received ${engine}`);
  }
  if (!["sync", "hybrid"].includes(computedUpdateMode)) {
    throw new Error(
      `computedUpdateMode must be sync or hybrid, received ${computedUpdateMode}`,
    );
  }
  const envelope = {
    revision: PAIRED_CONTRACT_MANIFEST_REVISION,
    baseSha: fullSha(baseSha, "baseSha"),
    candidateSha: fullSha(candidateSha, "candidateSha"),
    perfLabSha: fullSha(perfLabSha, "perfLabSha"),
    engine,
    computedUpdateMode,
    sampleCount: positiveInteger(sampleCount, "sampleCount"),
    schemaSignature: String(schemaSignature ?? "").trim(),
  };
  if (!envelope.schemaSignature) {
    throw new Error("schemaSignature is required");
  }
  const [baseContracts, candidateContracts] = await Promise.all([
    contractsByCase({
      contractPath: baseContractPath,
      variant: "base",
      expectedSha: envelope.baseSha,
      perfLabSha: envelope.perfLabSha,
    }),
    contractsByCase({
      contractPath: candidateContractPath,
      variant: "candidate",
      expectedSha: envelope.candidateSha,
      perfLabSha: envelope.perfLabSha,
    }),
  ]);
  const caseIds = [
    ...new Set([...baseContracts.keys(), ...candidateContracts.keys()]),
  ].sort();
  if (caseIds.length === 0) {
    throw new Error("Paired contract preflight found no contracts");
  }
  const cases = {};
  for (const caseId of caseIds) {
    const base = baseContracts.get(caseId);
    const candidate = candidateContracts.get(caseId);
    if (!base || !candidate) {
      throw new Error(
        `Preflight is missing a base or candidate contract for ${caseId}`,
      );
    }
    if (JSON.stringify(base) !== JSON.stringify(candidate)) {
      throw new Error(
        `Base and candidate preflight contracts differ for ${caseId}`,
      );
    }
    for (const contract of [base, candidate]) {
      if (
        contract.engine !== envelope.engine ||
        contract.computedUpdateMode !== envelope.computedUpdateMode ||
        contract.sampleCount !== envelope.sampleCount ||
        contract.seedSchemaSignature !== envelope.schemaSignature
      ) {
        throw new Error(`Preflight contract envelope differs for ${caseId}`);
      }
    }
    cases[caseId] = { base, candidate };
  }
  return { ...envelope, cases };
};

export const main = async () => {
  const manifest = await buildPairedContractPreflight({
    baseContractPath: requiredEnv("PERF_LAB_PAIRED_BASE_CONTRACT_PATH"),
    candidateContractPath: requiredEnv(
      "PERF_LAB_PAIRED_CANDIDATE_CONTRACT_PATH",
    ),
    baseSha: requiredEnv("PERF_LAB_PAIRED_BASE_SHA"),
    candidateSha: requiredEnv("PERF_LAB_PAIRED_CANDIDATE_SHA"),
    perfLabSha: requiredEnv("PERF_LAB_SHA"),
    engine: requiredEnv("PERF_LAB_PAIRED_ENGINE"),
    computedUpdateMode: requiredEnv("PERF_LAB_COMPUTED_UPDATE_MODE"),
    sampleCount: requiredEnv("PERF_LAB_PAIRED_SAMPLE_COUNT"),
    schemaSignature: requiredEnv("PERF_LAB_SEED_SCHEMA_SIGNATURE"),
  });
  const outputPath = resolve(
    requiredEnv("PERF_LAB_PAIRED_CONTRACT_MANIFEST_PATH"),
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    `Paired contract preflight created: ${outputPath} (${Object.keys(manifest.cases).length} cases).`,
  );
  return manifest;
};

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.stack || error.message : error,
    );
    process.exitCode = 1;
  });
}
