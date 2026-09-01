import { join } from "node:path";
import {
  readArtifactPayloads,
  readJsonFileIfExists,
} from "./perf-artifact-read-model.mjs";
import { env, requiredEnv } from "./env.mjs";
import {
  buildPerfSummaryCard,
  resolveRunTimingFromJobs,
} from "./perf-run-summary-model.mjs";
import { buildEngineComparison } from "./engine-comparison-model.mjs";
import { RELEASE_BASELINE_FILE_NAME } from "./release-baseline-model.mjs";
import { loadEnginePairHistory } from "./resolve-engine-pair-history.mjs";
import { loadSameRunHistory } from "./resolve-same-run-history.mjs";
import { buildSameRunComparison } from "./same-run-comparison-model.mjs";

const DEFAULT_CHART_URL = "https://ppm.teable.app";
const DEFAULT_TEABLE_RESULTS_URL =
  "https://app.teable.ai/base/bselS3I2MeVI6RJhS4g/table/tblwPqrcchUzvyEOqLo/viwobw44IRJAHgtADI0";

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

// Written by `resolve-release-baseline.mjs` earlier in the report job. Absent
// means that step was skipped or found no run for the released commit; the card
// then renders its explicit "no baseline" state.
const readReleaseBaseline = (artifactDir) =>
  readJsonFileIfExists(join(artifactDir, RELEASE_BASELINE_FILE_NAME));

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
    throw new Error(
      `Feishu webhook rejected the card: ${JSON.stringify(data)}`,
    );
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
  const baseline = await readReleaseBaseline(artifactDir);
  const context = {
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
  };
  // Same-run leads: each case versus its own recent history. The 1.2x
  // vs-one-release-run list is still computed, but it is not the verdict.
  let sameRun;
  try {
    const caseIds = [
      ...new Set(
        payloads
          .filter(
            (payload) => payload.engine === "v2" && payload.result === "pass",
          )
          .map((payload) => payload.caseId)
          .filter(Boolean),
      ),
    ];
    const identityByCase = Object.fromEntries(
      payloads
        .filter((payload) => payload.engine === "v2" && payload.measurement)
        .map((payload) => [
          payload.caseId,
          {
            contractId: payload.measurement.contract?.id,
            environmentClass: payload.measurement.environment?.class,
          },
        ]),
    );
    const history = await loadSameRunHistory({
      caseIds,
      currentRunId: context.runId,
      identityByCase,
    });
    sameRun = buildSameRunComparison({
      payloads,
      historyByCase: history.valuesByCase,
      historyCompatibilityByCase: history.compatibilityByCase,
    });
  } catch (error) {
    console.warn(
      `Could not load same-run history: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let recentRatiosByCase;
  try {
    const candidates = buildEngineComparison({ payloads }).regressions.map(
      (row) => row.caseId,
    );
    recentRatiosByCase = await loadEnginePairHistory({
      caseIds: candidates,
      currentRunId: context.runId,
    });
  } catch (error) {
    console.warn(
      `Could not load recent V1/V2 pairs for the engine panel: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const card = buildPerfSummaryCard({
    payloads,
    timings,
    baseline,
    context,
    recentRatiosByCase,
    sameRun,
  });
  if (env("FEISHU_PERF_DRY_RUN") === "true") {
    console.log(JSON.stringify(card, null, 2));
    return;
  }

  const webhookUrl = env("FEISHU_PERF_WEBHOOK_URL");
  if (!webhookUrl) {
    if (env("PERF_LAB_REQUIRE_DELIVERY") === "true") {
      throw new Error(
        "FEISHU_PERF_WEBHOOK_URL is required for full-run acceptance.",
      );
    }
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
