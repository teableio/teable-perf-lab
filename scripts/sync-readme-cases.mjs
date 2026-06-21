import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, registeredCasePathsInOrder } from "./case-catalog.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const readmePath = join(repoRoot, "README.md");

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
  const goalMatch = markdown.match(/(?:^|\n)## Goal\s*\n([\s\S]*?)(?=\n## |\s*$)/);
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
const tokenize = (text) =>
  text.match(/`[^`]*`[^\s]*|\S+/g) ?? [];

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

const buildSection = async () => {
  const bullets = [];
  for (const casePath of await findRegisteredCasePaths()) {
    const caseId = await parseCaseId(casePath);
    const summary = await parseGoalSummary(casePath);
    bullets.push(wrapBullet(`\`${caseId}\`: ${summary}`));
  }
  return `${SECTION_HEADING}\n\n${GENERATED_NOTE}\n\n${bullets.join("\n")}\n`;
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
  return (
    readme.slice(0, startIndex) + section + readme.slice(nextHeadingIndex)
  );
};

const main = async () => {
  const checkOnly = process.argv.includes("--check");
  const readme = await readText(readmePath);
  const updated = replaceSection(readme, await buildSection());

  if (updated === readme) {
    console.log("README.md Available Cases list is up to date.");
    return;
  }

  if (checkOnly) {
    throw new Error(
      "README.md Available Cases list is out of date. Run `pnpm sync:readme` and commit the result.",
    );
  }

  await writeFile(readmePath, updated);
  console.log("README.md Available Cases list regenerated.");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
