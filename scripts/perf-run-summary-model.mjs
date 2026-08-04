import { traceServiceOutage, traceWaste } from "./perf-artifact-read-model.mjs";
import { formatCompactDuration } from "./format-duration.mjs";
import {
  buildReleaseComparison,
  REGRESSION_TIERS,
} from "./full-run-comparison-model.mjs";

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
  // Shared so this cannot drift back into splitting before rounding, which
  // rendered 119,700 ms as "1m60s".
  return formatCompactDuration(ms);
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

const chartUrlForCase = (caseId, chartUrl) => `${chartUrl ?? ""}#${caseId}`;

export const DEFAULT_GITHUB_SUMMARY_MAX_BYTES = 256 * 1024;

const REGRESSION_PREVIEW_LIMIT = 10;

export const formatPercentDelta = (ratio) => {
  if (!Number.isFinite(ratio)) {
    return "";
  }
  const percent = Math.round((ratio - 1) * 100);
  return `${percent >= 0 ? "+" : ""}${percent}%`;
};

// The engine column stays on every row because V1 is the control: its code
// barely moves between runs, so a case that slipped in both engines is drift
// and a case that slipped only in V2 is the engine's own doing.
export const formatEngineNote = (row) => {
  if (row.v1Skipped) {
    return "V1 skip";
  }
  if (row.v1Value === undefined) {
    return "V1 —";
  }
  const value = formatMetricSeconds(row.v1Value);
  if (!Number.isFinite(row.engineRatio)) {
    return `V1 ${value}`;
  }
  const factor = row.engineRatio >= 1 ? row.engineRatio : 1 / row.engineRatio;
  // Anything that rounds to 1.0x is a tie. "慢1.0x" claimed a direction the
  // number does not support.
  if (factor.toFixed(1) === "1.0") {
    return `V1 ${value} 持平`;
  }
  return row.engineRatio >= 1
    ? `V1 ${value} 快${factor.toFixed(1)}x`
    : `V1 ${value} 慢${factor.toFixed(1)}x`;
};

// ⚠️ marks the regressions the V1/V2 report could never show: slower than the
// released build while still ahead of V1. ⚪ is for rows that are not
// regressions at all — the resident V2<V1 panel renders those, and a red dot
// beside a case that improved 65% against the release read as an alarm.
const rowIcon = (row) => {
  if (!row.tier) {
    return "⚪";
  }
  return row.onlyReleaseVisible ? "⚠️" : "🔴";
};

export const formatComparisonLine = (row, chartUrl) => {
  // Without a released-build number there is no delta to state. Printing the
  // release segment anyway rendered "线上 skip → 1.40s ****".
  const measurement = Number.isFinite(row.releaseRatio)
    ? `线上 ${formatMetricSeconds(row.baselineV2)} → ${formatMetricSeconds(row.v2Value)} **${formatPercentDelta(row.releaseRatio)}**`
    : `本次 ${formatMetricSeconds(row.v2Value)}`;
  return [
    `${rowIcon(row)} **[${row.caseId}](${chartUrlForCase(row.caseId, chartUrl)})**`,
    `${measurement} · ${formatEngineNote(row)}`,
  ].join("\n");
};

const tierCount = (comparison, key) =>
  comparison.rows.filter((row) => row.tier === key).length;

const baselineLabel = (baseline) => {
  if (!baseline) {
    return "无";
  }
  const commit = baseline.commit ? baseline.commit.slice(0, 7) : "unknown";
  return `${baseline.release ?? commit} · ${commit}`;
};

const failedCaseIds = (payloads) => [
  ...new Set(
    payloads
      .filter(
        (payload) => payload.result !== "pass" && payload.result !== "skipped",
      )
      .map((payload) => `${payload.caseId} (${payload.engine})`),
  ),
];

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

const statColumn = (label, value) => ({
  tag: "column",
  width: "weighted",
  weight: 1,
  elements: [{ tag: "markdown", content: `**${label}** ${value}` }],
});

// Two lines per column: V2 over V1. The comparison is the point — at >2x the
// released build V2 had 9 cases against V1's 2, while at >20% it was 27 against
// 36, which is the noise floor rather than a regression.
const tierColumn = (label, v2Count, v1Count) => ({
  tag: "column",
  width: "weighted",
  weight: 1,
  elements: [
    { tag: "markdown", content: `**${label}** ${v2Count}` },
    { tag: "markdown", content: `V1 ${v1Count}` },
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

const larkDiv = (content) => ({
  tag: "div",
  text: { tag: "lark_md", content },
});

export const buildPerfSummaryCard = ({
  payloads,
  timings = {},
  context = {},
  baseline,
}) => {
  const counts = resultCounts(payloads);
  const comparison = buildReleaseComparison({ payloads, baseline });
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

  const executeResult = context.executeResult ?? "";
  const workflowFailed = executeResult && executeResult !== "success";
  const runId = context.runId ?? payloads[0]?.runId ?? "";
  const teableRef = context.teableRef ?? "";
  const sha = context.sha ?? "";
  const regressions = comparison.regressions;
  const severeCount = tierCount(comparison, "severe");
  const failures = failedCaseIds(payloads);

  const headerTemplate = !comparison.available
    ? "grey"
    : workflowFailed || counts.fail > 0
      ? "red"
      : severeCount > 0 || regressions.length > 0
        ? "orange"
        : "green";
  const headerTitle = comparison.available
    ? `性能回归 · 较线上慢 ${regressions.length} · 严重 ${severeCount}`
    : "性能回归 · 无线上基线";

  const previewRows = regressions.slice(0, REGRESSION_PREVIEW_LIMIT);
  const remainingRows = regressions.slice(REGRESSION_PREVIEW_LIMIT);
  const renderRows = (rows) =>
    rows.map((row) => formatComparisonLine(row, context.chartUrl)).join("\n\n");

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
        title: { tag: "plain_text", content: headerTitle },
      },
      elements: [
        larkDiv(
          [
            `**目标** ${teableRef}${sha ? ` @ ${sha}` : ""}`,
            comparison.available
              ? `**基线** ${baselineLabel(comparison.baseline)}${comparison.baseline?.runUrl ? ` · [run ${comparison.baseline.runId}](${comparison.baseline.runUrl})` : ""}`
              : `**基线** 未找到线上版本的历史结果，本轮无对比`,
            `**运行** ${runId} · ${counts.pass}✓ ${counts.skipped}⊘ ${counts.fail}✗`,
          ].join("\n"),
        ),
        ...(traceOutage.skippedFetchCount > 0
          ? [
              larkDiv(
                `⚠️ **Trace 服务不可用，本轮跳过 Trace 抓取** · ${traceOutage.skippedFetchCount} 个 trace 未抓取${outageByEngineText ? `(${outageByEngineText})` : ""}\n非引擎性能退化:本轮 report job 自带的 Jaeger 容器不可用或无响应，性能结果仍可看，但没有 raw trace 证据。请查 report job 的 Start/Publish report-local Jaeger 两步。`,
              ),
            ]
          : []),
        ...(waste.wastedMs >= 30_000
          ? [
              larkDiv(
                `⚠️ **Trace 抓取浪费 ${formatDuration(waste.wastedMs)}** · ${waste.missingCount} 个 trace 未命中 Jaeger${wasteByEngineText ? `(${wasteByEngineText})` : ""}\n非引擎性能退化:这些 trace 未到达 Jaeger(上游导出阶段丢弃,根因在引擎侧另行跟进),抓取时空等超时。详见各 case summary 的 \`traces missing in Jaeger\`。`,
              ),
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
            statColumn("对比", comparison.counts.compared),
            statColumn("慢", comparison.counts.slower),
            statColumn("快", comparison.counts.faster),
            statColumn("无基线", comparison.counts.missingBaseline),
          ],
        },
        ...(comparison.available
          ? [
              {
                tag: "column_set",
                flex_mode: "none",
                background_style: "grey",
                columns: REGRESSION_TIERS.map((tier) =>
                  tierColumn(
                    tier.label,
                    comparison.tiers.v2[tier.key],
                    comparison.tiers.v1[tier.key],
                  ),
                ),
              },
            ]
          : []),
        // Both panels are comparisons, so both are meaningless without a
        // baseline: "较线上慢 0" would read as a clean run, and "resident"
        // cannot be told from "new" with nothing to compare against.
        ...(comparison.available
          ? [
              collapsiblePanel({
                title: `较线上慢 ${regressions.length}${comparison.counts.onlyReleaseVisible > 0 ? `   ⚠️${comparison.counts.onlyReleaseVisible}` : ""}`,
                expanded: regressions.length > 0,
                elements: [
                  larkDiv(
                    previewRows.length > 0 ? renderRows(previewRows) : "无",
                  ),
                  ...(remainingRows.length > 0
                    ? [
                        collapsiblePanel({
                          title: `其余 ${remainingRows.length}`,
                          elements: [larkDiv(renderRows(remainingRows))],
                        }),
                      ]
                    : []),
                ],
              }),
            ]
          : []),
        ...(comparison.available && comparison.counts.residentSlower > 0
          ? [
              collapsiblePanel({
                title: `V2<V1 常驻 ${comparison.counts.residentSlower}`,
                elements: [
                  larkDiv(
                    renderRows(
                      comparison.rows.filter(
                        (row) => !row.tier && row.slowerThanV1,
                      ),
                    ) || "无",
                  ),
                ],
              }),
            ]
          : []),
        ...(failures.length > 0
          ? [
              collapsiblePanel({
                title: `失败 ${failures.length}`,
                elements: [larkDiv(failures.join("\n"))],
              }),
            ]
          : []),
        { tag: "hr" },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "CI" },
              type: "primary",
              url: context.runUrl,
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "数据" },
              type: "default",
              url: context.teableResultsUrl,
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "图表" },
              type: "default",
              url: context.chartUrl,
            },
          ],
        },
      ],
    },
  };
};

const markdownBytes = (value) => Buffer.byteLength(value, "utf8");

export const buildPerfSummaryMarkdown = ({
  payloads,
  baseline,
  context = {},
  maxBytes = DEFAULT_GITHUB_SUMMARY_MAX_BYTES,
}) => {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(
      `maxBytes must be a positive integer, received ${maxBytes}`,
    );
  }

  const counts = resultCounts(payloads);
  const comparison = buildReleaseComparison({ payloads, baseline });
  const regressions = comparison.regressions;
  const runId = context.runId ?? payloads[0]?.runId ?? "";
  const tierLine = REGRESSION_TIERS.map(
    (tier) =>
      `${tier.label} ${comparison.tiers.v2[tier.key]} (V1 ${comparison.tiers.v1[tier.key]})`,
  ).join(" · ");

  const heading = [
    "## Teable EE performance summary",
    "",
    `- Target: \`${context.teableRef || "unknown"}\`${context.sha ? ` @ \`${context.sha}\`` : ""}`,
    comparison.available
      ? `- Baseline: ${baselineLabel(comparison.baseline)} · run ${comparison.baseline?.runId}`
      : "- Baseline: none — no recorded run for the released commit",
    `- Run: ${runId || "unknown"} · Job: ${context.executeResult || "unknown"}`,
    `- Results: ${counts.pass} passed · ${counts.skipped} skipped · ${counts.fail} failed`,
    `- Vs release: ${comparison.counts.compared} compared · ${comparison.counts.slower} slower · ${comparison.counts.faster} faster · ${comparison.counts.missingBaseline} without baseline`,
    ...(comparison.available ? [`- Bands: ${tierLine}`] : []),
    "",
    "### Slower than the released build",
    "",
  ];
  const footerLinks = [
    context.runUrl ? `[CI run](${context.runUrl})` : "",
    context.teableResultsUrl
      ? `[Performance Track](${context.teableResultsUrl})`
      : "",
    context.chartUrl ? `[Charts](${context.chartUrl})` : "",
  ].filter(Boolean);
  const footer = [
    "",
    // "Every regression here is also slower than V1" is a vacuous claim when
    // there are no regressions to speak of.
    regressions.length === 0
      ? comparison.available
        ? "No case is slower than the released build."
        : "No comparison was possible."
      : comparison.counts.onlyReleaseVisible > 0
        ? `${comparison.counts.onlyReleaseVisible} of these still beat V1 — invisible to the V1/V2 comparison.`
        : "Every regression here is also slower than V1.",
    ...(comparison.counts.residentSlower > 0
      ? [
          `${comparison.counts.residentSlower} cases are slower than V1 without regressing against the release (long-standing, not new).`,
        ]
      : []),
    ...(footerLinks.length > 0 ? ["", footerLinks.join(" · ")] : []),
    "",
  ];
  const render = (details, truncatedCount) =>
    [
      ...heading,
      ...(details.length > 0 ? details : ["None."]),
      ...(truncatedCount > 0
        ? [
            "",
            `Truncated ${truncatedCount} detail rows to stay within ${maxBytes} bytes.`,
          ]
        : []),
      ...footer,
    ].join("\n");

  const detailLines = [];
  for (let index = 0; index < regressions.length; index += 1) {
    const row = regressions[index];
    const candidate = [
      ...detailLines,
      `- ${rowIcon(row)} [${row.caseId}](${chartUrlForCase(row.caseId, context.chartUrl)}) 线上 ${formatMetricSeconds(row.baselineV2)} → ${formatMetricSeconds(row.v2Value)} **${formatPercentDelta(row.releaseRatio)}** · ${formatEngineNote(row)}`,
    ];
    const truncatedCount = regressions.length - candidate.length;
    if (markdownBytes(render(candidate, truncatedCount)) > maxBytes) {
      break;
    }
    detailLines.push(candidate.at(-1));
  }

  const markdown = render(detailLines, regressions.length - detailLines.length);
  if (markdownBytes(markdown) > maxBytes) {
    throw new Error(
      `GitHub perf summary fixed content exceeds ${maxBytes} bytes; increase the configured budget`,
    );
  }
  return markdown;
};
