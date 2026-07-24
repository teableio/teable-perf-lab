#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateHistoricalSlotRefreshInputs } from "./full-run-calibration-lifecycle.mjs";
import {
  resolveFixtureAffinities,
  resolveFullRunCaseIds,
} from "./full-run-shard-model.mjs";
import { FULL_RUN_STAGE_CALIBRATION } from "./full-run-stage-calibration.mjs";
import { loadRegisteredCases } from "./run-plan.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const sourceRunId = option("--source-run-id");
const write = args.includes("--write");

const renderSlots = (slots) =>
  `{\n${Object.entries(slots)
    .map(([bundleId, slot]) => `  ${JSON.stringify(bundleId)}: ${slot},`)
    .join("\n")}\n}`;

const main = async () => {
  if (!sourceRunId) {
    throw new Error(
      "Usage: node scripts/refresh-full-run-historical-slots.mjs --source-run-id <id> [--write]",
    );
  }
  const registeredCases = await loadRegisteredCases();
  const selectedCaseIds = resolveFullRunCaseIds({
    allCaseIds: registeredCases.map(({ id }) => id),
  });
  const seedAffinityDeclarations = registeredCases
    .filter(({ seedAffinity }) => seedAffinity != null)
    .map(({ id, seedAffinity }) => ({
      caseId: id,
      affinityId: seedAffinity,
    }));
  const seedPlan = validateHistoricalSlotRefreshInputs({
    sourceRunId,
    calibration: FULL_RUN_STAGE_CALIBRATION,
    selectedCaseIds,
  });
  const affinities = resolveFixtureAffinities({ seedAffinityDeclarations });
  const bundleByCaseId = new Map(
    affinities.flatMap(({ id, caseIds }) =>
      caseIds.map((caseId) => [caseId, id]),
    ),
  );
  const slots = new Map();
  seedPlan.forEach(({ caseFilter, stableSlot }) => {
    const slot = Number(/^slot-(\d+)$/.exec(stableSlot)?.[1]);
    if (!Number.isInteger(slot) || slot <= 0) {
      throw new Error(`Unsupported stable slot ${stableSlot}.`);
    }
    for (const caseId of caseFilter.split(",")) {
      const bundleId = bundleByCaseId.get(caseId) ?? `case:${caseId}`;
      const previous = slots.get(bundleId);
      if (previous != null && previous !== slot) {
        throw new Error(
          `Bundle ${bundleId} spans stable slots ${previous} and ${slot}.`,
        );
      }
      slots.set(bundleId, slot);
    }
  });
  const sortedSlots = Object.fromEntries(
    [...slots].sort(([left], [right]) => left.localeCompare(right)),
  );
  const source = `// Stable bundle assignment for the eight-shard plan calibrated through Actions\n// cold run ${sourceRunId}. It covers shared affinities and singleton bundles so\n// unrelated edits preserve seed-cache slots.\nexport const FULL_RUN_HISTORICAL_BUNDLE_SLOTS = ${renderSlots(sortedSlots)};\n`;
  if (write) {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const outputPath = join(
      repoRoot,
      "scripts/full-run-historical-bundle-slots.mjs",
    );
    await writeFile(outputPath, source, "utf8");
    console.log(
      `Updated ${outputPath} with ${slots.size} bundles from run ${sourceRunId}.`,
    );
  } else {
    process.stdout.write(source);
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
