import {
  numberOrUndefined,
  primaryMetricValue,
  readArtifactPayloads,
} from "./perf-artifact-read-model.mjs";
import {
  buildPerfSummaryCard,
  parseDate,
  resolveRunTimingFromJobs,
} from "./perf-run-summary-model.mjs";

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

const teableRequest = async ({ endpoint, token, path }) => {
  const res = await fetch(`${endpoint.replace(/\/+$/, "")}/api${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(
      `Teable API GET ${path} failed: ${res.status} ${await res.text()}`,
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

const currentRunIds = (payloads) => {
  const ids = new Set();
  const add = (value) => {
    if (!value) {
      return;
    }
    const id = String(value);
    ids.add(id);
    const [runId] = id.split("-");
    if (runId) {
      ids.add(runId);
    }
  };
  add(env("GITHUB_RUN_ID"));
  for (const payload of payloads) {
    add(payload.runId);
  }
  return ids;
};

const v1SkippedComparisonTargets = (payloads) => {
  const grouped = new Map();
  for (const payload of payloads) {
    const entry = grouped.get(payload.caseId) ?? {};
    entry[payload.engine] = payload;
    grouped.set(payload.caseId, entry);
  }

  return [...grouped.entries()]
    .filter(([, engines]) => engines.v1?.result === "skipped")
    .map(([caseId, engines]) => engines.v2 ?? { caseId })
    .filter(
      (payload) =>
        payload.engine === "v2" &&
        payload.result !== "skipped" &&
        Number.isFinite(primaryMetricValue(payload)),
    );
};

const compareRecordsByFinishedAtDesc = (a, b) =>
  (parseDate(b.fields?.["Finished At"]) ?? 0) -
  (parseDate(a.fields?.["Finished At"]) ?? 0);

const historicalBaselineForPayload = async ({
  endpoint,
  token,
  tableId,
  payload,
  excludedRunIds,
}) => {
  const metric = payload.thresholds?.[0]?.metric;
  if (!metric) {
    return undefined;
  }

  const filter = {
    conjunction: "and",
    filterSet: [
      { fieldId: "Case ID", operator: "is", value: payload.caseId },
      { fieldId: "Engine", operator: "is", value: payload.engine },
      { fieldId: "Result", operator: "is", value: "pass" },
      { fieldId: "Primary Metric", operator: "is", value: metric },
    ],
  };
  const params = new URLSearchParams({
    fieldKeyType: "name",
    take: "20",
    filter: JSON.stringify(filter),
    orderBy: JSON.stringify([{ fieldId: "Finished At", order: "desc" }]),
  });

  const data = await teableRequest({
    endpoint,
    token,
    path: `/table/${tableId}/record?${params.toString()}`,
  });
  const baselineRecord = (data?.records ?? [])
    .sort(compareRecordsByFinishedAtDesc)
    .find((record) => {
      const fields = record.fields ?? {};
      const runId = String(fields["Run ID"] ?? "");
      const value = numberOrUndefined(fields["Primary Metric Value"]);
      return (
        runId &&
        !excludedRunIds.has(runId) &&
        Number.isFinite(value) &&
        value > 0
      );
    });

  const fields = baselineRecord?.fields;
  const value = numberOrUndefined(fields?.["Primary Metric Value"]);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return {
    label: "Baseline",
    metric,
    runId: String(fields["Run ID"] ?? ""),
    value,
  };
};

const resolveComparisonBaselines = async (payloads) => {
  const token = env("TEABLE_PERF_LAB_TOKEN") || env("TEABLE_TOKEN");
  const targets = v1SkippedComparisonTargets(payloads);
  if (!token || targets.length === 0) {
    return {};
  }

  const endpoint = env("TEABLE_ENDPOINT", DEFAULT_ENDPOINT);
  const tableId = env(
    "TEABLE_PERF_LAB_TABLE_ID",
    DEFAULT_TEABLE_RESULTS_TABLE_ID,
  );
  const excludedRunIds = currentRunIds(payloads);
  const baselines = {};

  try {
    for (const payload of targets) {
      const baseline = await historicalBaselineForPayload({
        endpoint,
        token,
        tableId,
        payload,
        excludedRunIds,
      });
      if (baseline) {
        baselines[payload.caseId] = baseline;
      }
    }
  } catch (error) {
    console.warn(
      `Could not resolve historical baselines for Feishu summary: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }

  return baselines;
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
