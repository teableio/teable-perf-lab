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

const assertNonEmptyString = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const oneValue = (values, label) => {
  const unique = [...new Set(values)];
  if (unique.length !== 1 || !unique[0]) {
    throw new Error(`${label} must contain exactly one non-empty value.`);
  }
  return unique[0];
};

export const assertArtifactRun = (entries, sourceRunId, label) => {
  const runId = oneValue(
    entries.map(({ payload }) => payload.runId),
    `${label} payload run ids`,
  );
  if (!new RegExp(`^${escapeRegExp(sourceRunId)}-\\d+$`).test(runId)) {
    throw new Error(
      `${label} payload run id ${runId} does not belong to source run ${sourceRunId}.`,
    );
  }
  for (const entry of entries) {
    if (
      !entry.artifactName ||
      !new RegExp(`-${escapeRegExp(sourceRunId)}-\\d+$`).test(
        entry.artifactName,
      )
    ) {
      throw new Error(
        `${label} artifact ${entry.artifactName ?? entry.fileName} does not belong to source run ${sourceRunId}.`,
      );
    }
  }
  return runId;
};

export const validateFullRunResultPayloads = ({
  resultPayloadEntries,
  selectedCaseIds,
  sourceRunId,
}) => {
  const selected = new Set(selectedCaseIds);
  const unexpectedResults = resultPayloadEntries.filter(
    ({ payload }) => !selected.has(payload.caseId),
  );
  if (unexpectedResults.length > 0) {
    throw new Error(
      `Calibration results include unexpected cases: ${[
        ...new Set(unexpectedResults.map(({ payload }) => payload.caseId)),
      ].join(", ")}.`,
    );
  }
  const resultsByCaseId = new Map();
  for (const entry of resultPayloadEntries) {
    const { payload } = entry;
    if (!["v1", "v2"].includes(payload.engine)) {
      throw new Error(
        `Calibration result ${payload.caseId} has unsupported engine ${payload.engine}.`,
      );
    }
    if (!["pass", "skipped"].includes(payload.result)) {
      throw new Error(
        `Calibration result ${payload.caseId}/${payload.engine} is ${payload.result}.`,
      );
    }
    const byEngine = resultsByCaseId.get(payload.caseId) ?? new Map();
    if (byEngine.has(payload.engine)) {
      throw new Error(
        `Duplicate ${payload.engine} result for ${payload.caseId}.`,
      );
    }
    byEngine.set(payload.engine, payload);
    resultsByCaseId.set(payload.caseId, byEngine);
  }
  const missingResults = selectedCaseIds.filter(
    (caseId) =>
      !resultsByCaseId.get(caseId)?.has("v1") ||
      !resultsByCaseId.get(caseId)?.has("v2"),
  );
  if (missingResults.length > 0) {
    throw new Error(
      `Calibration results are incomplete for ${missingResults.length} cases: ${missingResults.join(", ")}.`,
    );
  }
  return {
    resultsByCaseId,
    artifactRunId: assertArtifactRun(
      resultPayloadEntries,
      sourceRunId,
      "Result",
    ),
  };
};

const assertFiniteStages = (stageObservation) => {
  const result = { sourceRunId: stageObservation.sourceRunId };
  for (const stage of [
    "coldSeedMs",
    "v1Ms",
    "v2SyncMs",
    "v2HybridMs",
    "traceMs",
  ]) {
    const durationMs = stageObservation.observed?.[stage]?.durationMs;
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error(
        `Stage observation must contain a non-negative ${stage} duration.`,
      );
    }
    result[stage] = durationMs;
  }
  return result;
};

export const validateFullRunCalibrationInputs = ({
  sourceRunId,
  selectedCaseIds,
  expectedShardCount,
  seedStatusEntries,
  seedPayloadEntries,
  resultPayloadEntries,
  stageObservation,
  seedGate,
  allowCrossShardSeedDuplication = false,
}) => {
  assertNonEmptyString(sourceRunId, "sourceRunId");
  if (seedStatusEntries.length !== expectedShardCount) {
    throw new Error(
      `Expected ${expectedShardCount} seed cache statuses, found ${seedStatusEntries.length}.`,
    );
  }
  const cache = summarizeSeedCacheStatuses(
    seedStatusEntries.map(({ status }) => status),
  );
  if (cache.mode !== "cold") {
    throw new Error(
      `Calibration requires an all-cache-miss cold run, got ${cache.mode}.`,
    );
  }
  if (
    seedStatusEntries.some(
      ({ status }) => status.requiresRunnerValidation !== true,
    )
  ) {
    throw new Error("Every cold seed status must require runner validation.");
  }
  const statusArtifactPattern = new RegExp(
    `-${escapeRegExp(sourceRunId)}-\\d+$`,
  );
  for (const entry of seedStatusEntries) {
    if (
      !entry.artifactName ||
      !statusArtifactPattern.test(entry.artifactName)
    ) {
      throw new Error(
        `Seed status artifact ${entry.artifactName ?? entry.fileName} does not belong to source run ${sourceRunId}.`,
      );
    }
  }
  const perfLabSha = oneValue(
    seedStatusEntries.map(({ status }) => status.perfLabSha),
    "seed status perfLabSha values",
  );
  const teableEeSha = oneValue(
    seedStatusEntries.map(({ status }) => status.teableEeSha),
    "seed status teableEeSha values",
  );
  const cacheNamespaces = [
    ...new Set(
      seedStatusEntries.map(({ status }) => status.cacheNamespace ?? ""),
    ),
  ];
  if (cacheNamespaces.length !== 1) {
    throw new Error("Seed statuses must use one cache namespace.");
  }
  if (
    new Set(seedStatusEntries.map(({ status }) => status.stableSlot)).size !==
    expectedShardCount
  ) {
    throw new Error("Cold seed statuses must cover unique stable slots.");
  }

  const coverage = summarizeSeedPayloadCoverage({
    payloadEntries: seedPayloadEntries,
    expectedCaseIds: selectedCaseIds,
  });
  if (!coverage.complete) {
    throw new Error(
      `Calibration seed payload coverage is incomplete: ${coverage.observedCaseCount}/${coverage.expectedCaseCount}.`,
    );
  }
  if (
    seedPayloadEntries.some(
      ({ payload }) =>
        payload.engine === "seed" &&
        !["pass", "skipped"].includes(payload.result),
    )
  ) {
    throw new Error(
      "Calibration seed payloads must pass or be expected skips.",
    );
  }
  const seedArtifactRunId = assertArtifactRun(
    seedPayloadEntries.filter(({ payload }) => payload.engine === "seed"),
    sourceRunId,
    "Seed",
  );

  const { resultsByCaseId, artifactRunId: resultArtifactRunId } =
    validateFullRunResultPayloads({
      resultPayloadEntries,
      selectedCaseIds,
      sourceRunId,
    });
  if (seedArtifactRunId !== resultArtifactRunId) {
    throw new Error(
      `Seed and result payload attempts differ: ${seedArtifactRunId}, ${resultArtifactRunId}.`,
    );
  }

  if (seedGate.evidenceIssues.length > 0) {
    throw new Error(
      `Seed evidence gate has ${seedGate.evidenceIssues.length} issue(s).`,
    );
  }
  if (seedGate.affinityIssues.length > 0) {
    throw new Error(
      `Seed affinity gate has ${seedGate.affinityIssues.length} issue(s).`,
    );
  }
  if (seedGate.duplicates.length > 0 && !allowCrossShardSeedDuplication) {
    throw new Error(
      `Seed affinity gate found ${seedGate.duplicates.length} cross-shard duplicate(s).`,
    );
  }

  if (stageObservation.sourceRunId !== sourceRunId) {
    throw new Error(
      `Stage observation belongs to run ${stageObservation.sourceRunId}, expected ${sourceRunId}.`,
    );
  }
  if (stageObservation.cacheMode !== "cold" || !stageObservation.complete) {
    throw new Error(
      "Stage observation must be complete and classified as cold.",
    );
  }
  if (stageObservation.selectedShardCount !== expectedShardCount) {
    throw new Error(
      `Stage observation has ${stageObservation.selectedShardCount} shards, expected ${expectedShardCount}.`,
    );
  }
  if (
    stageObservation.seedCacheObservation?.statusCount !== expectedShardCount ||
    stageObservation.seedCacheObservation?.detectedMode !== "cold"
  ) {
    throw new Error(
      "Stage observation seed-cache evidence does not match the cold shard matrix.",
    );
  }

  return {
    perfLabSha,
    teableEeSha,
    cacheNamespace: cacheNamespaces[0],
    artifactRunId: seedArtifactRunId,
    observedStages: assertFiniteStages(stageObservation),
    resultsByCaseId,
    cache,
    coverage,
  };
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
