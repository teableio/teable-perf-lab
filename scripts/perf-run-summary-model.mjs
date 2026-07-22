import {
  primaryMetricValue,
  traceServiceOutage,
  traceWaste,
} from "./perf-artifact-read-model.mjs";

export const parseDate = (value) => {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : undefined;
};

export const formatDuration = (ms) => {
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

export const formatMetricSeconds = (ms) => {
  if (!Number.isFinite(ms)) {
    return "skip";
  }
  if (ms < 100) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
};

export const jobDurationMs = (job) => {
  const startedAt = parseDate(job?.started_at);
  const completedAt = parseDate(job?.completed_at);
  if (startedAt == null || completedAt == null) {
    return undefined;
  }
  return completedAt - startedAt;
};

export const findJobDuration = (jobs, name) => {
  const job = jobs.find((item) => item.name === name);
  return jobDurationMs(job);
};

export const totalDurationMs = (jobs) => {
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

export const findJobGroupDuration = (jobs, name) => {
  const exactName = `Run perf cases (${name})`;
  const shardPrefix = `Run perf cases (${name}-shard-`;
  const matchingJobs = jobs.filter(
    (job) => job.name === exactName || job.name.startsWith(shardPrefix),
  );
  return totalDurationMs(matchingJobs);
};

const findSeedJobs = (jobs) =>
  jobs.filter(
    (job) =>
      job.name === "Prepare perf seed DB" ||
      job.name.startsWith("Prepare perf seed DB ("),
  );

export const seedCacheStatus = (jobs) => {
  const seedJobs = findSeedJobs(jobs);
  const statuses = seedJobs.map((seedJob) => {
    const steps = seedJob.steps ?? [];
    const hitSummary = steps.find(
      (step) => step.name === "Publish seed database cache hit summary",
    );
    const buildSeed = steps.find((step) => step.name === "Build perf seed DB");
    if (
      hitSummary?.conclusion === "success" &&
      buildSeed?.conclusion === "skipped"
    ) {
      return "hit";
    }
    if (buildSeed?.conclusion === "success") {
      return "rebuilt";
    }
    return "unknown";
  });

  if (statuses.length > 0 && statuses.every((status) => status === "hit")) {
    return "命中";
  }
  if (statuses.length > 0 && statuses.every((status) => status === "rebuilt")) {
    return "重建";
  }
  if (
    statuses.some((status) => status === "hit") &&
    statuses.some((status) => status === "rebuilt")
  ) {
    return "部分重建";
  }
  if (statuses.some((status) => status === "rebuilt")) {
    return "重建";
  }
  return "";
};

export const resolveRunTimingFromJobs = (jobs = []) => ({
  totalMs: totalDurationMs(jobs),
  seedMs: totalDurationMs(findSeedJobs(jobs)),
  seedCache: seedCacheStatus(jobs),
  v1Ms: findJobGroupDuration(jobs, "v1"),
  v2Ms: findJobGroupDuration(jobs, "v2"),
  v2SyncMs: findJobGroupDuration(jobs, "v2-sync-default"),
  v2HybridMs: findJobGroupDuration(jobs, "v2-hybrid-computed"),
});

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

export const buildCaseRows = (payloads, { comparisonBaselines = {} } = {}) => {
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
      const historicalBaseline =
        comparisonBaselines instanceof Map
          ? comparisonBaselines.get(caseId)
          : comparisonBaselines[caseId];
      const historicalBaselineValue = Number(historicalBaseline?.value);
      const hasV1Baseline = Number.isFinite(v1Value) && v1Value > 0;
      const hasHistoricalBaseline =
        Number.isFinite(historicalBaselineValue) && historicalBaselineValue > 0;
      const baselineValue = hasV1Baseline
        ? v1Value
        : hasHistoricalBaseline
          ? historicalBaselineValue
          : undefined;
      const baselineLabel = hasV1Baseline
        ? "V1"
        : hasHistoricalBaseline
          ? (historicalBaseline.label ?? "Baseline")
          : undefined;
      const hasBaseline =
        Number.isFinite(baselineValue) && Number.isFinite(v2Value);
      const ratio = hasBaseline ? baselineValue / v2Value : undefined;
      const thresholdFailed = [v1, v2]
        .filter(Boolean)
        .some((payload) =>
          Array.isArray(payload.thresholds)
            ? payload.thresholds.some((threshold) => threshold.passed === false)
            : payload.result === "fail",
        );
      const regressionRatio = hasBaseline ? v2Value / baselineValue : undefined;
      const hasSlowdown =
        Number.isFinite(regressionRatio) && regressionRatio > 1;
      const status =
        thresholdFailed || hasSlowdown
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
      let comparison = v1?.result === "skipped" ? "无 baseline" : "无 V1 基线";
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
        slowness: hasBaseline
          ? v2Value / baselineValue
          : Number.NEGATIVE_INFINITY,
        thresholdFailed,
        group: groupLabel(caseId),
        baseline: formatMetricSeconds(baselineValue),
        baselineLabel,
        v1: v1?.result === "skipped" ? "skip" : formatMetricSeconds(v1Value),
        v2: v2?.result === "skipped" ? "skip" : formatMetricSeconds(v2Value),
      };
    })
    .sort(compareCaseRows);
};

export const resultCounts = (payloads) => {
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

const chartUrlForCase = (caseId, chartUrl) => `${chartUrl}#${caseId}`;

const timingColumn = (label, value, suffix = "", weight = 1) => ({
  tag: "column",
  width: "weighted",
  weight,
  elements: [
    {
      tag: "markdown",
      content: `**${label}** ${formatDuration(value)}${suffix}`,
    },
  ],
});

const splitV2TimingColumn = (timings) => ({
  tag: "column",
  width: "weighted",
  weight: 2,
  elements: [
    {
      tag: "markdown",
      content: `**V2** sync ${formatDuration(timings.v2SyncMs)} · hybrid ${formatDuration(timings.v2HybridMs)}`,
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

export const buildPerfSummaryCard = ({
  payloads,
  timings,
  context,
  comparisonBaselines,
}) => {
  const counts = resultCounts(payloads);
  const waste = traceWaste(payloads);
  const traceOutage = traceServiceOutage(payloads);
  const wasteByEngineText = Object.entries(waste.byEngine)
    .filter(([, value]) => value.wastedMs > 0)
    .sort((a, b) => b[1].wastedMs - a[1].wastedMs)
    .map(([engine, value]) => `${engine} ${formatDuration(value.wastedMs)}`)
    .join(" · ");
  const outageByEngineText = Object.entries(traceOutage.byEngine)
    .filter(([, value]) => value.skippedFetchCount > 0)
    .sort((a, b) => b[1].skippedFetchCount - a[1].skippedFetchCount)
    .map(([engine, value]) => `${engine} ${value.skippedFetchCount}`)
    .join(" · ");
  const rows = buildCaseRows(payloads, { comparisonBaselines });
  const regressionRows = rows.filter((row) => row.status === "attention");
  const regressionCount = regressionRows.length;
  const executeResult = context.executeResult ?? "";
  const workflowFailed = executeResult && executeResult !== "success";
  const runId = context.runId ?? payloads[0]?.runId ?? "";
  const teableRef = context.teableRef ?? "";
  const sha = context.sha ?? "";
  const headerTemplate =
    workflowFailed || counts.fail > 0
      ? "red"
      : regressionCount > 0
        ? "orange"
        : "green";
  const dot = (status) =>
    status === "attention" ? "🔴" : status === "neutral" ? "⚪" : "🟢";
  const formatCaseLine = (row) => {
    const source =
      row.baselineLabel === "V1"
        ? `V1 ${row.v1}`
        : `${row.baselineLabel ?? "V1"} ${row.baseline}`;
    return `${dot(row.status)} **[${row.caseId}](${chartUrlForCase(row.caseId, context.chartUrl)})**  ${source} → V2 ${row.v2}  **${row.comparison}**`;
  };
  const regressionText =
    regressionRows.length > 0
      ? regressionRows.map(formatCaseLine).join("\n")
      : "无";
  const regressionCaseIds = new Set(regressionRows.map((row) => row.caseId));
  const remainingRows = rows.filter(
    (row) => !regressionCaseIds.has(row.caseId),
  );
  const remainingText =
    remainingRows.length > 0
      ? remainingRows.map(formatCaseLine).join("\n")
      : "无";
  const statusText = workflowFailed
    ? "执行失败"
    : counts.fail > 0
      ? "用例失败"
      : "全量通过";
  const v2TimingColumns =
    Number.isFinite(timings.v2SyncMs) || Number.isFinite(timings.v2HybridMs)
      ? [splitV2TimingColumn(timings)]
      : [timingColumn("V2", timings.v2Ms)];

  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true, enable_forward: true },
      header: {
        template: headerTemplate,
        title: {
          tag: "plain_text",
          content: `Teable EE 性能回归 · ${statusText} · 退化 ${regressionCount}`,
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
        ...(traceOutage.skippedFetchCount > 0
          ? [
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: `⚠️ **Trace 服务不可用，本轮跳过 Trace 抓取** · ${traceOutage.skippedFetchCount} 个 trace 未抓取${outageByEngineText ? `(${outageByEngineText})` : ""}\n非引擎性能退化:抓 Trace 的 Jaeger/观测服务当时不可用或无响应，本轮性能结果仍可看，但没有 raw trace 证据。请查 observability-stack / teable-perf-jaeger。`,
                },
              },
            ]
          : []),
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
                  content: `**退化** ${regressionCount}`,
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
          title: `退化 ${regressionCount}`,
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
          title: `未退化 ${remainingRows.length}`,
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
              url: context.runUrl,
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "查看数据" },
              type: "default",
              url: context.teableResultsUrl,
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "查看图表" },
              type: "default",
              url: context.chartUrl,
            },
          ],
        },
      ],
    },
  };
};
