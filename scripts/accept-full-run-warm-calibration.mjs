#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readArtifactPayloads,
  readSeedCacheStatuses,
} from "./perf-artifact-read-model.mjs";
import { FULL_RUN_STAGE_CALIBRATION } from "./full-run-stage-calibration.mjs";
import { resolveFullRunCaseIds } from "./full-run-shard-model.mjs";
import { validateFullRunResultPayloads } from "./refresh-full-run-calibration.mjs";
import { loadRegisteredCases } from "./run-plan.mjs";
import { summarizeSeedCacheStatuses } from "./stage-plan-observation-model.mjs";
import { evaluateSeedPlanStatusEvidence } from "./verify-full-run-seed-affinity.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const oneValue = (values, label) => {
  const unique = [...new Set(values)];
  if (unique.length !== 1 || !unique[0]) {
    throw new Error(`${label} must contain exactly one non-empty value.`);
  }
  return unique[0];
};

const statusArtifactRunId = (entries, sourceRunId) =>
  oneValue(
    entries.map(({ artifactName }) => {
      const match = new RegExp(`-${sourceRunId}-(\\d+)$`).exec(
        artifactName ?? "",
      );
      return match ? `${sourceRunId}-${match[1]}` : undefined;
    }),
    "Warm seed status artifact run ids",
  );

const observedWarmStages = (stageObservation) => {
  const result = { sourceRunId: stageObservation.sourceRunId };
  for (const stage of [
    "warmSeedMs",
    "v1Ms",
    "v2SyncMs",
    "v2HybridMs",
    "traceMs",
  ]) {
    const durationMs = stageObservation.observed?.[stage]?.durationMs;
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error(
        `Warm stage observation must contain a non-negative ${stage} duration.`,
      );
    }
    result[stage] = durationMs;
  }
  return result;
};

export const validateFullRunWarmCalibrationInputs = ({
  sourceRunId,
  selectedCaseIds,
  expectedShardCount,
  seedPlan,
  seedStatusEntries,
  resultPayloadEntries,
  stageObservation,
  coldCalibration,
}) => {
  if (!sourceRunId) {
    throw new Error("Warm sourceRunId must be a non-empty string.");
  }
  if (seedStatusEntries.length !== expectedShardCount) {
    throw new Error(
      `Expected ${expectedShardCount} warm seed statuses, found ${seedStatusEntries.length}.`,
    );
  }
  const cache = summarizeSeedCacheStatuses(
    seedStatusEntries.map(({ status }) => status),
  );
  if (cache.mode !== "warm") {
    throw new Error(
      `Warm calibration requires an all-exact-hit warm run, got ${cache.mode}.`,
    );
  }
  if (
    seedStatusEntries.some(
      ({ status }) => status.requiresRunnerValidation !== false,
    )
  ) {
    throw new Error(
      "Every exact-hit warm seed status must skip runner validation.",
    );
  }
  const perfLabSha = oneValue(
    seedStatusEntries.map(({ status }) => status.perfLabSha),
    "Warm seed status perfLabSha values",
  );
  const teableEeSha = oneValue(
    seedStatusEntries.map(({ status }) => status.teableEeSha),
    "Warm seed status teableEeSha values",
  );
  const cacheNamespace = oneValue(
    seedStatusEntries.map(({ status }) => status.cacheNamespace),
    "Warm seed status cache namespaces",
  );
  for (const [label, actual, expected] of [
    ["perf-lab SHA", perfLabSha, coldCalibration.sourcePerfLabSha],
    ["teable-ee SHA", teableEeSha, coldCalibration.sourceTeableEeSha],
    ["cache namespace", cacheNamespace, coldCalibration.sourceCacheNamespace],
  ]) {
    if (actual !== expected) {
      throw new Error(
        `Warm ${label} ${actual} does not match cold calibration ${expected}.`,
      );
    }
  }
  const statusIssues = evaluateSeedPlanStatusEvidence({
    seedPlan,
    statusEntries: seedStatusEntries,
    expectedCacheNamespace: coldCalibration.sourceCacheNamespace,
    expectedPerfLabSha: coldCalibration.sourcePerfLabSha,
  });
  if (statusIssues.length > 0) {
    throw new Error(
      `Warm seed plan evidence has ${statusIssues.length} issue(s): ${statusIssues
        .map(({ issue }) => issue)
        .join(", ")}.`,
    );
  }
  const seedArtifactRunId = statusArtifactRunId(seedStatusEntries, sourceRunId);
  const { artifactRunId, resultsByCaseId } = validateFullRunResultPayloads({
    resultPayloadEntries,
    selectedCaseIds,
    sourceRunId,
  });
  if (artifactRunId !== seedArtifactRunId) {
    throw new Error(
      `Warm seed and result attempts differ: ${seedArtifactRunId}, ${artifactRunId}.`,
    );
  }
  if (
    stageObservation.sourceRunId !== sourceRunId ||
    stageObservation.cacheMode !== "warm" ||
    !stageObservation.complete
  ) {
    throw new Error(
      "Warm stage observation must be complete, warm, and belong to the source run.",
    );
  }
  if (stageObservation.selectedShardCount !== expectedShardCount) {
    throw new Error(
      `Warm stage observation has ${stageObservation.selectedShardCount} shards, expected ${expectedShardCount}.`,
    );
  }
  if (
    stageObservation.seedCacheObservation?.statusCount !== expectedShardCount ||
    stageObservation.seedCacheObservation?.detectedMode !== "warm"
  ) {
    throw new Error(
      "Warm stage observation seed-cache evidence does not match the exact-hit shard matrix.",
    );
  }
  return {
    perfLabSha,
    teableEeSha,
    cacheNamespace,
    artifactRunId,
    observedStages: observedWarmStages(stageObservation),
    resultsByCaseId,
  };
};

const renderAcceptedStageCalibration = ({
  calibration,
  sourceRunId,
  sourceUrl,
  artifactRunId,
  observedStages,
}) => {
  const { caseCosts: _caseCosts, ...metadata } = calibration;
  const source = {
    ...metadata,
    pairedWarmRunId: sourceRunId,
    pairedWarmRunUrl: sourceUrl,
    pairedWarmArtifactRunId: artifactRunId,
    pairedWarmObservedStages: observedStages,
    caseCosts: "__CASE_COSTS__",
  };
  return `// Cold provenance is written only by refresh-full-run-calibration.mjs.\n// Warm provenance is added only after exact-hit status, result coverage, plan,\n// namespace, and commit identities match that cold source.\nimport { FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID } from "./full-run-execute-calibration.mjs";\n\nexport const FULL_RUN_STAGE_CALIBRATION = ${JSON.stringify(
    source,
    null,
    2,
  ).replace(
    '"caseCosts": "__CASE_COSTS__"',
    "caseCosts: FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID",
  )};\n`;
};

const writeAtomically = async (path, source) => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, source, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const main = async () => {
  const seedDir = option("--seed-dir");
  const resultsDir = option("--results-dir");
  const stageObservationPath = option("--stage-observation");
  const sourceRunId = option("--source-run-id");
  const outputDir = option("--output-dir");
  const sourceUrl =
    option("--source-url") ??
    (sourceRunId
      ? `https://github.com/teableio/teable-perf-lab/actions/runs/${sourceRunId}`
      : undefined);
  const write = args.includes("--write");
  if (!seedDir || !resultsDir || !stageObservationPath || !sourceRunId) {
    throw new Error(
      "Usage: node scripts/accept-full-run-warm-calibration.mjs --seed-dir <dir> --results-dir <dir> --stage-observation <observation.json> --source-run-id <id> [--source-url <url>] [--write] [--output-dir <temp-dir>]",
    );
  }

  const registeredCases = await loadRegisteredCases();
  const allCaseIds = registeredCases.map(({ id }) => id);
  const selectedCaseIds = resolveFullRunCaseIds({ allCaseIds });
  const seedPlan = FULL_RUN_STAGE_CALIBRATION.sourceSeedPlan;
  if (!Array.isArray(seedPlan) || seedPlan.length === 0) {
    throw new Error(
      "Cold calibration does not contain a validated source seed plan.",
    );
  }
  const [seedStatusEntries, resultPayloadEntries, stageObservation] =
    await Promise.all([
      readSeedCacheStatuses({ artifactDir: seedDir }),
      readArtifactPayloads({
        artifactDir: resultsDir,
        includeSeed: false,
      }),
      readFile(stageObservationPath, "utf8").then(JSON.parse),
    ]);
  const provenance = validateFullRunWarmCalibrationInputs({
    sourceRunId,
    selectedCaseIds,
    expectedShardCount: seedPlan.length,
    seedPlan,
    seedStatusEntries,
    resultPayloadEntries,
    stageObservation,
    coldCalibration: FULL_RUN_STAGE_CALIBRATION,
  });

  if (write) {
    const repoRoot =
      outputDir ?? join(dirname(fileURLToPath(import.meta.url)), "..");
    const path = join(repoRoot, "scripts/full-run-stage-calibration.mjs");
    await writeAtomically(
      path,
      renderAcceptedStageCalibration({
        calibration: FULL_RUN_STAGE_CALIBRATION,
        sourceRunId,
        sourceUrl,
        artifactRunId: provenance.artifactRunId,
        observedStages: provenance.observedStages,
      }),
    );
    console.log(`Accepted exact-hit warm calibration run ${sourceRunId}.`);
  } else {
    console.log(
      JSON.stringify(
        {
          coldSourceRunId: FULL_RUN_STAGE_CALIBRATION.sourceRunId,
          warmSourceRunId: sourceRunId,
          sourceUrl,
          ...provenance,
          resultsByCaseId: undefined,
        },
        null,
        2,
      ),
    );
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.stack || error.message : error,
    );
    process.exitCode = 1;
  });
}
