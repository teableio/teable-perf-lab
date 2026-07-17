import { access, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findCaseFilesOnDisk,
  importedCasePathsSorted,
  loadRegistry,
} from "./case-catalog.mjs";
import { syncPerfCaseRecords } from "./perf-case-sync-model.mjs";

const DEFAULT_ENDPOINT = "https://app.teable.ai";
const DEFAULT_BASE_ID = "bselS3I2MeVI6RJhS4g";
const DEFAULT_TABLE_ID = "tbl0pa9PtLeNPCRNCKe";
const DEFAULT_REPOSITORY = "teableio/teable-perf-lab";

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
  const inlineList = value.match(/^\[(.*)\]$/);
  if (inlineList) {
    const items = inlineList[1].trim();
    return items
      ? items.split(",").map((item) => parseScalar(item.trim()))
      : [];
  }
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

// Reconciliation reads through the shared catalog so this and sync-readme parse
// registry.ts the same way; check:catalog catches the wider drift set (e.g. an
// import missing from the `cases` array) separately and earlier in `pnpm check`.
const assertRegisteredCasesMatchDisk = async () => {
  const diskCasePaths = await findCaseFilesOnDisk(repoRoot);
  const registeredCasePaths = importedCasePathsSorted(
    await loadRegistry(repoRoot),
  );
  if (registeredCasePaths.length === 0) {
    throw new Error("No registered perf cases found in registry.ts");
  }
  const disk = new Set(diskCasePaths);
  const registered = new Set(registeredCasePaths);
  const missingFromRegistry = diskCasePaths.filter(
    (path) => !registered.has(path),
  );
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

const buildGithubBlobUrl = ({ repository, path }) =>
  `https://github.com/${repository}/blob/main/${path}`;

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

const listRecords = async ({ endpoint, token, tableId }) => {
  const records = [];
  const take = 1000;

  for (let skip = 0; ; skip += take) {
    const params = new URLSearchParams({
      fieldKeyType: "name",
      take: String(take),
      skip: String(skip),
    });
    const data = await teableRequest({
      endpoint,
      token,
      method: "GET",
      path: `/table/${tableId}/record?${params.toString()}`,
    });
    const page = data?.records ?? [];
    records.push(...page);
    if (page.length < take) {
      return records;
    }
  }
};

const createTeablePerfCaseSyncAdapter = ({ endpoint, token, tableId }) => ({
  listRecords: () => listRecords({ endpoint, token, tableId }),
  async updateRecords(records) {
    await teableRequest({
      endpoint,
      token,
      method: "PATCH",
      path: `/table/${tableId}/record`,
      body: { fieldKeyType: "name", typecast: true, records },
    });
  },
  async createRecords(records) {
    const data = await teableRequest({
      endpoint,
      token,
      method: "POST",
      path: `/table/${tableId}/record`,
      body: { fieldKeyType: "name", typecast: true, records },
    });
    return data?.records ?? [];
  },
});

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
  const syncedAt = new Date().toISOString();
  const caseFiles = await assertRegisteredCasesMatchDisk();

  if (!dryRun) {
    await ensureFields({ endpoint, token, tableId });
  }

  const desiredRecords = [];
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

    desiredRecords.push({
      caseId: caseInfo.id,
      relativeCasePath,
      relativeMarkdownPath,
      fields,
    });
  }

  if (!dryRun) {
    const result = await syncPerfCaseRecords({
      adapter: createTeablePerfCaseSyncAdapter({ endpoint, token, tableId }),
      desiredRecords,
    });

    for (const record of result.updated) {
      console.log(
        `Perf case updated: ${record.caseId} (${record.recordId ?? "unknown record id"})`,
      );
    }
    for (const record of result.created) {
      console.log(
        `Perf case created: ${record.caseId} (${record.recordId ?? "unknown record id"})`,
      );
    }
    console.log(
      `Perf case sync summary: created=${result.created.length}, updated=${result.updated.length}, unchanged=${result.unchanged.length}`,
    );
  }

  console.log(`Base: ${baseId}, table: ${tableId}, cases: ${caseFiles.length}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
