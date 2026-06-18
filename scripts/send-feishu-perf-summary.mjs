import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_CHART_URL = "https://ppm.teable.app";
const DEFAULT_TEABLE_RESULTS_URL =
  "https://app.teable.ai/base/bselS3I2MeVI6RJhS4g/table/tblwPqrcchUzvyEOqLo/viwobw44IRJAHgtADI0";
const REGRESSION_RATIO_THRESHOLD = 1.2;

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

  return githubApi(
    `/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`,
  );
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
  if (
    hitSummary?.conclusion === "success" &&
    buildSeed?.conclusion === "skipped"
  ) {
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
      v2SyncMs: findJobDuration(jobs, "Run perf cases (v2-sync-default)"),
      v2HybridMs: findJobDuration(jobs, "Run perf cases (v2-hybrid-computed)"),
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

const rowStatusRank = (status) => {
  switch (status) {
    case "attention":
      return 0;
    case "neutral":
      return 1;
    default:
      return 2;
  }
};

const compareCaseRows = (a, b) => {
  const statusDiff = rowStatusRank(a.status) - rowStatusRank(b.status);
  if (statusDiff !== 0) {
    return statusDiff;
  }

  const slownessDiff = b.slowness - a.slowness;
  if (slownessDiff !== 0) {
    return slownessDiff;
  }

  return a.caseId.localeCompare(b.caseId);
};

const groupLabel = (caseId) => caseId.split("/")[0] || caseId;

const buildCaseRows = (payloads) => {
  const grouped = new Map();
  for (const payload of payloads) {
    const entry = grouped.get(payload.caseId) ?? {};
    entry[payload.engine] = payload;
    grouped.set(payload.caseId, entry);
  }

  return [...grouped.entries()]
    .map(([caseId, engines]) => {
      const v1 = engines.v1;
      const v2 = engines.v2;
      const v1Value =
        v1 && v1.result !== "skipped" ? primaryMetricValue(v1) : undefined;
      const v2Value =
        v2 && v2.result !== "skipped" ? primaryMetricValue(v2) : undefined;
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
      const regressionRatio = hasBaseline ? v2Value / v1Value : undefined;
      const hasRegression =
        Number.isFinite(regressionRatio) &&
        regressionRatio >= REGRESSION_RATIO_THRESHOLD;
      const status =
        thresholdFailed || hasRegression
          ? "attention"
          : hasBaseline
            ? "ok"
            : "neutral";
      const direction =
        thresholdFailed || !hasBaseline
          ? "neutral"
          : ratio >= 1
            ? "faster"
            : "slower";
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
        direction,
        ratio: hasBaseline ? ratio : undefined,
        regressionRatio,
        slowness: hasBaseline ? v2Value / v1Value : Number.NEGATIVE_INFINITY,
        thresholdFailed,
        group: groupLabel(caseId),
        v1: v1?.result === "skipped" ? "skip" : formatMetricSeconds(v1Value),
        v2: v2?.result === "skipped" ? "skip" : formatMetricSeconds(v2Value),
      };
    })
    .sort(compareCaseRows);
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

// Aggregate the wall-clock burned polling Jaeger for traces that never showed
// up (typically v2 reads served from the performance cache emit no sampled
// span). This is invisible in per-case durationMs, so surface it explicitly.
const traceWaste = (payloads) => {
  const byEngine = {};
  let missingCount = 0;
  let wastedMs = 0;
  for (const payload of payloads) {
    const traces = payload.details?.observability?.traces;
    const missing = numberOrUndefined(traces?.missingFetchCount) ?? 0;
    const wastedSum = numberOrUndefined(traces?.wastedFetchMs) ?? 0;
    if (!missing && !wastedSum) {
      continue;
    }
    // wastedFetchMs sums poll time across concurrent fetch lanes; divide by the
    // concurrency to estimate the wall-clock this case added. Cases run
    // serially, so summing the per-case estimates yields the run-level cost.
    const concurrency = Math.max(
      numberOrUndefined(traces?.fetchConcurrency) ?? 1,
      1,
    );
    const wasted = wastedSum / concurrency;
    missingCount += missing;
    wastedMs += wasted;
    const bucket = (byEngine[payload.engine] ??= { missing: 0, wastedMs: 0 });
    bucket.missing += missing;
    bucket.wastedMs += wasted;
  }
  return { missingCount, wastedMs, byEngine };
};

const chartUrlForCase = (caseId) =>
  `${env("PERF_LAB_CHART_URL", DEFAULT_CHART_URL)}#${caseId}`;

const timingColumn = (label, value, suffix = "") => ({
  tag: "column",
  width: "weighted",
  weight: 1,
  elements: [
    {
      tag: "markdown",
      content: `**${label}** ${formatDuration(value)}${suffix}`,
    },
  ],
});

const collapsiblePanel = ({ title, expanded = false, elements }) => ({
  tag: "collapsible_panel",
  expanded,
  header: {
    title: {
      tag: "markdown",
      content: `**${title}**`,
    },
    vertical_align: "center",
    icon: {
      tag: "standard_icon",
      token: "down-small-ccm_outlined",
      color: "grey",
      size: "16px 16px",
    },
    icon_position: "follow_text",
    icon_expanded_angle: -180,
  },
  vertical_spacing: "8px",
  elements,
});

const buildCard = ({ payloads, timings }) => {
  const counts = resultCounts(payloads);
  const waste = traceWaste(payloads);
  const wasteByEngineText = Object.entries(waste.byEngine)
    .filter(([, value]) => value.wastedMs > 0)
    .sort((a, b) => b[1].wastedMs - a[1].wastedMs)
    .map(([engine, value]) => `${engine} ${formatDuration(value.wastedMs)}`)
    .join(" · ");
  const rows = buildCaseRows(payloads);
  const regressionRows = rows.filter((row) => row.status === "attention");
  const regressionCount = regressionRows.length;
  const executeResult = env("PERF_LAB_JOB_RESULT");
  const workflowFailed = executeResult && executeResult !== "success";
  const runId = env("GITHUB_RUN_ID", payloads[0]?.runId ?? "");
  const teableRef = env("PERF_LAB_TEABLE_EE_REF") || env("GITHUB_REF_NAME");
  const sha =
    env("PERF_LAB_TEABLE_EE_SHA") || env("GITHUB_SHA", "").slice(0, 7);
  const headerTemplate =
    workflowFailed || counts.fail > 0
      ? "red"
      : regressionCount > 0
        ? "orange"
        : "green";
  const dot = (status) =>
    status === "attention" ? "🔴" : status === "neutral" ? "⚪" : "🟢";
  const formatCaseLine = (row) =>
    `${dot(row.status)} **[${row.caseId}](${chartUrlForCase(row.caseId)})**  V1 ${row.v1} → V2 ${row.v2}  **${row.comparison}**`;
  const regressionText =
    regressionRows.length > 0
      ? regressionRows.map(formatCaseLine).join("\n")
      : "未发现达到阈值的性能退化。";
  const regressionCaseIds = new Set(regressionRows.map((row) => row.caseId));
  const remainingRows = rows.filter(
    (row) => !regressionCaseIds.has(row.caseId),
  );
  const remainingText =
    remainingRows.length > 0
      ? remainingRows.map(formatCaseLine).join("\n")
      : "无其余对比项。";
  const statusText = workflowFailed
    ? "执行失败"
    : counts.fail > 0
      ? "用例失败"
      : "全量通过";
  const v2TimingColumns =
    Number.isFinite(timings.v2SyncMs) || Number.isFinite(timings.v2HybridMs)
      ? [
          timingColumn("V2 sync", timings.v2SyncMs),
          timingColumn("V2 hybrid", timings.v2HybridMs),
        ]
      : [timingColumn("V2", timings.v2Ms)];

  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true, enable_forward: true },
      header: {
        template: headerTemplate,
        title: {
          tag: "plain_text",
          content: `Teable EE 性能回归 · ${statusText} · ${regressionCount} 项退化`,
        },
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**目标**: teable-ee ${teableRef}${sha ? ` @ ${sha}` : ""}\n**运行**: ${runId}  |  **任务**: ${executeResult || "unknown"}  |  **结果**: ${counts.pass} 通过 / ${counts.skipped} 跳过 / ${counts.fail} 失败`,
          },
        },
        ...(waste.wastedMs >= 30_000
          ? [
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: `⚠️ **Trace 抓取浪费 ${formatDuration(waste.wastedMs)}** · ${waste.missingCount} 个 trace 未命中 Jaeger${wasteByEngineText ? `(${wasteByEngineText})` : ""}\n非引擎性能退化:这些 trace 未到达 Jaeger(上游导出阶段丢弃,根因在引擎侧另行跟进),抓取时空等超时。详见各 case summary 的 \`traces missing in Jaeger\`。`,
                },
              },
            ]
          : []),
        {
          tag: "column_set",
          flex_mode: "none",
          background_style: "grey",
          columns: [
            timingColumn("总耗时", timings.totalMs),
            timingColumn(
              "Seed",
              timings.seedMs,
              timings.seedCache ? ` ${timings.seedCache}` : "",
            ),
            timingColumn("V1", timings.v1Ms),
            ...v2TimingColumns,
          ],
        },
        { tag: "hr" },
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
                  content: `**对比项** ${rows.length}`,
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
                  content: `**退化项** ${regressionCount}`,
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
                  content: `**跳过** ${counts.skipped}`,
                },
              ],
            },
          ],
        },
        collapsiblePanel({
          title: `性能退化项 ${regressionCount}`,
          expanded: true,
          elements: [
            {
              tag: "div",
              text: {
                tag: "lark_md",
                content: regressionText,
              },
            },
          ],
        }),
        collapsiblePanel({
          title: `其余对比项 ${remainingRows.length}`,
          expanded: false,
          elements: [
            {
              tag: "div",
              text: {
                tag: "lark_md",
                content: remainingText,
              },
            },
          ],
        }),
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
              url: env(
                "PERF_LAB_TEABLE_RESULTS_URL",
                DEFAULT_TEABLE_RESULTS_URL,
              ),
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
    console.warn(
      `No execute perf payloads found in ${artifactDir}; skipping Feishu summary.`,
    );
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
