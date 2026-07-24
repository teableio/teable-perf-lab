import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCaseCatalog } from "./case-catalog.mjs";
import {
  chunkPerfCaseWriteRecords,
  DEFAULT_PERF_CASE_WRITE_MAX_BYTES,
  syncPerfCaseRecords,
} from "./perf-case-sync-model.mjs";

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

const perfCaseWriteMaxBytes = () => {
  const configured = env("PERF_LAB_CASE_SYNC_MAX_WRITE_BYTES");
  if (!configured) {
    return DEFAULT_PERF_CASE_WRITE_MAX_BYTES;
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `Invalid PERF_LAB_CASE_SYNC_MAX_WRITE_BYTES: ${configured}`,
    );
  }
  return value;
};

const compactFields = (fields) =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );

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

const createTeablePerfCaseSyncAdapter = ({
  endpoint,
  token,
  tableId,
  maxWriteBytes,
}) => ({
  listRecords: () => listRecords({ endpoint, token, tableId }),
  async updateRecords(records) {
    const batches = chunkPerfCaseWriteRecords(records, maxWriteBytes);
    for (const batch of batches) {
      await teableRequest({
        endpoint,
        token,
        method: "PATCH",
        path: `/table/${tableId}/record`,
        body: { fieldKeyType: "name", typecast: true, records: batch },
      });
    }
  },
  async createRecords(records) {
    const createdRecords = [];
    const batches = chunkPerfCaseWriteRecords(records, maxWriteBytes);
    for (const batch of batches) {
      const data = await teableRequest({
        endpoint,
        token,
        method: "POST",
        path: `/table/${tableId}/record`,
        body: { fieldKeyType: "name", typecast: true, records: batch },
      });
      const createdBatch = data?.records ?? [];
      if (createdBatch.length !== batch.length) {
        throw new Error(
          `Teable created ${createdBatch.length} perf case records; expected ${batch.length}`,
        );
      }
      createdRecords.push(...createdBatch);
    }
    return createdRecords;
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
  const maxWriteBytes = perfCaseWriteMaxBytes();
  const caseCatalog = await loadCaseCatalog(repoRoot);

  if (!dryRun) {
    await ensureFields({ endpoint, token, tableId });
  }

  const desiredRecords = [];
  for (const caseInfo of caseCatalog) {
    const relativeCasePath = caseInfo.casePath;
    const relativeMarkdownPath = caseInfo.markdownPath;
    const descriptionUrl = buildGithubBlobUrl({
      repository,
      path: relativeMarkdownPath,
    });

    const fields = compactFields({
      "Case ID": caseInfo.id,
      Title: caseInfo.title,
      Owner: caseInfo.frontmatter.owner,
      Tags: caseInfo.frontmatter.tags,
      Enabled: caseInfo.frontmatter.enabled,
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
      adapter: createTeablePerfCaseSyncAdapter({
        endpoint,
        token,
        tableId,
        maxWriteBytes,
      }),
      desiredRecords,
    });

    for (const record of result.updated) {
      console.log(
        `Perf case updated: ${record.caseId} (${record.recordId ?? "unknown record id"}; fields=${record.changedFields.join(",")})`,
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

  console.log(
    `Base: ${baseId}, table: ${tableId}, cases: ${caseCatalog.length}`,
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
