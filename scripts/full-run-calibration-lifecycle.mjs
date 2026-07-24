import { summarizeSeedPayloadCoverage } from "./perf-artifact-read-model.mjs";
import {
  buildCaseSetDigest,
  SEED_CONTRACT_GENERATION,
} from "./seed-cache-model.mjs";
import { summarizeSeedCacheStatuses } from "./stage-plan-observation-model.mjs";
import { evaluateSeedPlanStatusEvidence } from "./verify-full-run-seed-affinity.mjs";

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

const observedStages = (stageObservation, cacheMode) => {
  const result = { sourceRunId: stageObservation.sourceRunId };
  for (const stage of [
    cacheMode === "cold" ? "coldSeedMs" : "warmSeedMs",
    "v1Ms",
    "v2SyncMs",
    "v2HybridMs",
    "traceMs",
  ]) {
    const durationMs = stageObservation.observed?.[stage]?.durationMs;
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error(
        `${cacheMode === "warm" ? "Warm s" : "S"}tage observation must contain a non-negative ${stage} duration.`,
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
    observedStages: observedStages(stageObservation, "cold"),
    resultsByCaseId,
    cache,
    coverage,
  };
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
    observedStages: observedStages(stageObservation, "warm"),
    resultsByCaseId,
  };
};

export const validateHistoricalSlotRefreshInputs = ({
  sourceRunId,
  calibration,
  selectedCaseIds,
}) => {
  if (sourceRunId !== calibration.sourceRunId) {
    throw new Error(
      `Stable slots may only be refreshed from the validated calibration source ${calibration.sourceRunId}; got ${sourceRunId}.`,
    );
  }
  const seedPlan = calibration.sourceSeedPlan;
  if (!Array.isArray(seedPlan) || seedPlan.length === 0) {
    throw new Error(
      "Stable slots require a non-empty validated calibration source seed plan.",
    );
  }
  const observedCaseIds = [];
  const stableSlots = new Set();
  for (const [index, shard] of seedPlan.entries()) {
    const caseIds =
      typeof shard.caseFilter === "string"
        ? shard.caseFilter.split(",").filter(Boolean)
        : [];
    if (
      !shard.name ||
      !shard.stableSlot ||
      caseIds.length === 0 ||
      shard.seedContractGeneration !== SEED_CONTRACT_GENERATION ||
      shard.caseSetDigest !== buildCaseSetDigest(caseIds)
    ) {
      throw new Error(
        `Calibration source seed plan shard ${index + 1} has invalid plan identity.`,
      );
    }
    if (stableSlots.has(shard.stableSlot)) {
      throw new Error(
        `Calibration source seed plan repeats stable slot ${shard.stableSlot}.`,
      );
    }
    stableSlots.add(shard.stableSlot);
    observedCaseIds.push(...caseIds);
  }
  if (
    observedCaseIds.length !== new Set(observedCaseIds).size ||
    observedCaseIds.slice().sort().join("\n") !==
      selectedCaseIds.slice().sort().join("\n")
  ) {
    throw new Error(
      "Calibration source seed plan does not exactly cover the current full-run case set.",
    );
  }
  return seedPlan;
};
