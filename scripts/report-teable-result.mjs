import { dirname, join } from "node:path";
import {
  readArtifactPayloads,
  readJsonFileIfExists,
  readTextFileIfExists,
  resolvePrimaryTraceUrl,
  sanitizeCaseId,
  summaryMarkdownName,
} from "./perf-artifact-read-model.mjs";
import {
  buildPerformanceTrackResultRecord,
  createPerformanceTrackRecordModule,
  createTeablePerformanceTrackAdapter,
  DEFAULT_PERFORMANCE_TRACK_WRITE_MAX_BYTES,
} from "./performance-track-record-model.mjs";

const DEFAULT_ENDPOINT = "https://app.teable.ai";
const DEFAULT_BASE_ID = "bselS3I2MeVI6RJhS4g";
const DEFAULT_TABLE_ID = "tblwPqrcchUzvyEOqLo";

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

const reportWriteMaxBytes = () => {
  const configured = env("PERF_LAB_REPORT_MAX_WRITE_BYTES");
  if (!configured) {
    return DEFAULT_PERFORMANCE_TRACK_WRITE_MAX_BYTES;
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid PERF_LAB_REPORT_MAX_WRITE_BYTES: ${configured}`);
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

const loadArtifactUrlByName = async (runUrl) => {
  const repository = env("GITHUB_REPOSITORY");
  const runId = env("GITHUB_RUN_ID");
  if (!repository || !runId) {
    return new Map();
  }

  try {
    const data = await githubApi(
      `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
    );
    return new Map(
      (data?.artifacts ?? []).map((artifact) => [
        artifact.name,
        artifact.id
          ? `https://github.com/${repository}/actions/runs/${runId}/artifacts/${artifact.id}`
          : runUrl,
      ]),
    );
  } catch (error) {
    console.warn(
      `Could not resolve artifact ids for run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return new Map();
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

const buildReportFields = async ({
  caseId,
  payload,
  traceManifest,
  summaryMarkdown,
  artifactName,
  artifactUrlByName,
}) => {
  const runId = env("GITHUB_RUN_ID");
  const engine = payload.engine || env("PERF_LAB_ENGINE", "local");
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
  const artifactUrl = artifactUrlByName.get(resolvedArtifactName) || runUrl;
  const traceUrl = resolvePrimaryTraceUrl({
    payload,
    traceManifest,
    traceBaseUrl:
      env("TRACE_LINK_BASE_URL") || env("PERF_LAB_JAEGER_API_BASE_URL"),
  });

  return buildPerformanceTrackResultRecord({
    payload,
    traceManifest,
    summaryMarkdown,
    context: {
      runId,
      runAttempt: env("GITHUB_RUN_ATTEMPT"),
      engine,
      jobId: env("PERF_LAB_JOB_ID") || env("GITHUB_JOB") || env("CI_JOB_ID"),
      workflow: env("GITHUB_WORKFLOW"),
      teableEeRef: env("PERF_LAB_TEABLE_EE_REF"),
      commitSha: env("GITHUB_SHA"),
      artifactName: resolvedArtifactName,
      artifactUrl,
      runUrl,
      traceUrl,
    },
  });
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
  const maxWriteBytes = reportWriteMaxBytes();
  const payloads = await readArtifactPayloads({
    artifactDir,
    fallbackCaseId: env("PERF_LAB_CASE_ID"),
    fallbackEngine: env("PERF_LAB_ENGINE", "local"),
    buildMissingPayload,
  });

  const requestCounts = { GET: 0, PATCH: 0, POST: 0 };
  const performanceTrack = createPerformanceTrackRecordModule(
    createTeablePerformanceTrackAdapter({
      tableId,
      maxWriteBytes,
      request: ({ method, path, body }) => {
        requestCounts[method] = (requestCounts[method] ?? 0) + 1;
        return teableRequest({ endpoint, token, method, path, body });
      },
    }),
  );
  await performanceTrack.assertContract();

  const reportPayloads = payloads.filter(
    ({ payload }) => payload.engine !== "seed",
  );

  if (reportPayloads.length === 0) {
    console.warn(
      `No execute perf payloads found in ${artifactDir}; skipping report.`,
    );
    return;
  }

  const prepareStartedAt = Date.now();
  const artifactUrlByName = await loadArtifactUrlByName(buildRunUrl());
  const reportRecords = await Promise.all(
    reportPayloads.map(async ({ payload, payloadPath, artifactName }) => {
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

      return buildReportFields({
        caseId,
        payload,
        traceManifest,
        summaryMarkdown,
        artifactName: env("PERF_LAB_ARTIFACT_NAME") || artifactName,
        artifactUrlByName,
      });
    }),
  );
  const prepareMs = Date.now() - prepareStartedAt;

  const writeStartedAt = Date.now();
  const result = await performanceTrack.upsertResults({
    records: reportRecords.map(({ fields }) => ({ fields })),
    runId: env("GITHUB_RUN_ID") || reportPayloads[0]?.payload.runId,
    runAttempt: env("GITHUB_RUN_ATTEMPT") || "0",
  });
  const writeMs = Date.now() - writeStartedAt;

  console.log(
    `Teable perf report complete: ${result.total} results (${result.created.length} created, ${result.updated.length} updated)`,
  );
  console.log(
    `Base: ${baseId}, table: ${tableId}, prepareMs: ${prepareMs}, writeMs: ${writeMs}, requests: GET=${requestCounts.GET}, PATCH=${requestCounts.PATCH}, POST=${requestCounts.POST}`,
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
