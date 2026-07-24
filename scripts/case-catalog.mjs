// Single source of truth for the perf-case catalog.
//
// Three views of "the cases" used to be parsed independently by two scripts with
// two different regexes, so they could disagree silently — most notably a case
// that is imported in registry.ts but never added to the `cases` array passed
// check:cases yet vanished from the README and the Teable sync. This module
// reads all three views once (case files on disk, registry imports, the
// registered `cases` array) so sync-perf-cases, sync-readme, and check:catalog
// can never drift apart.

import { readdir, readFile, access } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

const readText = (path) => readFile(path, "utf8");

const fileExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const normalizePath = (path) => path.replaceAll("\\", "/");

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await walk(path)));
      continue;
    }
    paths.push(path);
  }
  return paths;
};

// Every `cases/**/*.case.ts` on disk, repo-relative and sorted.
export const findCaseFilesOnDisk = async (repoRoot) =>
  (await walk(join(repoRoot, "cases")))
    .filter((path) => path.endsWith(".case.ts"))
    .map((path) => normalizePath(relative(repoRoot, path)))
    .sort();

export const getMarkdownPath = (casePath) =>
  normalizePath(
    join(dirname(casePath), `${basename(casePath, ".case.ts")}.md`),
  );

// Parse registry.ts into the canonical catalog: the default-import name -> case
// path map, and the registered `cases` array in its curated order.
export const loadRegistry = async (repoRoot) => {
  const registry = await readText(join(repoRoot, "registry.ts"));

  const imports = [
    ...registry.matchAll(
      /import\s+(\w+)\s+from\s+["']\.\/(cases\/[^"']+\.case)["'];?/g,
    ),
  ].map((match) => ({ name: match[1], path: `${match[2]}.ts` }));
  const pathByImport = new Map(imports.map((i) => [i.name, i.path]));

  const arrayMatch = registry.match(
    /const cases = \[([\s\S]*?)\] satisfies PerfCase\[\]/,
  );
  if (!arrayMatch) {
    throw new Error("Could not parse registry.ts cases array");
  }
  const arrayEntries = arrayMatch[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return { imports, pathByImport, arrayEntries };
};

// Registered case paths in `cases` array order (curated grouping). Used by the
// README generator so its list keeps the array order, not an alphabetical sort.
export const registeredCasePathsInOrder = (registry) =>
  registry.arrayEntries.map((name) => {
    const path = registry.pathByImport.get(name);
    if (!path) {
      throw new Error(`registry.ts cases entry has no import: ${name}`);
    }
    return path;
  });

// All imported case paths, sorted + de-duplicated. Used for the disk<->registry
// reconciliation.
export const importedCasePathsSorted = (registry) =>
  [...new Set(registry.imports.map((i) => i.path))].sort();

// The one place that decides whether the catalog is internally consistent.
// Returns a typed issue list (empty === healthy) covering every way the three
// views can disagree, including the import-not-in-array gap that used to pass
// silently.
export const listCatalogIssues = async (repoRoot) => {
  const issues = [];
  const add = (type, detail, message) => issues.push({ type, detail, message });

  const diskPaths = await findCaseFilesOnDisk(repoRoot);
  const registry = await loadRegistry(repoRoot);

  const disk = new Set(diskPaths);
  const importedPaths = new Set(registry.imports.map((i) => i.path));
  const arrayNames = new Set();

  for (const path of diskPaths) {
    if (!importedPaths.has(path)) {
      add(
        "disk-not-imported",
        path,
        `case file on disk is not imported in registry.ts: ${path}`,
      );
    }
  }

  for (const { name, path } of registry.imports) {
    if (!disk.has(path)) {
      add(
        "import-not-on-disk",
        path,
        `registry.ts imports a case file that is not on disk: ${path} (as ${name})`,
      );
    }
  }

  for (const name of registry.arrayEntries) {
    if (arrayNames.has(name)) {
      add(
        "array-duplicate",
        name,
        `registry.ts cases array lists ${name} more than once`,
      );
    }
    arrayNames.add(name);
    if (!registry.pathByImport.has(name)) {
      add(
        "array-entry-no-import",
        name,
        `registry.ts cases array entry has no matching import: ${name}`,
      );
    }
  }

  for (const { name, path } of registry.imports) {
    if (!arrayNames.has(name)) {
      add(
        "import-not-in-array",
        name,
        `case is imported but missing from the registered cases array: ${name} (${path})`,
      );
    }
  }

  // Every registered case needs its same-name description markdown.
  for (const path of importedCasePathsSorted(registry)) {
    if (
      disk.has(path) &&
      !(await fileExists(join(repoRoot, getMarkdownPath(path))))
    ) {
      add(
        "missing-markdown",
        getMarkdownPath(path),
        `registered case is missing its description markdown: ${getMarkdownPath(path)}`,
      );
    }
  }

  return issues;
};

// In-memory variant of listCatalogIssues for the self-test: takes already-parsed
// views so the detector can be exercised against synthetic catalogs without
// touching disk. Mirrors the consistency rules above except the markdown check
// (which needs the filesystem).
export const listCatalogIssuesForViews = ({
  diskPaths,
  imports,
  arrayEntries,
}) => {
  const issues = [];
  const add = (type, detail) => issues.push({ type, detail });
  const disk = new Set(diskPaths);
  const importedPaths = new Set(imports.map((i) => i.path));
  const pathByImport = new Map(imports.map((i) => [i.name, i.path]));
  const arrayNames = new Set();

  for (const path of diskPaths) {
    if (!importedPaths.has(path)) add("disk-not-imported", path);
  }
  for (const { path } of imports) {
    if (!disk.has(path)) add("import-not-on-disk", path);
  }
  for (const name of arrayEntries) {
    if (arrayNames.has(name)) add("array-duplicate", name);
    arrayNames.add(name);
    if (!pathByImport.has(name)) add("array-entry-no-import", name);
  }
  for (const { name } of imports) {
    if (!arrayNames.has(name)) add("import-not-in-array", name);
  }
  return issues;
};

const matchString = (source, pattern, label) => {
  const match = source.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Could not parse ${label}`);
  }
  return match[1];
};

const matchNumber = (source, pattern, label) => {
  const value = Number(matchString(source, pattern, label).replace(/_/g, ""));
  if (!Number.isFinite(value)) {
    throw new Error(`Could not parse numeric ${label}`);
  }
  return value;
};

const parseScalar = (value) => {
  const inlineList = value.match(/^\[(.*)\]$/);
  if (inlineList) {
    const items = inlineList[1].trim();
    return items
      ? items
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .map(parseScalar)
      : [];
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return value.replace(/^["']|["']$/g, "");
};

export const parseCaseFrontmatter = (markdown) => {
  if (!markdown.startsWith("---\n")) {
    return {};
  }
  const endIndex = markdown.indexOf("\n---", 4);
  if (endIndex === -1) {
    return {};
  }

  const lines = markdown.slice(4, endIndex).split("\n");
  const data = {};
  let currentKey = "";
  let flowSequence = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (flowSequence) {
      flowSequence += ` ${trimmed}`;
      if (trimmed.includes("]")) {
        data[currentKey] = parseScalar(flowSequence);
        flowSequence = "";
      }
      continue;
    }
    if (currentKey && trimmed.startsWith("[")) {
      flowSequence = trimmed;
      if (trimmed.includes("]")) {
        data[currentKey] = parseScalar(flowSequence);
        flowSequence = "";
      }
      continue;
    }
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && currentKey) {
      data[currentKey] ??= [];
      data[currentKey].push(parseScalar(listMatch[1].trim()));
      continue;
    }
    const pairMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pairMatch) {
      continue;
    }
    currentKey = pairMatch[1];
    const value = pairMatch[2].trim();
    data[currentKey] = value === "" ? [] : parseScalar(value);
  }
  if (flowSequence) {
    throw new Error(`Unterminated frontmatter list for ${currentKey}`);
  }
  return data;
};

export const parseCaseSeedAffinity = (caseSource) => {
  const declarations = [...caseSource.matchAll(/^\s*seedAffinity\s*:/gm)];
  const matches = [
    ...caseSource.matchAll(/^\s*seedAffinity:\s*["']([^"']+)["'],?\s*$/gm),
  ];
  if (declarations.length > 1) {
    throw new Error("seedAffinity must be declared at most once per case.");
  }
  if (declarations.length === 1 && matches.length !== 1) {
    throw new Error("seedAffinity must be a non-empty string literal.");
  }
  const seedAffinity = matches[0]?.[1];
  if (seedAffinity != null && seedAffinity.trim().length === 0) {
    throw new Error("seedAffinity must be a non-empty string literal.");
  }
  return seedAffinity;
};

export const parseCaseAcceptanceContract = (caseSource) => {
  const routingDeclarations = [
    ...caseSource.matchAll(/^\s*routingEvidence\s*:/gm),
  ];
  const routingMatches = [
    ...caseSource.matchAll(
      /^\s*routingEvidence:\s*["']not-applicable["'],?\s*$/gm,
    ),
  ];
  if (
    routingDeclarations.length > 1 ||
    routingDeclarations.length !== routingMatches.length
  ) {
    throw new Error(
      'routingEvidence must be declared at most once as "not-applicable".',
    );
  }

  const skipDeclarations = [
    ...caseSource.matchAll(/^\s*expectedSkipEngines\s*:/gm),
  ];
  const skipMatches = [
    ...caseSource.matchAll(
      /^\s*expectedSkipEngines:\s*\[((?:\s*["'](?:v1|v2)["']\s*,?)*)\],?\s*$/gm,
    ),
  ];
  if (
    skipDeclarations.length > 1 ||
    skipDeclarations.length !== skipMatches.length
  ) {
    throw new Error(
      "expectedSkipEngines must be declared at most once as a literal v1/v2 array.",
    );
  }
  const expectedSkipEngines = skipMatches[0]
    ? [
        ...new Set(
          [...skipMatches[0][1].matchAll(/["'](v1|v2)["']/g)].map(
            (match) => match[1],
          ),
        ),
      ]
    : [];
  if (skipMatches[0] && expectedSkipEngines.length === 0) {
    throw new Error("expectedSkipEngines must not be empty.");
  }
  return {
    ...(routingMatches.length === 1
      ? { routingEvidence: "not-applicable" }
      : {}),
    ...(expectedSkipEngines.length > 0 ? { expectedSkipEngines } : {}),
  };
};

export const parseCaseGoalSummary = (markdown, markdownPath) => {
  const goalMatch = markdown.match(
    /(?:^|\n)## Goal\s*\n([\s\S]*?)(?=\n## |\s*$)/,
  );
  if (!goalMatch) {
    throw new Error(`Missing "## Goal" section: ${markdownPath}`);
  }
  const goalSummary = goalMatch[1]
    .trim()
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, " ")
    .trim();
  if (!goalSummary) {
    throw new Error(`Empty "## Goal" section: ${markdownPath}`);
  }
  return goalSummary;
};

export const parseCaseSourceMetadata = (source, casePath) => {
  const id = matchString(source, /id:\s*["']([^"']+)["']/, `${casePath} id`);
  const expectedId = /^cases\/(.+)\.case\.ts$/.exec(casePath)?.[1];
  if (!expectedId) {
    throw new Error(`Unsupported registered case path: ${casePath}`);
  }
  if (id !== expectedId) {
    throw new Error(
      `${casePath} declares id ${id}; expected path-derived id ${expectedId}.`,
    );
  }
  const seedAffinity = parseCaseSeedAffinity(source);
  return {
    id,
    title: matchString(
      source,
      /title:\s*["']([^"']+)["']/,
      `${casePath} title`,
    ),
    runner: matchString(
      source,
      /runner:\s*["']([^"']+)["']/,
      `${casePath} runner`,
    ),
    timeoutMs: matchNumber(
      source,
      /timeoutMs:\s*([0-9_]+)/,
      `${casePath} timeoutMs`,
    ),
    primaryMetric: matchString(
      source,
      /threshold:\s*{[\s\S]*?metric:\s*["']([^"']+)["'][\s\S]*?maxMs:/,
      `${casePath} threshold metric`,
    ),
    primaryThresholdMs: matchNumber(
      source,
      /threshold:\s*{[\s\S]*?maxMs:\s*([0-9_]+)/,
      `${casePath} threshold maxMs`,
    ),
    ...(seedAffinity ? { seedAffinity } : {}),
    ...parseCaseAcceptanceContract(source),
  };
};

export const loadCaseCatalog = async (repoRoot) => {
  const issues = await listCatalogIssues(repoRoot);
  if (issues.length > 0) {
    throw new Error(
      `Perf case catalog has ${issues.length} issue(s): ${issues
        .map(({ type, detail }) => `${type}:${detail}`)
        .join(", ")}`,
    );
  }

  const registry = await loadRegistry(repoRoot);
  return Promise.all(
    registeredCasePathsInOrder(registry).map(async (casePath) => {
      const markdownPath = getMarkdownPath(casePath);
      const [source, markdown] = await Promise.all([
        readText(join(repoRoot, casePath)),
        readText(join(repoRoot, markdownPath)),
      ]);
      return {
        casePath,
        markdownPath,
        ...parseCaseSourceMetadata(source, casePath),
        goalSummary: parseCaseGoalSummary(markdown, markdownPath),
        frontmatter: parseCaseFrontmatter(markdown),
      };
    }),
  );
};
