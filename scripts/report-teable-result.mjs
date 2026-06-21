import { dirname, join } from "node:path";
import {
  compactTraceManifest,
  jsonText,
  numberOrUndefined,
  readArtifactPayloads,
  readJsonFileIfExists,
  readTextFileIfExists,
  resolvePrimaryTraceUrl,
  sanitizeCaseId,
  stringOrUndefined,
  summaryMarkdownName,
} from "./perf-artifact-read-model.mjs";

const DEFAULT_ENDPOINT = "https://app.teable.ai";
const DEFAULT_BASE_ID = "bselS3I2MeVI6RJhS4g";
const DEFAULT_TABLE_ID = "tblwPqrcchUzvyEOqLo";

const REQUIRED_FIELD_NAMES = [
  "Run Key",
  "Run ID",
  "Run Attempt",
  "Job ID",
  "Workflow",
  "Teable EE Ref",
  "Commit SHA",
  "Case ID",
  "Case Title",
  "Engine",
  "Result",
  "Started At",
  "Finished At",
  "Duration Ms",
  "Threshold Passed",
  "Primary Metric",
  "Primary Metric Value",
  "Primary Threshold",
  "Trace Ref Count",
  "Saved Trace Count",
  "Failed Trace Count",
  "Artifact Name",
  "Artifact URL",
  "Run URL",
  "Trace URL",
  "Manifest Path",
  "Metrics JSON",
  "Thresholds JSON",
  "Phases JSON",
  "Trace Manifest JSON",
  "Summary Markdown",
  "Error",
];

const FIELD_IDS = {
  "Run Key": "fldBtUJjGxgsPWsqLua",
};

const env = (name, fallback = "") => process.env[name] ?? fallback;

const RETRYABLE_TEABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retryDelayMs = (attempt, res) => {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  return Math.min(1000 * 2 ** (attempt - 1), 5000);
};

const requiredEnv = (name) => {
  const value = env(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const githubResultToPerfResult = (result) => {
  switch (result) {
    case "success":
      return "pass";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "failure":
    case "timed_out":
    case "action_required":
    case "neutral":
    default:
      return "fail";
  }
};

const buildMissingPayload = ({ caseId, payloadPath }) => {
  const engine = env("PERF_LAB_ENGINE", "local");
  const now = new Date().toISOString();
  return {
    caseId,
    title: env("PERF_LAB_CASE_TITLE") || caseId,
    runId:
      env("PERF_LAB_RUN_ID") ||
      [env("GITHUB_RUN_ID", "local"), env("GITHUB_RUN_ATTEMPT", "0"), engine]
        .filter(Boolean)
        .join("-"),
    engine,
    appUrl: env("PERF_LAB_APP_URL"),
    result: githubResultToPerfResult(env("PERF_LAB_JOB_RESULT", "failure")),
    startedAt: env("PERF_LAB_STARTED_AT") || now,
    finishedAt: now,
    metrics: {},
    thresholds: [],
    error: {
      message: `Perf payload was not generated at ${payloadPath}`,
    },
  };
};

const buildRunUrl = () => {
  const repository = env("GITHUB_REPOSITORY");
  const runId = env("GITHUB_RUN_ID");
  if (!repository || !runId) {
    return "";
  }
  return `https://github.com/${repository}/actions/runs/${runId}`;
};

const githubApi = async (path) => {
  const token = env("GITHUB_TOKEN");
  if (!token) {
    return undefined;
  }

  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });

  if (!res.ok) {
    throw new Error(
      `GitHub API ${path} failed: ${res.status} ${await res.text()}`,
    );
  }

  return res.json();
};

const resolveArtifactUrl = async ({ artifactName, runUrl }) => {
  const repository = env("GITHUB_REPOSITORY");
  const runId = env("GITHUB_RUN_ID");
  if (!repository || !runId || !artifactName) {
    return runUrl;
  }

  try {
    const data = await githubApi(
      `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
    );
    const artifact = data?.artifacts?.find(
      (item) => item.name === artifactName,
    );
    if (artifact?.id) {
      return `https://github.com/${repository}/actions/runs/${runId}/artifacts/${artifact.id}`;
    }
  } catch (error) {
    console.warn(
      `Could not resolve artifact id for ${artifactName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return runUrl;
};

const teableRequest = async ({ endpoint, token, method, path, body }) => {
  const maxAttempts = method === "GET" ? 4 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body == null ? undefined : JSON.stringify(body),
    });

    if (res.ok) {
      return res.status === 204 ? undefined : res.json();
    }

    const responseText = await res.text();
    const shouldRetry =
      attempt < maxAttempts && RETRYABLE_TEABLE_STATUS_CODES.has(res.status);

    if (!shouldRetry) {
      throw new Error(
        `Teable API ${method} ${path} failed: ${res.status} ${responseText}`,
      );
    }

    const delayMs = retryDelayMs(attempt, res);
    console.warn(
      `Teable API ${method} ${path} failed with ${res.status}; retrying in ${delayMs}ms (${attempt + 1}/${maxAttempts})`,
    );
    await sleep(delayMs);
  }
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
    throw new Error(`Missing Teable report fields: ${missing.join(", ")}`);
  }
};

const findExistingRecordId = async ({ endpoint, token, tableId, runKey }) => {
  const params = new URLSearchParams({
    fieldKeyType: "name",
    take: "1",
    projection: "Run Key",
    filter: JSON.stringify({
      conjunction: "and",
      filterSet: [
        {
          fieldId: FIELD_IDS["Run Key"],
          operator: "is",
          value: runKey,
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
    (item) => item.fields?.["Run Key"] === runKey,
  );
  return record?.id;
};

const upsertRecord = async ({ endpoint, token, tableId, runKey, fields }) => {
  const existingRecordId = await findExistingRecordId({
    endpoint,
    token,
    tableId,
    runKey,
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

const compactFields = (fields) =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );

const buildReportFields = async ({
  caseId,
  payload,
  traceManifest,
  summaryMarkdown,
  artifactName,
}) => {
  const runId = env("GITHUB_RUN_ID");
  const runAttempt = numberOrUndefined(env("GITHUB_RUN_ATTEMPT"));
  const engine = payload.engine || env("PERF_LAB_ENGINE", "local");
  const runKey = [
    runId || payload.runId,
    env("GITHUB_RUN_ATTEMPT") || "0",
    payload.caseId,
    engine,
  ].join("-");
  const runUrl = buildRunUrl();
  const resolvedArtifactName =
    artifactName ||
    env("PERF_LAB_ARTIFACT_NAME") ||
    (engine === "v1" || engine === "v2"
      ? [
          "teable-ee-e2e-perf",
          engine,
          runId || payload.runId,
          env("GITHUB_RUN_ATTEMPT") || "0",
        ].join("-")
      : undefined) ||
    [
      "teable-ee-e2e-perf",
      env("PERF_LAB_ARTIFACT_CASE", sanitizeCaseId(caseId)),
      engine,
      runId || payload.runId,
      env("GITHUB_RUN_ATTEMPT") || "0",
    ].join("-");
  const artifactUrl = await resolveArtifactUrl({
    artifactName: resolvedArtifactName,
    runUrl,
  });
  const thresholds = Array.isArray(payload.thresholds)
    ? payload.thresholds
    : [];
  const primaryThreshold = thresholds[0];
  const traces = payload.details?.observability?.traces ?? {};
  const traceManifestPath =
    stringOrUndefined(traces.manifestPath) ||
    stringOrUndefined(traceManifest?.manifestPath);
  const traceUrl = resolvePrimaryTraceUrl({
    payload,
    traceManifest,
    traceBaseUrl:
      env("TRACE_LINK_BASE_URL") || env("PERF_LAB_JAEGER_API_BASE_URL"),
  });

  return {
    runKey,
    fields: compactFields({
      "Run Key": runKey,
      "Run ID": stringOrUndefined(runId || payload.runId),
      "Run Attempt": runAttempt,
      "Job ID": stringOrUndefined(
        env("PERF_LAB_JOB_ID") || env("GITHUB_JOB") || env("CI_JOB_ID"),
      ),
      Workflow: stringOrUndefined(env("GITHUB_WORKFLOW")),
      "Teable EE Ref": stringOrUndefined(env("PERF_LAB_TEABLE_EE_REF")),
      "Commit SHA": stringOrUndefined(env("GITHUB_SHA")),
      "Case ID": stringOrUndefined(payload.caseId),
      "Case Title": stringOrUndefined(payload.title),
      Engine: stringOrUndefined(engine),
      Result: stringOrUndefined(payload.result),
      "Started At": stringOrUndefined(payload.startedAt),
      "Finished At": stringOrUndefined(payload.finishedAt),
      "Duration Ms": numberOrUndefined(payload.durationMs),
      "Threshold Passed":
        thresholds.length > 0
          ? thresholds.every((threshold) => threshold.passed)
          : undefined,
      "Primary Metric": stringOrUndefined(primaryThreshold?.metric),
      "Primary Metric Value": numberOrUndefined(primaryThreshold?.actual),
      "Primary Threshold": numberOrUndefined(primaryThreshold?.max),
      "Trace Ref Count": numberOrUndefined(traces.traceRefCount),
      "Saved Trace Count": numberOrUndefined(traces.savedTraceCount),
      "Failed Trace Count": numberOrUndefined(traces.failedTraceCount),
      "Artifact Name": stringOrUndefined(resolvedArtifactName),
      "Artifact URL": stringOrUndefined(artifactUrl),
      "Run URL": stringOrUndefined(runUrl),
      "Trace URL": stringOrUndefined(traceUrl),
      "Manifest Path": stringOrUndefined(traceManifestPath),
      "Metrics JSON": jsonText(payload.metrics),
      "Thresholds JSON": jsonText(payload.thresholds),
      "Phases JSON": jsonText(payload.phases),
      "Trace Manifest JSON": jsonText(compactTraceManifest(traceManifest)),
      "Summary Markdown": summaryMarkdown,
      Error: payload.error ? jsonText(payload.error) : undefined,
    }),
  };
};

const main = async () => {
  const token = env("TEABLE_PERF_LAB_TOKEN") || env("TEABLE_TOKEN");
  if (!token) {
    console.warn("TEABLE_PERF_LAB_TOKEN is not set; skipping Teable report.");
    return;
  }

  const endpoint = env("TEABLE_ENDPOINT", DEFAULT_ENDPOINT);
  const baseId = env("TEABLE_PERF_LAB_BASE_ID", DEFAULT_BASE_ID);
  const tableId = env("TEABLE_PERF_LAB_TABLE_ID", DEFAULT_TABLE_ID);
  const artifactDir = requiredEnv("PERF_LAB_ARTIFACT_DIR");
  const payloads = await readArtifactPayloads({
    artifactDir,
    fallbackCaseId: env("PERF_LAB_CASE_ID"),
    fallbackEngine: env("PERF_LAB_ENGINE", "local"),
    buildMissingPayload,
  });

  await ensureFields({ endpoint, token, tableId });

  const reportPayloads = payloads.filter(
    ({ payload }) => payload.engine !== "seed",
  );

  if (reportPayloads.length === 0) {
    console.warn(
      `No execute perf payloads found in ${artifactDir}; skipping report.`,
    );
    return;
  }

  for (const { payload, payloadPath, artifactName } of reportPayloads) {
    const caseId = payload.caseId;
    const engine = payload.engine || env("PERF_LAB_ENGINE", "local");
    const summaryMarkdown =
      (await readTextFileIfExists(
        join(dirname(payloadPath), summaryMarkdownName(caseId, engine)),
      )) || (await readTextFileIfExists(join(artifactDir, "summary.md")));
    const traceManifestPath =
      payload.details?.observability?.traces?.manifestPath;
    const traceManifest = traceManifestPath
      ? await readJsonFileIfExists(
          join(dirname(payloadPath), traceManifestPath),
        )
      : undefined;

    const { runKey, fields } = await buildReportFields({
      caseId,
      payload,
      traceManifest,
      summaryMarkdown,
      artifactName: env("PERF_LAB_ARTIFACT_NAME") || artifactName,
    });

    const result = await upsertRecord({
      endpoint,
      token,
      tableId,
      runKey,
      fields,
    });

    console.log(
      `Teable perf report ${result.action}: ${result.recordId ?? "(unknown record id)"}`,
    );
    console.log(`Base: ${baseId}, table: ${tableId}, run key: ${runKey}`);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
