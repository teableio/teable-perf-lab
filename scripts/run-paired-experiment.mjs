import { createReadStream } from "node:fs";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { env, requiredEnv } from "./env.mjs";
import { readArtifactPayloads } from "./perf-artifact-read-model.mjs";
import {
  buildPairedExecutionOrder,
  evaluatePairedExperiment,
} from "./paired-experiment-model.mjs";
import { measureRunnerCanary } from "./runner-canary.mjs";

const PAIRED_CONTAINER_PREFIX = "teable-postgres-paired-";
const PAIRED_CACHE_PREFIX = "teable-cache-paired-";
const execFileAsync = promisify(execFile);

export const assertImmutableSha = (value, label) => {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(
      `${label} must be a full immutable 40-character commit SHA`,
    );
  }
};

const assertCheckoutHead = async ({ directory, expectedSha, label }) => {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
  });
  if (stdout.trim().toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error(
      `${label} checkout HEAD ${stdout.trim()} does not match declared ${expectedSha}`,
    );
  }
};

const run = (command, args, { cwd, environment, inputFile } = {}) =>
  new Promise((settle, fail) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: [inputFile ? "pipe" : "ignore", "inherit", "inherit"],
    });
    child.once("error", fail);
    child.once("close", (code) => settle(code ?? 1));
    if (inputFile) {
      const input = createReadStream(inputFile);
      input.once("error", fail);
      input.pipe(child.stdin);
    }
  });

const requireSuccess = async (command, args, options) => {
  const code = await run(command, args, options);
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${code}`);
  }
};

export const assertSafeInputs = async ({
  baseDir,
  candidateDir,
  dumpPath,
  containerName,
  cacheContainerName,
  artifactDir,
}) => {
  if (!containerName.startsWith(PAIRED_CONTAINER_PREFIX)) {
    throw new Error(
      `Refusing database restore into ${containerName}; paired containers must start with ${PAIRED_CONTAINER_PREFIX}`,
    );
  }
  if (!cacheContainerName.startsWith(PAIRED_CACHE_PREFIX)) {
    throw new Error(
      `Refusing cache reset in ${cacheContainerName}; paired cache containers must start with ${PAIRED_CACHE_PREFIX}`,
    );
  }
  for (const directory of [baseDir, candidateDir]) {
    await access(join(directory, ".git"));
    await access(join(directory, "pnpm-lock.yaml"));
  }
  await access(dumpPath);
  await mkdir(artifactDir, { recursive: true });
  const existing = await readdir(artifactDir);
  if (existing.length > 0) {
    throw new Error(
      `Refusing to mix paired observations into non-empty artifact directory ${artifactDir}`,
    );
  }
};

const restoreDatabase = async ({ containerName, dumpPath }) => {
  await requireSuccess("docker", [
    "exec",
    containerName,
    "dropdb",
    "-U",
    "teable",
    "--if-exists",
    "e2e_test_teable",
  ]);
  await requireSuccess("docker", [
    "exec",
    containerName,
    "createdb",
    "-U",
    "teable",
    "e2e_test_teable",
  ]);
  await requireSuccess(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "pg_restore",
      "-U",
      "teable",
      "-d",
      "e2e_test_teable",
      "--clean",
      "--if-exists",
    ],
    { inputFile: dumpPath },
  );
};

const resetCache = async ({ cacheContainerName }) => {
  await requireSuccess("docker", [
    "exec",
    cacheContainerName,
    "redis-cli",
    "FLUSHALL",
  ]);
};

export const markdownOf = (result) => {
  const lines = [
    "## Paired performance experiment",
    "",
    `Verdict: **${result.status.toUpperCase()}**`,
    "",
    `Policy: ${(result.policy.practicalRegression * 100).toFixed(1)}% practical budget · ${result.policy.minPairs} minimum pairs · ${(result.policy.confidence * 100).toFixed(0)}% CI · BH q≤${result.policy.falseDiscoveryRate}`,
    "",
    "| Case | Verdict | Candidate / base | Confidence interval | q | Pairs | MDE 80% | Environment |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const item of result.cases) {
    const ratio = Number.isFinite(item.ratio)
      ? `${item.ratio.toFixed(3)}x`
      : "n/a";
    const interval = item.confidenceInterval
      ? `[${item.confidenceInterval[0].toFixed(3)}x, ${item.confidenceInterval[1].toFixed(3)}x]`
      : "n/a";
    const adjusted = Number.isFinite(item.adjustedPValue)
      ? item.adjustedPValue.toPrecision(3)
      : "n/a";
    const mde = Number.isFinite(item.mde80)
      ? `${(item.mde80 * 100).toFixed(1)}%`
      : "n/a";
    const environment = item.environment?.ratio
      ? `${item.environment.status} ${item.environment.ratio.toFixed(3)}x`
      : item.environment?.status || "unmeasured";
    lines.push(
      `| ${item.caseId} | ${item.status} | ${ratio} | ${interval} | ${adjusted} | ${item.pairs} | ${mde} | ${environment} |`,
    );
    if (item.reason) {
      lines.push(`| ↳ reason | ${item.reason} | | | | | | |`);
    }
  }
  lines.push(
    "",
    "Only `regression` is evidence for a code regression. `candidate` needs more data; `inconclusive` is never a pass.",
    "",
  );
  return lines.join("\n");
};

export const main = async () => {
  const baseDir = resolve(requiredEnv("PERF_LAB_PAIRED_BASE_DIR"));
  const candidateDir = resolve(requiredEnv("PERF_LAB_PAIRED_CANDIDATE_DIR"));
  const artifactDir = resolve(requiredEnv("PERF_LAB_ARTIFACT_DIR"));
  const dumpPath = resolve(requiredEnv("PERF_LAB_SEED_DB_DUMP"));
  const containerName = requiredEnv("TEST_PG_CONTAINER_NAME");
  const cacheContainerName = requiredEnv("TEST_CACHE_CONTAINER_NAME");
  await assertSafeInputs({
    baseDir,
    candidateDir,
    dumpPath,
    containerName,
    cacheContainerName,
    artifactDir,
  });

  const caseFilter = requiredEnv("PERF_LAB_CASE_FILTER");
  const experimentId = env(
    "PERF_LAB_EXPERIMENT_ID",
    `paired-${env("GITHUB_RUN_ID", Date.now())}`,
  );
  const pairCount = Number(env("PERF_LAB_PAIRED_PAIRS", "10"));
  if (!Number.isSafeInteger(pairCount) || pairCount < 1 || pairCount > 100) {
    throw new Error(
      `PERF_LAB_PAIRED_PAIRS must be an integer from 1 to 100, received ${pairCount}`,
    );
  }
  const engine = env("PERF_LAB_ENGINE", "v2");
  const practicalRegression = Number(
    env("PERF_LAB_PRACTICAL_REGRESSION", "0.10"),
  );
  if (!(practicalRegression >= 0 && practicalRegression < 1)) {
    throw new Error(
      `PERF_LAB_PRACTICAL_REGRESSION must be in [0, 1), received ${practicalRegression}`,
    );
  }
  const baseSha = requiredEnv("PERF_LAB_PAIRED_BASE_SHA");
  const candidateSha = requiredEnv("PERF_LAB_PAIRED_CANDIDATE_SHA");
  assertImmutableSha(baseSha, "PERF_LAB_PAIRED_BASE_SHA");
  assertImmutableSha(candidateSha, "PERF_LAB_PAIRED_CANDIDATE_SHA");
  await assertCheckoutHead({
    directory: baseDir,
    expectedSha: baseSha,
    label: "base",
  });
  await assertCheckoutHead({
    directory: candidateDir,
    expectedSha: candidateSha,
    label: "candidate",
  });
  const seedSchemaSignature = requiredEnv("PERF_LAB_SEED_SCHEMA_SIGNATURE");
  const variants = {
    base: {
      directory: baseDir,
      sha: baseSha,
    },
    candidate: {
      directory: candidateDir,
      sha: candidateSha,
    },
  };
  const order = buildPairedExecutionOrder({
    pairs: pairCount,
    seed: experimentId,
  });
  await writeFile(
    join(artifactDir, "paired-plan.json"),
    `${JSON.stringify({ experimentId, caseFilter, engine, order }, null, 2)}\n`,
  );

  const childFailures = [];
  for (const pair of order) {
    for (const variantName of pair.variants) {
      const variant = variants[variantName];
      console.log(
        `Paired experiment ${pair.pairId}: ${variantName} (${variant.sha.slice(0, 12)})`,
      );
      await restoreDatabase({ containerName, dumpPath });
      await resetCache({ cacheContainerName });
      const canary = await measureRunnerCanary({ containerName });
      const observationDir = join(
        artifactDir,
        "observations",
        pair.pairId,
        variantName,
      );
      await mkdir(observationDir, { recursive: true });
      const childEnv = {
        ...process.env,
        PERF_LAB_ARTIFACT_DIR: observationDir,
        PERF_LAB_RUN_ID: experimentId,
        PERF_LAB_MODE: "execute",
        PERF_LAB_CASE_FILTER: caseFilter,
        PERF_LAB_EXCLUDE_CASE_FILTER: "",
        PERF_LAB_ENGINE_LIST: engine,
        PERF_LAB_ENGINE: engine,
        PERF_LAB_SAMPLES: "1",
        PERF_LAB_THRESHOLD_MODE: "observe",
        PERF_LAB_TRACE_ENABLED: "false",
        OTEL_EXPORT_RATIO: "0",
        PERF_LAB_RUN_LANE: "paired",
        PERF_LAB_EXPERIMENT_ID: experimentId,
        PERF_LAB_VARIANT: variantName,
        PERF_LAB_PAIR_ID: pair.pairId,
        PERF_LAB_PAIR_ORDER: pair.order,
        PERF_LAB_SAMPLE_INDEX: String(pair.sampleIndex),
        PERF_LAB_TEABLE_EE_SHA: variant.sha,
        PERF_LAB_CPU_CANARY_MS: String(canary.cpuCanaryMs),
        PERF_LAB_DATABASE_CANARY_MS: String(canary.databaseCanaryMs),
        PERF_LAB_DATABASE_CLASS: "postgres-e2e",
        PERF_LAB_SEED_SCHEMA_SIGNATURE: seedSchemaSignature,
        PERF_LAB_SHARD_ID: "paired-single-host",
        PERF_LAB_OTEL_SERVICE_PREFIX: `teable-perf-paired-${variantName}`,
      };
      const code = await run(
        "pnpm",
        [
          "-F",
          "@teable/backend-ee",
          "exec",
          "vitest",
          "run",
          "--config",
          "./vitest-perf-lab.config.ts",
          "../../community/apps/nestjs-backend/test/perf-lab/perf-lab.e2e-spec.ts",
          "--silent=false",
        ],
        { cwd: variant.directory, environment: childEnv },
      );
      if (code !== 0) {
        childFailures.push({ pairId: pair.pairId, variant: variantName, code });
      }
    }
  }

  const entries = await readArtifactPayloads({
    artifactDir,
    includeSeed: false,
    allowEmpty: true,
  });
  const result = evaluatePairedExperiment({
    payloads: entries.map(({ payload }) => payload),
    policy: { practicalRegression },
    seed: experimentId,
  });
  result.experiment = {
    id: experimentId,
    baseSha: variants.base.sha,
    candidateSha: variants.candidate.sha,
    caseFilter,
    childFailures,
  };
  if (childFailures.length > 0 && result.status === "pass") {
    result.status = "inconclusive";
  }
  await writeFile(
    join(artifactDir, "paired-verdict.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  await writeFile(join(artifactDir, "paired-summary.md"), markdownOf(result));
  console.log(
    `Paired experiment complete: ${result.status}; ${entries.length} observations; ${childFailures.length} child failures.`,
  );
};

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.stack || error.message : error,
    );
    process.exitCode = 1;
  });
}
