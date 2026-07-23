#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const flattenArtifactInventory = (inventory) => {
  const pages = Array.isArray(inventory) ? inventory : [inventory];
  return pages.flatMap((page) =>
    Array.isArray(page?.artifacts) ? page.artifacts : [],
  );
};

const latestByLogicalName = (candidates, prefer) => {
  const grouped = new Map();
  for (const candidate of candidates) {
    const entries = grouped.get(candidate.logicalName) ?? [];
    entries.push(candidate);
    grouped.set(candidate.logicalName, entries);
  }
  return [...grouped]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([, entries]) =>
        entries.sort((left, right) => {
          const attempt = right.attempt - left.attempt;
          return attempt || prefer(right) - prefer(left) || right.id - left.id;
        })[0],
    );
};

export const selectLatestReportArtifacts = ({ artifacts, runId }) => {
  if (!Array.isArray(artifacts) || !String(runId).trim()) {
    throw new Error(
      "Artifact selection requires an artifact array and run id.",
    );
  }
  const escapedRunId = String(runId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const executePattern = new RegExp(
    `^teable-ee-e2e-perf-(results-)?(v[A-Za-z0-9_.-]+)-${escapedRunId}-(\\d+)$`,
  );
  const seedPattern = new RegExp(
    `^teable-ee-e2e-perf-seed-([A-Za-z0-9_.-]+)-${escapedRunId}-(\\d+)$`,
  );
  const executeCandidates = [];
  const seedCandidates = [];
  for (const artifact of artifacts) {
    if (artifact?.expired || !Number.isInteger(artifact?.id)) {
      continue;
    }
    const executeMatch = executePattern.exec(artifact.name ?? "");
    if (executeMatch) {
      executeCandidates.push({
        id: artifact.id,
        name: artifact.name,
        logicalName: executeMatch[2],
        lightweight: Boolean(executeMatch[1]),
        attempt: Number(executeMatch[3]),
      });
      continue;
    }
    const seedMatch = seedPattern.exec(artifact.name ?? "");
    if (seedMatch) {
      seedCandidates.push({
        id: artifact.id,
        name: artifact.name,
        logicalName: seedMatch[1],
        attempt: Number(seedMatch[2]),
      });
    }
  }

  const execute = latestByLogicalName(executeCandidates, ({ lightweight }) =>
    lightweight ? 1 : 0,
  );
  const seed = latestByLogicalName(seedCandidates, () => 0);
  const latestSeedIds = new Set(seed.map(({ id }) => id));
  const seedProvenance = seedCandidates
    .filter(({ id }) => !latestSeedIds.has(id))
    .sort(
      (left, right) =>
        left.logicalName.localeCompare(right.logicalName) ||
        right.attempt - left.attempt ||
        right.id - left.id,
    );
  return {
    execute,
    seed,
    seedProvenance,
    executeArtifactIds: execute.map(({ id }) => id),
    seedArtifactIds: seed.map(({ id }) => id),
    seedProvenanceArtifactIds: seedProvenance.map(({ id }) => id),
  };
};

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const main = async () => {
  const inventoryPath = requiredEnv("PERF_LAB_ARTIFACT_INVENTORY");
  const outputPath = requiredEnv("GITHUB_OUTPUT");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const selection = selectLatestReportArtifacts({
    artifacts: flattenArtifactInventory(inventory),
    runId: requiredEnv("GITHUB_RUN_ID"),
  });
  if (selection.executeArtifactIds.length === 0) {
    throw new Error(
      `No perf execute artifacts found for run ${process.env.GITHUB_RUN_ID}.`,
    );
  }
  await appendFile(
    outputPath,
    [
      `execute_artifact_ids=${selection.executeArtifactIds.join(",")}`,
      `seed_artifact_ids=${selection.seedArtifactIds.join(",")}`,
      `seed_provenance_artifact_ids=${selection.seedProvenanceArtifactIds.join(",")}`,
      "",
    ].join("\n"),
  );
  console.log(
    `Selected ${selection.execute.length} execute, ${selection.seed.length} latest seed, and ${selection.seedProvenance.length} prior seed provenance artifacts.`,
  );
  if (selection.seed.length === 0) {
    console.log(
      "::warning::No seed cache status artifacts found; full-run seed verification will fail closed.",
    );
  }
  for (const artifact of [
    ...selection.execute,
    ...selection.seed,
    ...selection.seedProvenance,
  ]) {
    console.log(`${artifact.logicalName}: ${artifact.name}`);
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
