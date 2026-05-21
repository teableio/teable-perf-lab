import { access, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ENDPOINT = "https://app.teable.ai";
const DEFAULT_BASE_ID = "bselS3I2MeVI6RJhS4g";
const DEFAULT_TABLE_ID = "tbl0pa9PtLeNPCRNCKe";
const DEFAULT_REPOSITORY = "teableio/teable-perf-lab";

const FIELD_IDS = {
  "Case ID": "fldm1Uo8a21ubDZ8VRR",
};

const REQUIRED_FIELD_NAMES = [
  "Case ID",
  "Title",
  "Owner",
  "Tags",
  "Enabled",
  "Runner",
  "Primary Metric",
  "Primary Threshold Ms",
  "Timeout Ms",
  "Case Path",
  "Description Path",
  "Description URL",
  "CI Reproduce Command",
  "Local Reproduce Command",
  "Source SHA",
  "Synced At",
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

const env = (name, fallback = "") => process.env[name] ?? fallback;

const compactFields = (fields) =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );

const readText = (path) => readFile(path, "utf8");

const fileExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const parseScalar = (value) => {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  const unquoted = value.replace(/^["']|["']$/g, "");
  return unquoted;
};

const parseFrontmatter = (markdown) => {
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

  for (const line of lines) {
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

  return data;
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

const parseCaseSource = async (casePath) => {
  const source = await readText(casePath);
  const id = matchString(source, /id:\s*["']([^"']+)["']/, `${casePath} id`);
  const title = matchString(
    source,
    /title:\s*["']([^"']+)["']/,
    `${casePath} title`,
  );
  const runner = matchString(
    source,
    /runner:\s*["']([^"']+)["']/,
    `${casePath} runner`,
  );
  const timeoutMs = matchNumber(
    source,
    /timeoutMs:\s*([0-9_]+)/,
    `${casePath} timeoutMs`,
  );
  const primaryMetric = matchString(
    source,
    /threshold:\s*{[\s\S]*?metric:\s*["']([^"']+)["'][\s\S]*?maxMs:/,
    `${casePath} threshold metric`,
  );
  const primaryThresholdMs = matchNumber(
    source,
    /threshold:\s*{[\s\S]*?maxMs:\s*([0-9_]+)/,
    `${casePath} threshold maxMs`,
  );

  return {
    id,
    title,
    runner,
    timeoutMs,
    primaryMetric,
    primaryThresholdMs,
  };
};

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

const normalizePath = (path) => path.replaceAll("\\", "/");

const findCaseFilesOnDisk = async () =>
  (await walk(join(repoRoot, "cases")))
    .filter((path) => path.endsWith(".case.ts"))
    .map((path) => normalizePath(relative(repoRoot, path)))
    .sort();

const findRegisteredCaseFiles = async () => {
  const registry = await readText(join(repoRoot, "registry.ts"));
  const importPattern = /from\s+["']\.\/(cases\/[^"']+\.case)["'];?/g;
  const casePaths = [...registry.matchAll(importPattern)]
    .map((match) => `${match[1]}.ts`)
    .sort();

  if (casePaths.length === 0) {
    throw new Error("No registered perf cases found in registry.ts");
  }

  return [...new Set(casePaths)];
};

const assertRegisteredCasesMatchDisk = async () => {
  const diskCasePaths = await findCaseFilesOnDisk();
  const registeredCasePaths = await findRegisteredCaseFiles();
  const disk = new Set(diskCasePaths);
  const registered = new Set(registeredCasePaths);
  const missingFromRegistry = diskCasePaths.filter((path) => !registered.has(path));
  const missingFromDisk = registeredCasePaths.filter((path) => !disk.has(path));

  if (missingFromRegistry.length > 0 || missingFromDisk.length > 0) {
    throw new Error(
      [
        "Perf case registry does not match case files.",
        missingFromRegistry.length
          ? `Missing from registry.ts: ${missingFromRegistry.join(", ")}`
          : "",
        missingFromDisk.length
          ? `Missing on disk: ${missingFromDisk.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return registeredCasePaths.map((path) => join(repoRoot, path));
};

const getMarkdownPath = (casePath) =>
  join(dirname(casePath), `${basename(casePath, ".case.ts")}.md`);

const buildGithubBlobUrl = ({ repository, ref, path }) =>
  `https://github.com/${repository}/blob/${ref}/${path}`;

const buildCiCommand = ({ caseId }) =>
  [
    'gh workflow run "Teable EE e2e perf"',
    "  --repo teableio/teable-perf-lab",
    "  --ref main",
    "  -f teable_ee_ref=<teable-ee-branch-or-sha>",
    `  -f case_filter=${caseId}`,
    "  -f engine_filter=v1,v2",
  ].join(" \\\n");

const buildLocalCommand = ({ caseId }) =>
  [
    "PERF_LAB_CASE_FILTER=" + caseId,
    "PERF_LAB_ENGINE_LIST=v1,v2",
    "pnpm -F @teable/backend-ee exec vitest run",
    "  --config ./vitest-perf-lab.config.ts",
    "  ../../community/apps/nestjs-backend/test/perf-lab/perf-lab.e2e-spec.ts",
    "  --silent=false",
  ].join(" \\\n");

const teableRequest = async ({ endpoint, token, method, path, body }) => {
  const res = await fetch(`${endpoint.replace(/\/+$/, "")}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(
      `Teable API ${method} ${path} failed: ${res.status} ${await res.text()}`,
    );
  }

  return res.status === 204 ? undefined : res.json();
};

const getFields = async ({ endpoint, token, tableId }) =>
  teableRequest({
    endpoint,
    token,
    method: "GET",
    path: `/table/${tableId}/field`,
  });

const ensureFields = async ({ endpoint, token, tableId }) => {
  const fields = await getFields({ endpoint, token, tableId });
  const names = new Set((fields ?? []).map((field) => field.name));
  const missing = REQUIRED_FIELD_NAMES.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing Teable case fields: ${missing.join(", ")}`);
  }
};

const findExistingRecordId = async ({ endpoint, token, tableId, caseId }) => {
  const params = new URLSearchParams({
    fieldKeyType: "name",
    take: "1",
    projection: "Case ID",
    filter: JSON.stringify({
      conjunction: "and",
      filterSet: [
        {
          fieldId: FIELD_IDS["Case ID"],
          operator: "is",
          value: caseId,
        },
      ],
    }),
  });

  const data = await teableRequest({
    endpoint,
    token,
    method: "GET",
    path: `/table/${tableId}/record?${params.toString()}`,
  });

  const record = data?.records?.find(
    (item) => item.fields?.["Case ID"] === caseId,
  );
  return record?.id;
};

const upsertRecord = async ({ endpoint, token, tableId, caseId, fields }) => {
  const existingRecordId = await findExistingRecordId({
    endpoint,
    token,
    tableId,
    caseId,
  });

  if (existingRecordId) {
    await teableRequest({
      endpoint,
      token,
      method: "PATCH",
      path: `/table/${tableId}/record`,
      body: {
        fieldKeyType: "name",
        typecast: true,
        records: [{ id: existingRecordId, fields }],
      },
    });
    return { action: "updated", recordId: existingRecordId };
  }

  const data = await teableRequest({
    endpoint,
    token,
    method: "POST",
    path: `/table/${tableId}/record`,
    body: {
      fieldKeyType: "name",
      typecast: true,
      records: [{ fields }],
    },
  });
  return { action: "created", recordId: data?.records?.[0]?.id };
};

const main = async () => {
  const dryRun = /^(1|true|yes)$/i.test(env("PERF_LAB_CASE_SYNC_DRY_RUN"));
  const token = env("TEABLE_PERF_LAB_TOKEN") || env("TEABLE_TOKEN");
  if (!token && !dryRun) {
    console.warn("TEABLE_PERF_LAB_TOKEN is not set; skipping case sync.");
    return;
  }

  const endpoint = env("TEABLE_ENDPOINT", DEFAULT_ENDPOINT);
  const baseId = env("TEABLE_PERF_LAB_BASE_ID", DEFAULT_BASE_ID);
  const tableId = env("TEABLE_PERF_CASES_TABLE_ID", DEFAULT_TABLE_ID);
  const repository = env("GITHUB_REPOSITORY", DEFAULT_REPOSITORY);
  const sourceSha = env("GITHUB_SHA") || env("PERF_LAB_SOURCE_SHA");
  const ref = env("PERF_LAB_DOC_REF") || sourceSha || "main";
  const syncedAt = new Date().toISOString();
  const caseFiles = await assertRegisteredCasesMatchDisk();

  if (!dryRun) {
    await ensureFields({ endpoint, token, tableId });
  }

  for (const casePath of caseFiles) {
    const markdownPath = getMarkdownPath(casePath);
    if (!(await fileExists(markdownPath))) {
      throw new Error(`Missing case description markdown: ${markdownPath}`);
    }

    const caseInfo = await parseCaseSource(casePath);
    const markdown = await readText(markdownPath);
    const frontmatter = parseFrontmatter(markdown);
    const relativeCasePath = relative(repoRoot, casePath);
    const relativeMarkdownPath = relative(repoRoot, markdownPath);
    const descriptionUrl = buildGithubBlobUrl({
      repository,
      ref,
      path: relativeMarkdownPath,
    });

    const fields = compactFields({
      "Case ID": caseInfo.id,
      Title: caseInfo.title,
      Owner: frontmatter.owner,
      Tags: frontmatter.tags,
      Enabled: frontmatter.enabled,
      Runner: caseInfo.runner,
      "Primary Metric": caseInfo.primaryMetric,
      "Primary Threshold Ms": caseInfo.primaryThresholdMs,
      "Timeout Ms": caseInfo.timeoutMs,
      "Case Path": relativeCasePath,
      "Description Path": relativeMarkdownPath,
      "Description URL": descriptionUrl,
      "CI Reproduce Command": buildCiCommand({ caseId: caseInfo.id }),
      "Local Reproduce Command": buildLocalCommand({ caseId: caseInfo.id }),
      "Source SHA": sourceSha,
      "Synced At": syncedAt,
    });

    if (dryRun) {
      console.log(
        `Perf case dry-run: ${caseInfo.id} (${relativeCasePath}, ${relativeMarkdownPath})`,
      );
      continue;
    }

    const result = await upsertRecord({
      endpoint,
      token,
      tableId,
      caseId: caseInfo.id,
      fields,
    });

    console.log(
      `Perf case ${result.action}: ${caseInfo.id} (${result.recordId ?? "unknown record id"})`,
    );
  }

  console.log(`Base: ${baseId}, table: ${tableId}, cases: ${caseFiles.length}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
