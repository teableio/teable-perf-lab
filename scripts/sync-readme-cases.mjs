import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, registeredCasePathsInOrder } from "./case-catalog.mjs";
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

const matchString = (source, pattern, label) => {
  const match = source.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Could not parse ${label}`);
  }
  return match[1];
};

// Resolve the case files in registry array order so the README list keeps the
// curated grouping instead of an alphabetical sort. Reads through the shared
// catalog so this and sync-perf-cases parse registry.ts the same way.
const findRegisteredCasePaths = async () => {
  const casePaths = registeredCasePathsInOrder(await loadRegistry(repoRoot));
  if (casePaths.length === 0) {
    throw new Error("No registered perf cases found in registry.ts");
  }
  return casePaths;
};

const parseCaseId = async (casePath) =>
  matchString(
    await readText(join(repoRoot, casePath)),
    /id:\s*["']([^"']+)["']/,
    `${casePath} id`,
  );

// First paragraph under `## Goal`, collapsed to a single line.
const parseGoalSummary = async (casePath) => {
  const markdownPath = join(
    repoRoot,
    dirname(casePath),
    `${basename(casePath, ".case.ts")}.md`,
  );
  const markdown = await readText(markdownPath);
  const goalMatch = markdown.match(
    /(?:^|\n)## Goal\s*\n([\s\S]*?)(?=\n## |\s*$)/,
  );
  if (!goalMatch) {
    throw new Error(`Missing "## Goal" section: ${markdownPath}`);
  }
  const firstParagraph = goalMatch[1]
    .trim()
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, " ")
    .trim();
  if (!firstParagraph) {
    throw new Error(`Empty "## Goal" section: ${markdownPath}`);
  }
  return firstParagraph;
};

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

const buildSection = async (casePaths) => {
  const bullets = [];
  for (const casePath of casePaths) {
    const caseId = await parseCaseId(casePath);
    const summary = await parseGoalSummary(casePath);
    bullets.push(wrapBullet(`\`${caseId}\`: ${summary}`));
  }
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
  const casePaths = await findRegisteredCasePaths();
  const [readme, runnerTracker] = await Promise.all([
    readText(readmePath),
    readText(runnerTrackerPath),
  ]);
  const updated = replaceSection(readme, await buildSection(casePaths));
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
