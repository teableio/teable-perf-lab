// Safe preparation half of a paired experiment.
//
// This command resolves an explicit case list against the checked-out catalog,
// pins the clean perf-lab checkout HEAD as the harness identity, and writes the
// immutable balanced plan consumed by a separately authorized collector. It
// does not check out or execute product code and does not touch a database or
// cache.

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { argv } from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadCaseCatalog } from "./case-catalog.mjs";
import { env, requiredEnv } from "./env.mjs";
import {
  assertFullCommitSha,
  buildPairedPlan,
  measurementContractIdOf,
} from "./paired-experiment-model.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PAIRED_CONTRACT_MANIFEST_REVISION = "paired-contract-preflight-v1";

export const parseExplicitCaseIds = (value) => {
  const raw = String(value ?? "");
  if (/[*?\[\]]/.test(raw) || raw.trim().toLowerCase() === "all") {
    throw new Error(
      "PERF_LAB_PAIRED_CASE_IDS must contain explicit comma-separated case IDs, not a wildcard or all",
    );
  }
  const entries = raw
    .split(",")
    .map((caseId) => caseId.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error(
      "PERF_LAB_PAIRED_CASE_IDS must contain at least one case ID",
    );
  }
  if (new Set(entries).size !== entries.length) {
    throw new Error("PERF_LAB_PAIRED_CASE_IDS must not contain duplicates");
  }
  return entries;
};

export const resolvePairedCaseIds = ({ catalog = [], rawCaseIds, engine }) => {
  if (!["v1", "v2"].includes(engine)) {
    throw new Error(
      `PERF_LAB_PAIRED_ENGINE must be v1 or v2, received ${engine}`,
    );
  }
  const requested = parseExplicitCaseIds(rawCaseIds);
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const unknown = requested.filter((caseId) => !byId.has(caseId));
  if (unknown.length > 0) {
    throw new Error(`Unknown paired case IDs: ${unknown.join(", ")}`);
  }
  const unsupported = requested.filter((caseId) =>
    byId.get(caseId)?.expectedSkipEngines?.includes(engine),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Paired cases do not support engine ${engine}: ${unsupported.join(", ")}`,
    );
  }
  return requested.sort();
};

export const readCleanPerfLabIdentity = async (directory = repoRoot) => {
  const [{ stdout: shaOutput }, { stdout: statusOutput }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: directory,
    }),
  ]);
  const sha = shaOutput.trim();
  assertFullCommitSha(sha, "perfLabSha");
  if (statusOutput.trim()) {
    throw new Error(
      "The perf-lab checkout must have no tracked changes before creating an auditable paired plan",
    );
  }
  return sha;
};

const parsePairs = (value) => {
  const pairs = Number(value);
  if (!Number.isSafeInteger(pairs) || pairs <= 0) {
    throw new Error(
      `PERF_LAB_PAIRED_PAIRS must be a positive integer, received ${value}`,
    );
  }
  return pairs;
};

export const caseContractsFromPreflight = ({
  manifest,
  caseIds,
  baseSha,
  candidateSha,
  perfLabSha,
  engine,
  computedUpdateMode,
  sampleCount,
  schemaSignature,
}) => {
  const expectedEnvelope = {
    revision: PAIRED_CONTRACT_MANIFEST_REVISION,
    baseSha,
    candidateSha,
    perfLabSha,
    engine,
    computedUpdateMode,
    sampleCount,
    schemaSignature,
  };
  for (const [field, expected] of Object.entries(expectedEnvelope)) {
    if (manifest?.[field] !== expected) {
      throw new Error(
        `Paired contract preflight ${field} does not match the plan input`,
      );
    }
  }
  const entries = Object.entries(manifest?.cases ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  const expectedIds = [...caseIds].sort();
  if (
    entries.length !== expectedIds.length ||
    entries.some(([caseId], index) => caseId !== expectedIds[index])
  ) {
    throw new Error(
      "Paired contract preflight must contain exactly every planned case",
    );
  }
  return Object.fromEntries(
    entries.map(([caseId, variants]) => {
      const base = variants?.base;
      const candidate = variants?.candidate;
      if (
        !base ||
        !candidate ||
        base.id !== candidate.id ||
        base.id !== measurementContractIdOf(base) ||
        candidate.id !== measurementContractIdOf(candidate)
      ) {
        throw new Error(
          `Base and candidate preflight contracts differ or are invalid for ${caseId}`,
        );
      }
      return [caseId, base];
    }),
  );
};

export const main = async ({
  catalogLoader = loadCaseCatalog,
  perfLabIdentityReader = readCleanPerfLabIdentity,
} = {}) => {
  const engine = env("PERF_LAB_PAIRED_ENGINE", "v2").trim();
  const catalog = await catalogLoader(repoRoot);
  const caseIds = resolvePairedCaseIds({
    catalog,
    rawCaseIds: requiredEnv("PERF_LAB_PAIRED_CASE_IDS"),
    engine,
  });
  const perfLabSha = await perfLabIdentityReader(repoRoot);
  const expectedPerfLabSha = env("PERF_LAB_SHA").trim();
  if (expectedPerfLabSha) {
    assertFullCommitSha(expectedPerfLabSha, "PERF_LAB_SHA");
    if (expectedPerfLabSha.toLowerCase() !== perfLabSha.toLowerCase()) {
      throw new Error(
        "PERF_LAB_SHA does not match the clean perf-lab checkout HEAD",
      );
    }
  }
  const baseSha = requiredEnv("PERF_LAB_PAIRED_BASE_SHA").trim();
  const candidateSha = requiredEnv("PERF_LAB_PAIRED_CANDIDATE_SHA").trim();
  const computedUpdateMode = env(
    "PERF_LAB_COMPUTED_UPDATE_MODE",
    "sync",
  ).trim();
  const sampleCount = parsePairs(env("PERF_LAB_PAIRED_SAMPLE_COUNT", "1"));
  const schemaSignature = requiredEnv("PERF_LAB_SEED_SCHEMA_SIGNATURE").trim();
  const preflightPath = resolve(
    requiredEnv("PERF_LAB_PAIRED_CONTRACT_MANIFEST_PATH"),
  );
  const manifest = JSON.parse(await readFile(preflightPath, "utf8"));
  const caseContracts = caseContractsFromPreflight({
    manifest,
    caseIds,
    baseSha,
    candidateSha,
    perfLabSha,
    engine,
    computedUpdateMode,
    sampleCount,
    schemaSignature,
  });
  const plan = buildPairedPlan({
    experimentId: requiredEnv("PERF_LAB_PAIRED_EXPERIMENT_ID").trim(),
    baseSha,
    candidateSha,
    perfLabSha,
    caseFilter: caseIds.join(","),
    caseIds,
    engine,
    pairs: parsePairs(env("PERF_LAB_PAIRED_PAIRS", "10")),
    schemaSignature,
    computedUpdateMode,
    sampleCount,
    caseContracts,
  });
  const outputPath = resolve(
    env("PERF_LAB_PAIRED_PLAN_PATH", "paired-plan.json"),
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    `Paired plan created: ${outputPath} (${caseIds.length} cases × ${plan.order.length} pairs).`,
  );
  return plan;
};

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.stack || error.message : error,
    );
    process.exitCode = 1;
  });
}
