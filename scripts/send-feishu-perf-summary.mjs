import { readArtifactPayloads } from "./perf-artifact-read-model.mjs";
import {
  buildPerfSummaryCard,
  resolveRunTimingFromJobs,
} from "./perf-run-summary-model.mjs";
import {
  createPerformanceTrackRecordModule,
  createTeablePerformanceTrackAdapter,
} from "./performance-track-record-model.mjs";

const DEFAULT_CHART_URL = "https://ppm.teable.app";
const DEFAULT_ENDPOINT = "https://app.teable.ai";
const DEFAULT_TEABLE_RESULTS_TABLE_ID = "tblwPqrcchUzvyEOqLo";
const DEFAULT_TEABLE_RESULTS_URL =
  "https://app.teable.ai/base/bselS3I2MeVI6RJhS4g/table/tblwPqrcchUzvyEOqLo/viwobw44IRJAHgtADI0";

const env = (name, fallback = "") => process.env[name] ?? fallback;

const requiredEnv = (name) => {
  const value = env(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const teableRequest = async ({
  endpoint,
  token,
  method = "GET",
  path,
  body,
}) => {
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

  return res.json();
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

const buildRunUrl = () => {
  const repository = env("GITHUB_REPOSITORY");
  const runId = env("GITHUB_RUN_ID");
  if (!repository || !runId) {
    return "";
  }
  return `https://github.com/${repository}/actions/runs/${runId}`;
};

const loadRunInfo = async () => {
  const repository = env("GITHUB_REPOSITORY");
  const runId = env("GITHUB_RUN_ID");
  if (!repository || !runId) {
    return undefined;
  }

  return githubApi(
    `/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`,
  );
};

const resolveRunTiming = async () => {
  try {
    const data = await loadRunInfo();
    return resolveRunTimingFromJobs(data?.jobs ?? []);
  } catch (error) {
    console.warn(
      `Could not load GitHub job timing: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
};

const resolveComparisonBaselines = async (payloads) => {
  const token = env("TEABLE_PERF_LAB_TOKEN") || env("TEABLE_TOKEN");
  if (!token) {
    return {};
  }

  const endpoint = env("TEABLE_ENDPOINT", DEFAULT_ENDPOINT);
  const tableId = env(
    "TEABLE_PERF_LAB_TABLE_ID",
    DEFAULT_TEABLE_RESULTS_TABLE_ID,
  );
  const performanceTrack = createPerformanceTrackRecordModule(
    createTeablePerformanceTrackAdapter({
      tableId,
      request: ({ method, path, body }) =>
        teableRequest({ endpoint, token, method, path, body }),
    }),
  );

  try {
    return await performanceTrack.comparisonBaselines({
      payloads,
      currentRunId: env("GITHUB_RUN_ID"),
    });
  } catch (error) {
    console.warn(
      `Could not resolve historical baselines for Feishu summary: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
};

const sendFeishuCard = async (webhookUrl, card) => {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(card),
  });

  if (!res.ok) {
    throw new Error(`Feishu webhook failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  if (data?.code !== 0 && data?.StatusCode !== 0) {
    throw new Error(`Feishu webhook rejected card: ${JSON.stringify(data)}`);
  }

  console.log("Feishu perf summary sent.");
};

const main = async () => {
  const artifactDir = requiredEnv("PERF_LAB_ARTIFACT_DIR");
  const payloadEntries = await readArtifactPayloads({
    artifactDir,
    includeSeed: false,
    allowEmpty: true,
  });
  const payloads = payloadEntries
    .map(({ payload }) => payload)
    .sort((a, b) =>
      `${a.caseId}:${a.engine}`.localeCompare(`${b.caseId}:${b.engine}`),
    );
  if (payloads.length === 0) {
    console.warn(
      `No execute perf payloads found in ${artifactDir}; skipping Feishu summary.`,
    );
    return;
  }

  const timings = await resolveRunTiming();
  const comparisonBaselines = await resolveComparisonBaselines(payloads);
  const card = buildPerfSummaryCard({
    payloads,
    timings,
    comparisonBaselines,
    context: {
      chartUrl: env("PERF_LAB_CHART_URL", DEFAULT_CHART_URL),
      executeResult: env("PERF_LAB_JOB_RESULT"),
      runId: env("GITHUB_RUN_ID", payloads[0]?.runId ?? ""),
      runUrl: buildRunUrl(),
      sha: env("PERF_LAB_TEABLE_EE_SHA") || env("GITHUB_SHA", "").slice(0, 7),
      teableRef: env("PERF_LAB_TEABLE_EE_REF") || env("GITHUB_REF_NAME"),
      teableResultsUrl: env(
        "PERF_LAB_TEABLE_RESULTS_URL",
        DEFAULT_TEABLE_RESULTS_URL,
      ),
    },
  });
  if (env("FEISHU_PERF_DRY_RUN") === "true") {
    console.log(JSON.stringify(card, null, 2));
    return;
  }

  const webhookUrl = env("FEISHU_PERF_WEBHOOK_URL");
  if (!webhookUrl) {
    console.warn(
      "FEISHU_PERF_WEBHOOK_URL is not set; skipping Feishu summary.",
    );
    return;
  }

  await sendFeishuCard(webhookUrl, card);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
