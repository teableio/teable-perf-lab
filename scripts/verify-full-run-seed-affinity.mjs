#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSeedObservationReport,
  fileExists,
  readArtifactPayloads,
  readSeedCacheStatuses,
  seedShardFromArtifactEntry,
  summarizeSeedPayloadCoverage,
} from "./perf-artifact-read-model.mjs";
import { resolveDuplicateSeeds } from "./full-run-feedback-model.mjs";
import {
  resolveFixtureAffinities,
  resolveFullRunCaseIds,
} from "./full-run-shard-model.mjs";
import { loadRegisteredCases } from "./run-plan.mjs";
import { summarizeSeedCacheStatuses } from "./stage-plan-observation-model.mjs";

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const buildAffinityIndex = (affinities) => {
  const result = new Map();
  for (const affinity of affinities) {
    for (const caseId of affinity.caseIds) {
      const previous = result.get(caseId);
      if (previous && previous !== affinity.id) {
        throw new Error(
          `Case ${caseId} belongs to multiple fixture affinities: ${previous}, ${affinity.id}.`,
        );
      }
      result.set(caseId, affinity.id);
    }
  }
  return result;
};

const emptySeedSummary = () => ({
  duplicates: [],
  affinityIssues: [],
  avoidableBuildMs: 0,
});

const statusShard = ({ artifactName, fileName }) =>
  /seed-(shard-\d+-of-\d+)(?:-|\/)/.exec(
    `${artifactName ?? ""}/${fileName ?? ""}`,
  )?.[1];

const artifactAttempt = (artifactName) => {
  const value = /-(\d+)$/.exec(artifactName ?? "")?.[1];
  return value == null ? -1 : Number(value);
};

const seedPlanCaseIds = (plan) => {
  if (typeof plan.caseFilter !== "string" || !plan.caseFilter.trim()) {
    throw new Error(`Seed plan ${plan.name} must declare caseFilter.`);
  }
  return plan.caseFilter
    .split(",")
    .map((caseId) => caseId.trim())
    .filter(Boolean);
};

const sameSeedStatusIdentity = (left, right) =>
  [
    "stableSlot",
    "caseSetDigest",
    "seedContractGeneration",
    "perfLabSha",
    "teableEeSha",
  ].every((field) => left?.[field] === right?.[field]) &&
  (left?.cacheNamespace ?? "") === (right?.cacheNamespace ?? "");

const payloadsForArtifact = ({
  payloadEntries,
  artifactName,
  expectedCaseIds,
}) => {
  const selected = payloadEntries.filter(
    ({ payload, artifactName: payloadArtifactName }) =>
      payloadArtifactName === artifactName && payload?.engine === "seed",
  );
  const coverage = summarizeSeedPayloadCoverage({
    payloadEntries: selected,
    expectedCaseIds,
  });
  return { selected, coverage };
};

export const resolveSeedPayloadProvenance = ({
  seedPlan,
  latestStatusEntries,
  latestPayloadEntries,
  provenanceStatusEntries = [],
  provenancePayloadEntries = [],
}) => {
  if (
    !Array.isArray(seedPlan) ||
    !Array.isArray(latestStatusEntries) ||
    !Array.isArray(latestPayloadEntries) ||
    !Array.isArray(provenanceStatusEntries) ||
    !Array.isArray(provenancePayloadEntries)
  ) {
    throw new Error("Seed payload provenance requires array inputs.");
  }
  const issues = [];
  const payloadEntries = [];
  const provenance = [];
  for (const plan of seedPlan) {
    const expectedCaseIds = seedPlanCaseIds(plan);
    const statusMatches = latestStatusEntries.filter(
      ({ status }) => status?.stableSlot === plan.stableSlot,
    );
    if (statusMatches.length !== 1) {
      issues.push({
        issue: "seed-shard-current-status-invalid",
        shard: plan.name,
        stableSlot: plan.stableSlot,
        observedStatusCount: statusMatches.length,
      });
      continue;
    }
    const latest = statusMatches[0];
    if (latest.status.mode !== "exact-hit") {
      const payloadEvidence = payloadsForArtifact({
        payloadEntries: latestPayloadEntries,
        artifactName: latest.artifactName,
        expectedCaseIds,
      });
      if (!payloadEvidence.coverage.complete) {
        issues.push({
          issue: "seed-shard-current-payload-incomplete",
          shard: plan.name,
          statusArtifact: latest.artifactName,
          coverage: payloadEvidence.coverage,
        });
        continue;
      }
      payloadEntries.push(...payloadEvidence.selected);
      continue;
    }

    const candidates = provenanceStatusEntries
      .filter(
        (candidate) =>
          statusShard(candidate) === plan.name &&
          candidate.status?.mode !== "exact-hit" &&
          candidate.status?.requiresRunnerValidation === true &&
          sameSeedStatusIdentity(candidate.status, latest.status),
      )
      .sort(
        (left, right) =>
          artifactAttempt(right.artifactName) -
          artifactAttempt(left.artifactName),
      );
    let resolved;
    for (const candidate of candidates) {
      const payloadEvidence = payloadsForArtifact({
        payloadEntries: provenancePayloadEntries,
        artifactName: candidate.artifactName,
        expectedCaseIds,
      });
      if (payloadEvidence.coverage.complete) {
        resolved = { candidate, payloadEntries: payloadEvidence.selected };
        break;
      }
    }
    if (!resolved) {
      issues.push({
        issue: "seed-shard-payload-provenance-missing",
        shard: plan.name,
        statusArtifact: latest.artifactName,
        expectedCaseIds,
      });
      continue;
    }
    payloadEntries.push(...resolved.payloadEntries);
    provenance.push({
      shard: plan.name,
      statusArtifact: latest.artifactName,
      payloadArtifact: resolved.candidate.artifactName,
    });
  }
  return {
    complete: issues.length === 0,
    payloadEntries,
    provenance,
    issues,
  };
};

export const evaluateSeedPlanStatusEvidence = ({
  seedPlan,
  statusEntries,
  expectedCacheNamespace = "",
  expectedPerfLabSha,
}) => {
  if (!Array.isArray(seedPlan) || !Array.isArray(statusEntries)) {
    throw new Error("Seed plan status evidence requires arrays.");
  }
  const issues = [];
  const byStableSlot = new Map();
  for (const entry of statusEntries) {
    const stableSlot = entry.status?.stableSlot;
    const entries = byStableSlot.get(stableSlot) ?? [];
    entries.push(entry);
    byStableSlot.set(stableSlot, entries);
  }
  const expectedSlots = new Set(seedPlan.map(({ stableSlot }) => stableSlot));
  for (const plan of seedPlan) {
    const matches = byStableSlot.get(plan.stableSlot) ?? [];
    if (matches.length !== 1) {
      issues.push({
        issue:
          matches.length === 0
            ? "seed-plan-status-missing"
            : "seed-plan-status-duplicated",
        shard: plan.name,
        stableSlot: plan.stableSlot,
        observedStatusCount: matches.length,
      });
      continue;
    }
    const entry = matches[0];
    const shard = statusShard(entry);
    const mismatches = [];
    for (const [field, expected] of [
      ["caseSetDigest", plan.caseSetDigest],
      ["seedContractGeneration", plan.seedContractGeneration],
      ["cacheNamespace", expectedCacheNamespace],
    ]) {
      if (entry.status[field] !== expected) {
        mismatches.push({ field, expected, actual: entry.status[field] });
      }
    }
    if (shard !== plan.name) {
      mismatches.push({ field: "shard", expected: plan.name, actual: shard });
    }
    if (
      entry.status.mode === "exact-hit" &&
      entry.status.matchedKey !== entry.status.primaryKey
    ) {
      mismatches.push({
        field: "exactCacheKey",
        expected: entry.status.primaryKey,
        actual: entry.status.matchedKey,
      });
    }
    if (mismatches.length > 0) {
      issues.push({
        issue: "seed-plan-status-identity-mismatch",
        shard: plan.name,
        stableSlot: plan.stableSlot,
        mismatches,
      });
    }
  }
  for (const [stableSlot, entries] of byStableSlot) {
    if (!expectedSlots.has(stableSlot)) {
      issues.push({
        issue: "seed-plan-status-unexpected",
        stableSlot,
        shards: entries.map(statusShard).filter(Boolean).sort(),
      });
    }
  }
  for (const field of ["perfLabSha", "teableEeSha"]) {
    const values = [
      ...new Set(
        statusEntries.map(({ status }) => status?.[field]).filter(Boolean),
      ),
    ].sort();
    if (
      values.length !== 1 ||
      statusEntries.some(
        ({ status }) =>
          typeof status?.[field] !== "string" || !status[field].trim(),
      )
    ) {
      issues.push({
        issue: "seed-plan-status-source-mismatch",
        field,
        values,
      });
    }
  }
  if (
    expectedPerfLabSha &&
    statusEntries.some(
      ({ status }) => status?.perfLabSha !== expectedPerfLabSha,
    )
  ) {
    issues.push({
      issue: "seed-plan-status-source-mismatch",
      field: "perfLabSha",
      expected: expectedPerfLabSha,
      values: [
        ...new Set(
          statusEntries.map(({ status }) => status?.perfLabSha).filter(Boolean),
        ),
      ].sort(),
    });
  }
  return issues;
};

export const evaluateSeedAffinityGate = ({
  cache,
  coverage,
  observations,
  affinities,
  observationIssues = [],
  evidenceIssues: initialEvidenceIssues = [],
  resolvedMixedProvenance = false,
}) => {
  const seedSummary =
    observations.length > 0
      ? resolveDuplicateSeeds(observations)
      : emptySeedSummary();
  const affinityIssues = [...seedSummary.affinityIssues, ...observationIssues];
  const evidenceIssues = [...initialEvidenceIssues];
  const warm = cache.mode === "warm";

  if (!warm) {
    const exactHitCount = cache.modeCounts?.["exact-hit"] ?? 0;
    if (exactHitCount > 0 && !resolvedMixedProvenance) {
      evidenceIssues.push({
        issue: "mixed-exact-hit-evidence-incomplete",
        exactHitStatusCount: exactHitCount,
        statusCount: cache.statusCount,
      });
    }
    if (!coverage.complete) {
      evidenceIssues.push({
        issue: "seed-payload-coverage-incomplete",
        expectedCaseCount: coverage.expectedCaseCount,
        observedCaseCount: coverage.observedCaseCount,
        missingCaseIds: coverage.missingCaseIds,
        unexpectedCaseIds: coverage.unexpectedCaseIds,
        duplicateCaseIds: coverage.duplicateCaseIds,
      });
    }

    const observedCaseIds = new Set(observations.map(({ caseId }) => caseId));
    for (const affinity of affinities) {
      if (affinity.caseIds.length < 2) {
        continue;
      }
      const missingCaseIds = affinity.caseIds.filter(
        (caseId) => !observedCaseIds.has(caseId),
      );
      if (missingCaseIds.length > 0) {
        const affinityObservations = observations.filter(({ caseId }) =>
          affinity.caseIds.includes(caseId),
        );
        affinityIssues.push({
          issue: "affinity-members-missing-seed-identity",
          seedHash: "missing",
          affinityIds: [affinity.id],
          caseIds: affinity.caseIds,
          missingCaseIds,
          shards: [
            ...new Set(
              affinityObservations.map(({ shard }) => shard).filter(Boolean),
            ),
          ].sort(),
        });
      }
    }
  }

  return {
    ...seedSummary,
    affinityIssues,
    evidenceIssues,
    ...(warm
      ? { skippedReason: "exact-hit seed jobs do not rebuild runner fixtures" }
      : {}),
    passed:
      seedSummary.duplicates.length === 0 &&
      affinityIssues.length === 0 &&
      evidenceIssues.length === 0,
  };
};

const issueTarget = (issue) =>
  issue.seedHash ??
  issue.seedHashes?.join(", ") ??
  issue.caseId ??
  issue.affinityIds?.join(", ") ??
  "seed evidence";

export const renderSeedAffinityMarkdown = (observation) => {
  const lines = [
    "## Physical seed affinity",
    "",
    `Run ${observation.sourceRunId} · cache ${observation.cacheMode} · ${observation.passed ? "PASS" : "FAIL"}.`,
    `Seed payload coverage: ${observation.coverage.observedCaseCount}/${observation.coverage.expectedCaseCount} cases.`,
    `Seed evidence: ${observation.seedObservationCount} observations · ${observation.seedIdentityCount} identities · ${observation.seedCaseCount} cases.`,
    `Cross-shard duplicates: ${observation.duplicates.length} · avoidable ${Math.round(observation.avoidableBuildMs)} ms.`,
    `Static affinity issues: ${observation.affinityIssues.length} · evidence issues: ${observation.evidenceIssues.length}.`,
  ];
  if (observation.skippedReason) {
    lines.push(`Verification skipped: ${observation.skippedReason}.`);
  }
  for (const duplicate of observation.duplicates) {
    lines.push(
      `- ${duplicate.seedHash}: ${duplicate.shards.join(", ")} · affinity ${duplicate.affinityIds.join(", ") || "missing"} · cases ${duplicate.caseIds.join(", ")}`,
    );
  }
  for (const issue of observation.affinityIssues) {
    const affinities =
      issue.declaredAffinity && issue.artifactAffinity
        ? `declared ${issue.declaredAffinity} / artifact ${issue.artifactAffinity}`
        : (issue.artifactAffinities?.join(", ") ??
          issue.affinityIds?.join(", ") ??
          issue.declaredAffinity ??
          issue.artifactAffinity ??
          "missing");
    const cases = issue.caseIds?.join(", ") ?? issue.caseId ?? "unknown";
    const missing = issue.missingCaseIds?.length
      ? ` · missing ${issue.missingCaseIds.join(", ")}`
      : "";
    const issueShards = issue.shards ?? (issue.shard ? [issue.shard] : []);
    const shards = issueShards.length
      ? ` · shards ${issueShards.join(", ")}`
      : "";
    lines.push(
      `- ${issueTarget(issue)}: ${issue.issue} · affinity ${affinities} · cases ${cases}${missing}${shards}`,
    );
    for (const identity of issue.observations ?? []) {
      lines.push(
        `  - ${identity.caseId}: ${identity.seedHashes.join(", ")} @ ${identity.shards.join(", ")}`,
      );
    }
  }
  for (const issue of observation.evidenceIssues) {
    const shard = issue.shard ? ` · shard ${issue.shard}` : "";
    const mismatches = issue.mismatches?.length
      ? ` · ${issue.mismatches
          .map(
            ({ field, expected, actual }) =>
              `${field} expected=${expected} actual=${actual}`,
          )
          .join("; ")}`
      : "";
    lines.push(`- seed evidence: ${issue.issue}${shard}${mismatches}`);
  }
  return `${lines.join("\n")}\n`;
};

const publishObservation = async (observation) => {
  const outputPath = process.env.PERF_LAB_SEED_AFFINITY_OBSERVATION_PATH;
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(observation, null, 2)}\n`);
  }
  const markdown = renderSeedAffinityMarkdown(observation);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n${markdown}`);
  }
  console.log(markdown.trimEnd());
};

const main = async () => {
  const artifactDir = requiredEnv("PERF_LAB_SEED_ARTIFACT_DIR");
  if (!(await fileExists(artifactDir))) {
    throw new Error(`Seed artifact directory does not exist: ${artifactDir}`);
  }
  const planSummary = JSON.parse(requiredEnv("PERF_LAB_PLAN_SUMMARY"));
  const seedPlan = JSON.parse(requiredEnv("PERF_LAB_SEED_PLAN"));
  const expectedShardCount = Number(
    planSummary.stagePlan?.selectedShardCount ?? planSummary.shardCount,
  );
  if (!Number.isInteger(expectedShardCount) || expectedShardCount < 1) {
    throw new Error(
      "Full-run plan summary must declare a positive shard count.",
    );
  }

  const statuses = await readSeedCacheStatuses({ artifactDir });
  const cache = summarizeSeedCacheStatuses(
    statuses.map(({ status }) => status),
  );
  const evidenceIssues = [];
  if (statuses.length !== expectedShardCount) {
    evidenceIssues.push({
      issue: "seed-cache-status-coverage-incomplete",
      expectedStatusCount: expectedShardCount,
      observedStatusCount: statuses.length,
    });
  }
  evidenceIssues.push(
    ...evaluateSeedPlanStatusEvidence({
      seedPlan,
      statusEntries: statuses,
      expectedCacheNamespace: planSummary.seedCacheNamespace ?? "",
      expectedPerfLabSha: process.env.GITHUB_SHA,
    }),
  );

  const registeredCases = await loadRegisteredCases();
  const selectedCaseIds = resolveFullRunCaseIds({
    allCaseIds: registeredCases.map(({ id }) => id),
  });
  const selectedCaseIdSet = new Set(selectedCaseIds);
  const affinities = resolveFixtureAffinities({
    seedAffinityDeclarations: registeredCases
      .filter(({ seedAffinity }) => seedAffinity != null)
      .map(({ id, seedAffinity }) => ({
        caseId: id,
        affinityId: seedAffinity,
      })),
  })
    .map((affinity) => ({
      ...affinity,
      caseIds: affinity.caseIds.filter((caseId) =>
        selectedCaseIdSet.has(caseId),
      ),
    }))
    .filter(({ caseIds }) => caseIds.length > 0);
  const latestPayloadEntries = await readArtifactPayloads({
    artifactDir,
    allowEmpty: true,
  });
  const provenanceArtifactDir =
    process.env.PERF_LAB_SEED_PROVENANCE_ARTIFACT_DIR;
  const hasProvenanceArtifacts =
    provenanceArtifactDir && (await fileExists(provenanceArtifactDir));
  const [provenanceStatusEntries, provenancePayloadEntries] =
    hasProvenanceArtifacts
      ? await Promise.all([
          readSeedCacheStatuses({ artifactDir: provenanceArtifactDir }),
          readArtifactPayloads({
            artifactDir: provenanceArtifactDir,
            allowEmpty: true,
          }),
        ])
      : [[], []];
  const payloadProvenance =
    cache.mode === "warm"
      ? {
          complete: true,
          payloadEntries: latestPayloadEntries,
          provenance: [],
          issues: [],
        }
      : resolveSeedPayloadProvenance({
          seedPlan,
          latestStatusEntries: statuses,
          latestPayloadEntries,
          provenanceStatusEntries,
          provenancePayloadEntries,
        });
  evidenceIssues.push(...payloadProvenance.issues);
  const report = buildSeedObservationReport({
    payloadEntries: payloadProvenance.payloadEntries,
    affinityByCaseId: buildAffinityIndex(affinities),
  });
  const coverage = summarizeSeedPayloadCoverage({
    payloadEntries: report.payloadEntries,
    expectedCaseIds: selectedCaseIds,
  });
  const gate = evaluateSeedAffinityGate({
    cache,
    coverage,
    observations: report.observations,
    affinities,
    observationIssues: report.issues,
    evidenceIssues,
    resolvedMixedProvenance:
      cache.mode === "mixed" && payloadProvenance.complete,
  });
  const observation = {
    sourceRunId: process.env.GITHUB_RUN_ID ?? "local",
    cacheMode: cache.mode,
    seedCacheStatusCount: statuses.length,
    seedCacheModeCounts: cache.modeCounts,
    seedPayloadProvenance: {
      complete: payloadProvenance.complete,
      sources: payloadProvenance.provenance,
    },
    coverage,
    seedObservationCount: report.observations.length,
    seedIdentityCount: new Set(
      report.observations.map(({ seedHash }) => seedHash),
    ).size,
    seedCaseCount: new Set(report.observations.map(({ caseId }) => caseId))
      .size,
    ...gate,
  };
  await publishObservation(observation);
  if (!observation.passed) {
    process.exitCode = 1;
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const observation = {
      sourceRunId: process.env.GITHUB_RUN_ID ?? "local",
      cacheMode: "unknown",
      seedCacheStatusCount: 0,
      seedCacheModeCounts: {},
      coverage: {
        expectedCaseCount: 0,
        observedCaseCount: 0,
        missingCaseIds: [],
        unexpectedCaseIds: [],
        duplicateCaseIds: [],
        complete: false,
      },
      seedObservationCount: 0,
      seedIdentityCount: 0,
      seedCaseCount: 0,
      duplicates: [],
      affinityIssues: [],
      evidenceIssues: [{ issue: "seed-affinity-verifier-error", message }],
      avoidableBuildMs: 0,
      passed: false,
    };
    try {
      await publishObservation(observation);
    } catch (publishError) {
      console.error(
        publishError instanceof Error
          ? publishError.stack || publishError.message
          : publishError,
      );
    }
    console.error(
      error instanceof Error ? error.stack || error.message : error,
    );
    process.exitCode = 1;
  });
}
