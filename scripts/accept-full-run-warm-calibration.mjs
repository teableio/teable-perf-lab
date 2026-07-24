#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readArtifactPayloads,
  readSeedCacheStatuses,
} from "./perf-artifact-read-model.mjs";
import { validateFullRunWarmCalibrationInputs } from "./full-run-calibration-lifecycle.mjs";
import { FULL_RUN_STAGE_CALIBRATION } from "./full-run-stage-calibration.mjs";
import { resolveFullRunCaseIds } from "./full-run-shard-model.mjs";
import { loadRegisteredCases } from "./run-plan.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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
