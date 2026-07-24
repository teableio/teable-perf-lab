import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCaseCatalog } from "./case-catalog.mjs";
import {
  buildRunnerInventorySection,
  RUNNER_INVENTORY_END,
  RUNNER_INVENTORY_START,
} from "./runner-inventory-projection.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const readmePath = join(repoRoot, "README.md");
const runnerTrackerPath = join(
  repoRoot,
  "tasks",
  "runner-migration-tracker.md",
);

const SECTION_HEADING = "## Available Cases";
const GENERATED_NOTE =
  "<!-- Generated from registry.ts and each case's `## Goal` section. -->\n" +
  "<!-- Do not edit by hand; run `pnpm sync:readme` to regenerate. -->";
const MAX_LINE_WIDTH = 80;

const readText = (path) => readFile(path, "utf8");

// Split into wrap-safe tokens, keeping inline code spans atomic even when they
// contain spaces (e.g. `PUT /table/{tableId}/field/{fieldId}/convert`).
const tokenize = (text) => text.match(/`[^`]*`[^\s]*|\S+/g) ?? [];

const wrapBullet = (text) => {
  const lines = [];
  let line = "-";
  for (const token of tokenize(text)) {
    const candidate = `${line} ${token}`;
    if (candidate.length > MAX_LINE_WIDTH && line !== "-" && line !== " ") {
      lines.push(line);
      line = ` ${token}`;
    } else {
      line = candidate;
    }
  }
  lines.push(line);
  return lines.join("\n ");
};

const buildSection = (caseCatalog) => {
  const bullets = caseCatalog.map(({ id, goalSummary }) =>
    wrapBullet(`\`${id}\`: ${goalSummary}`),
  );
  return `${SECTION_HEADING}\n\n${GENERATED_NOTE}\n\n${bullets.join("\n")}\n`;
};

const replaceGeneratedBlock = (document, startMarker, endMarker, section) => {
  const startIndex = document.indexOf(startMarker);
  const endIndex = document.indexOf(endMarker, startIndex);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Missing generated block markers: ${startMarker}`);
  }
  return (
    document.slice(0, startIndex) +
    section +
    document.slice(endIndex + endMarker.length)
  );
};

const replaceSection = (readme, section) => {
  const startIndex = readme.indexOf(`${SECTION_HEADING}\n`);
  if (startIndex === -1) {
    throw new Error(`README.md is missing the "${SECTION_HEADING}" heading`);
  }
  const nextHeadingIndex = readme.indexOf(
    "\n## ",
    startIndex + SECTION_HEADING.length,
  );
  if (nextHeadingIndex === -1) {
    return readme.slice(0, startIndex) + section;
  }
  return readme.slice(0, startIndex) + section + readme.slice(nextHeadingIndex);
};

const main = async () => {
  const checkOnly = process.argv.includes("--check");
  const caseCatalog = await loadCaseCatalog(repoRoot);
  const casePaths = caseCatalog.map(({ casePath }) => casePath);
  const [readme, runnerTracker] = await Promise.all([
    readText(readmePath),
    readText(runnerTrackerPath),
  ]);
  const updated = replaceSection(readme, buildSection(caseCatalog));
  const updatedRunnerTracker = replaceGeneratedBlock(
    runnerTracker,
    RUNNER_INVENTORY_START,
    RUNNER_INVENTORY_END,
    await buildRunnerInventorySection(repoRoot, casePaths),
  );

  if (updated === readme && updatedRunnerTracker === runnerTracker) {
    console.log("README and runner inventory projections are up to date.");
    return;
  }

  if (checkOnly) {
    throw new Error(
      "Generated README or runner inventory content is out of date. Run `pnpm sync:readme` and commit the result.",
    );
  }

  await Promise.all([
    writeFile(readmePath, updated),
    writeFile(runnerTrackerPath, updatedRunnerTracker),
  ]);
  console.log("README and runner inventory projections regenerated.");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
