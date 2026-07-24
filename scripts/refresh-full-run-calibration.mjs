#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readArtifactPayloads,
  readSeedCacheStatuses,
  readSeedObservationReport,
  summarizeSeedPayloadCoverage,
} from "./perf-artifact-read-model.mjs";
import { validateFullRunCalibrationInputs } from "./full-run-calibration-lifecycle.mjs";
import { FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID as existingCalibration } from "./full-run-execute-calibration.mjs";
import {
  resolveFixtureAffinities,
  resolveFullRunCaseIds,
} from "./full-run-shard-model.mjs";
import { FULL_RUN_STAGE_CALIBRATION as existingStageCalibration } from "./full-run-stage-calibration.mjs";
import { loadRegisteredCases, resolveRunPlan } from "./run-plan.mjs";
import { summarizeSeedCacheStatuses } from "./stage-plan-observation-model.mjs";
import {
  evaluateSeedAffinityGate,
  evaluateSeedPlanStatusEvidence,
} from "./verify-full-run-seed-affinity.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const renderCalibration = (calibration) => {
  const entries = Object.entries(calibration).map(
    ([caseId, costs]) =>
      `  ${JSON.stringify(caseId)}: {\n` +
      `    coldSeedMs: ${costs.coldSeedMs},\n` +
      `    v1Ms: ${costs.v1Ms},\n` +
      `    v2Ms: ${costs.v2Ms},\n` +
      `    traceMs: ${costs.traceMs},\n` +
      "  },",
  );
  return `{\n${entries.join("\n")}\n}`;
};

const renderStageCalibration = ({
  sourceRunId,
  sourceUrl,
  perfLabSha,
  teableEeSha,
  cacheNamespace,
  artifactRunId,
  sourceSeedPlan,
  observedStages,
}) =>
  `// Calibration provenance is validated from one complete all-cache-miss run.\n// Seed statuses, seed/result payloads, stage observation, commit SHAs, and\n// physical seed affinity must agree before this file can be rewritten.\nimport { FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID } from "./full-run-execute-calibration.mjs";\n\nexport const FULL_RUN_STAGE_CALIBRATION = ${JSON.stringify(
    {
      sourceRunId,
      sourceUrl,
      sourcePerfLabSha: perfLabSha,
      sourceTeableEeSha: teableEeSha,
      sourceCacheNamespace: cacheNamespace,
      sourceArtifactRunId: artifactRunId,
      sourceSeedPlan,
      pairedWarmRunId: null,
      pairedWarmRunUrl: null,
      cacheMode: "cold",
      observedStages,
      fixedCosts: existingStageCalibration.fixedCosts,
      caseCosts: "__CASE_COSTS__",
    },
    null,
    2,
  ).replace(
    '"caseCosts": "__CASE_COSTS__"',
    "caseCosts: FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID",
  )};\n`;

const writeGeneratedFiles = async (files) => {
  const temporary = files.map(({ path, source }, index) => ({
    path,
    source,
    temporaryPath: `${path}.tmp-${process.pid}-${index}`,
  }));
  try {
    await Promise.all(
      temporary.map(({ path }) => mkdir(dirname(path), { recursive: true })),
    );
    await Promise.all(
      temporary.map(({ temporaryPath, source }) =>
        writeFile(temporaryPath, source, "utf8"),
      ),
    );
    for (const file of temporary) {
      await rename(file.temporaryPath, file.path);
    }
  } finally {
    await Promise.all(
      temporary.map(({ temporaryPath }) =>
        rm(temporaryPath, { force: true }).catch(() => undefined),
      ),
    );
  }
};

const main = async () => {
  const seedDir = option("--seed-dir");
  const resultsDir = option("--results-dir");
  const stageObservationPath = option("--stage-observation");
  const sourceRunId = option("--source-run-id");
  const outputDir = option("--output-dir");
  const allowCrossShardSeedDuplication = args.includes(
    "--allow-cross-shard-seed-duplication",
  );
  const sourceUrl =
    option("--source-url") ??
    (sourceRunId
      ? `https://github.com/teableio/teable-perf-lab/actions/runs/${sourceRunId}`
      : undefined);
  const write = args.includes("--write");
  if (!seedDir || !resultsDir || !stageObservationPath || !sourceRunId) {
    throw new Error(
      "Usage: node scripts/refresh-full-run-calibration.mjs --seed-dir <dir> --results-dir <dir> --stage-observation <observation.json> --source-run-id <id> [--source-url <url>] [--write] [--output-dir <temp-dir>]",
    );
  }
  if (allowCrossShardSeedDuplication && write && !outputDir) {
    throw new Error(
      "Cross-shard duplication may only be bypassed for temporary output inspection.",
    );
  }

  const registeredCases = await loadRegisteredCases();
  const selectedCaseIds = resolveFullRunCaseIds({
    allCaseIds: registeredCases.map(({ id }) => id),
  });
  const seedAffinityDeclarations = registeredCases
    .filter(({ seedAffinity }) => seedAffinity != null)
    .map(({ id, seedAffinity }) => ({ caseId: id, affinityId: seedAffinity }));
  const plan = resolveRunPlan({
    engineFilter: "v1,v2",
    caseFilter: "all",
    allCaseIds: registeredCases.map(({ id }) => id),
    seedAffinityDeclarations,
  });
  const affinities = resolveFixtureAffinities({ seedAffinityDeclarations });
  const affinityByCaseId = new Map(
    affinities.flatMap(({ id, caseIds }) =>
      caseIds.map((caseId) => [caseId, id]),
    ),
  );
  const [seedStatusEntries, seedPayloadEntries, resultPayloadEntries] =
    await Promise.all([
      readSeedCacheStatuses({ artifactDir: seedDir }),
      readArtifactPayloads({ artifactDir: seedDir }),
      readArtifactPayloads({ artifactDir: resultsDir, includeSeed: false }),
    ]);
  const stageObservation = JSON.parse(
    await readFile(stageObservationPath, "utf8"),
  );
  const observationReport = await readSeedObservationReport({
    artifactDir: seedDir,
    affinityByCaseId,
  });
  const coverage = summarizeSeedPayloadCoverage({
    payloadEntries: seedPayloadEntries,
    expectedCaseIds: selectedCaseIds,
  });
  const cache = summarizeSeedCacheStatuses(
    seedStatusEntries.map(({ status }) => status),
  );
  const selectedSet = new Set(selectedCaseIds);
  const seedGate = evaluateSeedAffinityGate({
    cache,
    coverage,
    observations: observationReport.observations,
    affinities: affinities
      .map((affinity) => ({
        ...affinity,
        caseIds: affinity.caseIds.filter((caseId) => selectedSet.has(caseId)),
      }))
      .filter(({ caseIds }) => caseIds.length > 0),
    observationIssues: observationReport.issues,
    evidenceIssues: evaluateSeedPlanStatusEvidence({
      seedPlan: plan.seedPlan,
      statusEntries: seedStatusEntries,
      expectedCacheNamespace: seedStatusEntries[0]?.status.cacheNamespace ?? "",
    }),
  });
  const provenance = validateFullRunCalibrationInputs({
    sourceRunId,
    selectedCaseIds,
    expectedShardCount: plan.seedPlan.length,
    seedStatusEntries,
    seedPayloadEntries,
    resultPayloadEntries,
    stageObservation,
    seedGate,
    allowCrossShardSeedDuplication,
  });

  const seedByCaseId = new Map(
    seedPayloadEntries
      .map(({ payload }) => payload)
      .filter(({ engine }) => engine === "seed")
      .map((payload) => [payload.caseId, payload]),
  );
  const maximum = (...values) =>
    Math.max(...values.map((value) => Number(value) || 0));
  const merged = Object.fromEntries(
    [...selectedCaseIds].sort().map((caseId) => {
      const previous = existingCalibration[caseId] ?? {};
      const seed = seedByCaseId.get(caseId);
      const v1 = provenance.resultsByCaseId.get(caseId).get("v1");
      const v2 = provenance.resultsByCaseId.get(caseId).get("v2");
      return [
        caseId,
        {
          coldSeedMs: maximum(previous.coldSeedMs, seed.durationMs),
          v1Ms: maximum(previous.v1Ms, v1.durationMs),
          v2Ms: maximum(previous.v2Ms, v2.durationMs),
          traceMs: maximum(
            previous.traceMs,
            v1.details?.observability?.traces?.traceFetchWaitMs,
            v2.details?.observability?.traces?.traceFetchWaitMs,
          ),
        },
      ];
    }),
  );
  const executeSource = `// Complete case-stage calibration through validated cold run ${sourceRunId}.\n// Provenance: perf-lab ${provenance.perfLabSha}; teable-ee ${provenance.teableEeSha};\n// payload attempt ${provenance.artifactRunId}. Each field keeps the largest trusted\n// observation so a faster/noisier rerun cannot lower known straggler protection.\nexport const FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID = ${renderCalibration(merged)};\n`;
  const stageSource = renderStageCalibration({
    sourceRunId,
    sourceUrl,
    sourceSeedPlan: plan.seedPlan.map(
      ({
        name,
        stableSlot,
        caseSetDigest,
        seedContractGeneration,
        caseFilter,
      }) => ({
        name,
        stableSlot,
        caseSetDigest,
        seedContractGeneration,
        caseFilter,
      }),
    ),
    ...provenance,
  });

  if (write) {
    const repoRoot =
      outputDir ?? join(dirname(fileURLToPath(import.meta.url)), "..");
    const executePath = join(
      repoRoot,
      "scripts/full-run-execute-calibration.mjs",
    );
    const stagePath = join(repoRoot, "scripts/full-run-stage-calibration.mjs");
    await writeGeneratedFiles([
      { path: executePath, source: executeSource },
      { path: stagePath, source: stageSource },
    ]);
    console.log(
      `Updated ${selectedCaseIds.length} case costs and stage provenance from cold run ${sourceRunId}.`,
    );
  } else {
    console.log(
      JSON.stringify(
        {
          sourceRunId,
          sourceUrl,
          caseCount: selectedCaseIds.length,
          shardCount: plan.seedPlan.length,
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
