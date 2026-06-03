import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_CHART_URL = "https://ppm.teable.app";
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

const numberOrUndefined = (value) => {
  if (value == null || value === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const readJsonFile = async (path) => JSON.parse(await readFile(path, "utf8"));

const readArtifactPayloads = async (artifactDir) => {
  const payloads = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      if (entry.name === "manifest.json") {
        continue;
      }
      const payload = await readJsonFile(path);
      if (payload?.caseId && payload?.engine && payload.engine !== "seed") {
        payloads.push(payload);
      }
    }
  };

  await walk(artifactDir);
  return payloads.sort((a, b) =>
    `${a.caseId}:${a.engine}`.localeCompare(`${b.caseId}:${b.engine}`),
  );
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

const parseDate = (value) => {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : undefined;
};

const formatDuration = (ms) => {
  if (!Number.isFinite(ms)) {
    return "-";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  return `${minutes}m${String(restSeconds).padStart(2, "0")}s`;
};

const formatMetricSeconds = (ms) => {
  if (!Number.isFinite(ms)) {
    return "skip";
  }
  if (ms < 100) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
};

const sanitizeCaseId = (caseId) => caseId.replace(/[^a-zA-Z0-9_.-]+/g, "-");

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

  return githubApi(`/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`);
};

const jobDurationMs = (job) => {
  const startedAt = parseDate(job?.started_at);
  const completedAt = parseDate(job?.completed_at);
  if (startedAt == null || completedAt == null) {
    return undefined;
  }
  return completedAt - startedAt;
};

const findJobDuration = (jobs, name) => {
  const job = jobs.find((item) => item.name === name);
  return jobDurationMs(job);
};

const totalDurationMs = (jobs) => {
  const starts = jobs
    .map((job) => parseDate(job.started_at))
    .filter((time) => time != null);
  const completes = jobs
    .map((job) => parseDate(job.completed_at))
    .filter((time) => time != null);
  if (starts.length === 0 || completes.length === 0) {
    return undefined;
  }
  return Math.max(...completes) - Math.min(...starts);
};

const seedCacheStatus = (jobs) => {
  const seedJob = jobs.find((item) => item.name === "Prepare perf seed DB");
  const steps = seedJob?.steps ?? [];
  const hitSummary = steps.find(
    (step) => step.name === "Publish seed database cache hit summary",
  );
  const buildSeed = steps.find((step) => step.name === "Build perf seed DB");
  if (hitSummary?.conclusion === "success" && buildSeed?.conclusion === "skipped") {
    return "命中";
  }
  if (buildSeed?.conclusion === "success") {
    return "重建";
  }
  return "";
};

const resolveRunTiming = async () => {
  try {
    const data = await loadRunInfo();
    const jobs = data?.jobs ?? [];
    return {
      totalMs: totalDurationMs(jobs),
      seedMs: findJobDuration(jobs, "Prepare perf seed DB"),
      seedCache: seedCacheStatus(jobs),
      v1Ms: findJobDuration(jobs, "Run perf cases (v1)"),
      v2Ms: findJobDuration(jobs, "Run perf cases (v2)"),
    };
  } catch (error) {
    console.warn(
      `Could not load GitHub job timing: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
};

const primaryThreshold = (payload) =>
  Array.isArray(payload.thresholds) ? payload.thresholds[0] : undefined;

const primaryMetricValue = (payload) => {
  const threshold = primaryThreshold(payload);
  if (Number.isFinite(threshold?.actual)) {
    return threshold.actual;
  }
  return numberOrUndefined(payload.durationMs);
};

const buildCaseRows = (payloads) => {
  const grouped = new Map();
  for (const payload of payloads) {
    const entry = grouped.get(payload.caseId) ?? {};
    entry[payload.engine] = payload;
    grouped.set(payload.caseId, entry);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([caseId, engines]) => {
      const v1 = engines.v1;
      const v2 = engines.v2;
      const v1Value = v1?.result === "skipped" ? undefined : primaryMetricValue(v1);
      const v2Value = v2?.result === "skipped" ? undefined : primaryMetricValue(v2);
      const hasBaseline =
        Number.isFinite(v1Value) && Number.isFinite(v2Value) && v1Value > 0;
      const ratio = hasBaseline ? v1Value / v2Value : undefined;
      const thresholdFailed = [v1, v2]
        .filter(Boolean)
        .some((payload) =>
          Array.isArray(payload.thresholds)
            ? payload.thresholds.some((threshold) => threshold.passed === false)
            : payload.result === "fail",
        );
      const v2NotFaster = hasBaseline && v2Value >= v1Value;
      const status = thresholdFailed || v2NotFaster ? "attention" : hasBaseline ? "ok" : "neutral";
      let comparison = "无 V1 基线";
      if (hasBaseline) {
        comparison =
          ratio > 1
            ? `快 ${ratio.toFixed(1)}x`
            : ratio === 1
              ? "相同速度"
            : `慢 ${(1 / ratio).toFixed(1)}x`;
      }

      return {
        caseId,
        status,
        comparison,
        v1: v1?.result === "skipped" ? "skip" : formatMetricSeconds(v1Value),
        v2: v2?.result === "skipped" ? "skip" : formatMetricSeconds(v2Value),
      };
    });
};

const resultCounts = (payloads) => {
  const counts = { pass: 0, skipped: 0, fail: 0 };
  for (const payload of payloads) {
    if (payload.result === "pass") {
      counts.pass += 1;
    } else if (payload.result === "skipped") {
      counts.skipped += 1;
    } else {
      counts.fail += 1;
    }
  }
  return counts;
};

const chartUrlForCase = (caseId) =>
  `${env("PERF_LAB_CHART_URL", DEFAULT_CHART_URL)}#${caseId}`;

const buildCard = ({ payloads, timings }) => {
  const counts = resultCounts(payloads);
  const rows = buildCaseRows(payloads);
  const attentionCount = rows.filter((row) => row.status === "attention").length;
  const runId = env("GITHUB_RUN_ID", payloads[0]?.runId ?? "");
  const teableRef = env("PERF_LAB_TEABLE_EE_REF") || env("GITHUB_REF_NAME");
  const sha = env("PERF_LAB_TEABLE_EE_SHA") || env("GITHUB_SHA", "").slice(0, 7);
  const headerTemplate = counts.fail > 0 ? "red" : attentionCount > 0 ? "orange" : "green";
  const dot = (status) =>
    status === "attention" ? "🔴" : status === "neutral" ? "⚪" : "🟢";
  const compareText = (row) =>
    row.status === "attention" ? `**${row.comparison}**` : row.comparison;
  const rowsText = rows
    .map(
      (row) =>
        `${dot(row.status)} **${row.caseId}**  V1 ${row.v1} → V2 ${row.v2}  ${compareText(row)}  [查看](${chartUrlForCase(row.caseId)})`,
    )
    .join("\n");

  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true, enable_forward: true },
      header: {
        template: headerTemplate,
        title: {
          tag: "plain_text",
          content: `Teable EE 性能回归 · 全量${counts.fail > 0 ? "失败" : "通过"} · ${attentionCount} 项关注`,
        },
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**目标**: teable-ee ${teableRef}${sha ? ` @ ${sha}` : ""}\n**运行**: ${runId}  |  **结果**: ${counts.pass} 通过 / ${counts.skipped} 跳过 / ${counts.fail} 失败`,
          },
        },
        {
          tag: "column_set",
          flex_mode: "none",
          background_style: "grey",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                {
                  tag: "markdown",
                  content: `**总耗时** ${formatDuration(timings.totalMs)}`,
                },
              ],
            },
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                {
                  tag: "markdown",
                  content: `**Seed** ${formatDuration(timings.seedMs)}${timings.seedCache ? ` ${timings.seedCache}` : ""}`,
                },
              ],
            },
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                {
                  tag: "markdown",
                  content: `**V1** ${formatDuration(timings.v1Ms)}`,
                },
              ],
            },
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                {
                  tag: "markdown",
                  content: `**V2** ${formatDuration(timings.v2Ms)}`,
                },
              ],
            },
          ],
        },
        { tag: "hr" },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**用例耗时对比**\n${rowsText}`,
          },
        },
        { tag: "hr" },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "查看 CI" },
              type: "primary",
              url: buildRunUrl(),
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "查看数据" },
              type: "default",
              url: env("PERF_LAB_TEABLE_RESULTS_URL", DEFAULT_TEABLE_RESULTS_URL),
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "查看图表" },
              type: "default",
              url: env("PERF_LAB_CHART_URL", DEFAULT_CHART_URL),
            },
          ],
        },
      ],
    },
  };
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
  const payloads = await readArtifactPayloads(artifactDir);
  if (payloads.length === 0) {
    console.warn(`No execute perf payloads found in ${artifactDir}; skipping Feishu summary.`);
    return;
  }

  const timings = await resolveRunTiming();
  const card = buildCard({ payloads, timings });
  if (env("FEISHU_PERF_DRY_RUN") === "true") {
    console.log(JSON.stringify(card, null, 2));
    return;
  }

  const webhookUrl = env("FEISHU_PERF_WEBHOOK_URL");
  if (!webhookUrl) {
    console.warn("FEISHU_PERF_WEBHOOK_URL is not set; skipping Feishu summary.");
    return;
  }

  await sendFeishuCard(webhookUrl, card);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
