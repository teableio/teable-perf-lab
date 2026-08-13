import { traceServiceOutage, traceWaste } from "./perf-artifact-read-model.mjs";
import { formatCompactDuration } from "./format-duration.mjs";
import {
  buildReleaseComparison,
  REGRESSION_TIERS,
} from "./full-run-comparison-model.mjs";
import { buildEngineComparison } from "./engine-comparison-model.mjs";
import { buildComputeComparison } from "./compute-comparison-model.mjs";

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

/**
 * How this run compares to one reference, as a ratio and never a percent.
 *
 * `ratio` is always this run divided by the reference, so above 1 is slower
 * wherever it appears, and the bands are stated the same way — a row in percent
 * beside a band in ratios makes the reader convert before they can weigh one
 * against the other.
 */
export const formatRatioFactor = (ratio) => {
  if (!Number.isFinite(ratio)) {
    return undefined;
  }
  const factor = ratio >= 1 ? ratio : 1 / ratio;
  // Anything that rounds to 1.0x is a tie. "慢1.0x" claimed a direction the
  // number does not support.
  if (factor.toFixed(1) === "1.0") {
    return "持平";
  }
  return `${ratio > 1 ? "慢" : "快"}${factor.toFixed(1)}x`;
};

export const formatComparison = (label, referenceValue, ratio) => {
  if (referenceValue === undefined) {
    return `${label} —`;
  }
  const value = formatMetricSeconds(referenceValue);
  const factor = formatRatioFactor(ratio);
  return factor ? `${label} ${value} ${factor}` : `${label} ${value}`;
};

export const formatReleaseNote = (row) =>
  formatComparison("线上", row.baselineV2, row.releaseRatio);

// The GitHub summary lists at most this many compute rows. Small because the
// block is fixed content weighed against the byte budget before regression
// detail; the count of everything else is always printed.
export const COMPUTE_HIGHLIGHT_LIMIT = 5;

// Names for the compute verdicts, and the definition each name needs.
//
// These were sentences once — "计算量没降，只是挪走了" — on the theory that a
// sentence explains itself. It does not: it explains itself once per row, in
// place of the numbers, and a reader still could not say what separates it from
// the row above. A term plus one definition of it, stated once at the foot of
// the panel, is shorter and actually teachable.
// `unpaired` is not one of the model's verdicts and never will be: it is the
// name for a row whose verdict could not be formed. It is labelled here rather
// than left to the fallback because it has a specific, checkable cause.
export const COMPUTE_VERDICT_LABELS = {
  deferred: "异步转移",
  regression: "计算退化",
  "hidden-cost": "隐性计算成本",
  scheduling: "调度退化",
  "hidden-gain": "隐性计算收益",
  optimized: "计算优化",
  flat: "持平",
  unpaired: "无墙钟基线",
};

// Every verdict is a pair of directions, so its definition states both. Without
// this the labels above are jargon a reader has to take on faith.
export const COMPUTE_VERDICT_GLOSSARY = {
  deferred: "墙钟变快、计算没少 —— 工作被挪到后台，不是省下来了",
  regression: "墙钟变慢、计算也变多 —— 这次是真的更贵",
  "hidden-cost": "墙钟持平、计算变多 —— 只看墙钟看不见",
  scheduling: "墙钟变慢、计算没变 —— 慢在排队，不在算法",
  "hidden-gain": "墙钟持平、计算变少",
  optimized: "墙钟变快、计算也变少 —— 真正省下来的工作",
  flat: "两边都没动",
  unpaired:
    "计算变多，但墙钟这半没有可比的基线 —— 通常是这个 case 的主指标改过名，定不了性",
};

// Measured, not assumed. Across 91 full runs (2026-08-07 → 08-13), restricted to
// consecutive pairs with identical shape and identical `computeStepsExecuted` —
// the same work done twice — per-case `computeMs` moved 16.0% on average against
// the wall clock's 13.6%, and 28% of those pairs crossed 20% on their own. So the
// 1.2x band every row on this panel is sorted by sits *on* the noise floor rather
// than above it, and a reader counting "计算变慢 8" has to know that before the
// count means anything. The wall-clock bands next door already carry the same
// caveat in docs/operations/teable-ee-e2e.md; this panel had no equivalent.
//
// The number lives here rather than beside the band it qualifies because the band
// is a threshold and this is a sentence — but they have to move together. If
// `DEFAULT_COMPUTE_BAND` is ever recalibrated against a per-case noise model,
// this line is wrong the same day.
//
// This is a copy. It is measured in docs/compute-time-observation-spec.md Phase
// 3, which points back here for the same reason: re-measuring changes two places
// and this is the one nobody re-reads.
export const COMPUTE_NOISE_NOTE =
  "注意 相邻两轮之间，同样的活 computeMs 平均就动 16.0%（墙钟 13.6%），1.2x 这道线正压在噪声上：单个刚过线的 case 说明不了什么，成片出现、或者倍数拉得很开的才是信号 —— 小 case 尤其吵，但大 case 也不保险。";

/**
 * Which entry of the key a row is filed under: its verdict, or `unpaired` when
 * the pair could not be formed. Not a verdict — the model returns none for
 * these on purpose, and this names the absence rather than filling it in.
 */
const computeRowKey = (row) =>
  row?.verdict ??
  (Number.isFinite(row?.computeRatio) && !Number.isFinite(row?.wallRatio)
    ? "unpaired"
    : undefined);

/**
 * The reading key for a set of compute rows, or `undefined` when none of them
 * is filed under an entry.
 *
 * Only the entries actually on screen are defined: a glossary of terms the
 * reader cannot see beside it is noise, and it costs bytes the row list needs.
 */
export const formatComputeGlossary = (rows = []) => {
  const shown = [];
  for (const row of rows) {
    const key = computeRowKey(row);
    if (COMPUTE_VERDICT_GLOSSARY[key] && !shown.includes(key)) {
      shown.push(key);
    }
  }
  if (shown.length === 0) {
    return undefined;
  }
  return [
    "墙钟＝用户等待的时间，计算＝引擎为此烧掉的机器时间。两者各自与线上比，同按 1.2x 分档，配对成结论：",
    ...shown.map(
      (verdict) =>
        `· **${COMPUTE_VERDICT_LABELS[verdict]}** ${COMPUTE_VERDICT_GLOSSARY[verdict]}`,
    ),
    COMPUTE_NOISE_NOTE,
  ].join("\n");
};

export const formatComputeLine = (row, chartUrl) => {
  const label = COMPUTE_VERDICT_LABELS[computeRowKey(row)] ?? "无法比较";
  const note = row.shapeChanged
    ? `计算形态从 ${row.baselineShape} 变成 ${row.shape}，不可比`
    : formatComparison("线上", row.baselineComputeMs, row.computeRatio);
  // The verdict is made of two directions and the row printed only one of them,
  // so the label could not be checked against the numbers standing next to it —
  // two rows both reading "慢1.4x" landed on different verdicts for a reason the
  // card kept to itself.
  const wall = formatRatioFactor(row.wallRatio);
  return `- [${row.caseId}](${chartUrlForCase(row.caseId, chartUrl)}) 计算 ${formatMetricSeconds(row.computeMs)} · ${note}${wall ? ` · 墙钟 ${wall}` : ""} · **${label}**`;
};

// One line per case, and one comparison on it. This row is only ever the
// release comparison: V1 has its own panel, and carrying both on every row is
// what made a single row read as two verdicts at once.
//
// Slower than the reference is a red dot, in both panels. A panel lists only
// regressions, so the dot is redundant with its own contents — but the two
// panels are read one under the other, and a row that scans the same way in
// both is worth one repeated character.
export const formatComparisonLine = (row, chartUrl) =>
  `🔴 **[${row.caseId}](${chartUrlForCase(row.caseId, chartUrl)})**：本次 ${formatMetricSeconds(row.v2Value)} · ${formatReleaseNote(row)}`;

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

const releaseStatColumns = (comparison) => ({
  tag: "column_set",
  flex_mode: "none",
  background_style: "grey",
  columns: [
    statColumn("对比", comparison.counts.compared),
    statColumn("慢", comparison.counts.slower),
    statColumn("快", comparison.counts.faster),
    statColumn("无基线", comparison.counts.missingBaseline),
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

// Every card carries them, because a card is forwarded on its own and the reader
// who receives it has no other way back to the run.
const linkButtons = (context) => ({
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
  const severeCount = comparison.tiers.severe;
  const failures = failedCaseIds(payloads);

  const headerTemplate = !comparison.available
    ? "grey"
    : workflowFailed || counts.fail > 0
      ? "red"
      : severeCount > 0 || regressions.length > 0
        ? "orange"
        : "green";
  // Two ways to have no comparison, and only one of them is missing something.
  // A run whose target is the released commit has nothing to compare against by
  // construction; saying "无线上基线" there would send someone looking for a
  // baseline that is not absent, it is this run.
  const headerTitle = comparison.available
    ? `性能回归 · 较线上慢 ${regressions.length} · 严重 ${severeCount}`
    : baseline?.sameCommit
      ? "本次即线上版本 · 不做线上对比"
      : "性能回归 · 无线上基线";

  const compute = buildComputeComparison({
    payloads,
    baseline,
    releaseComparison: comparison,
  });
  // Last of the four: a row with no verdict is a caveat, not a finding, and the
  // three that carry one should not be pushed off the list by it.
  const computeHighlights = [
    ...compute.deferred,
    ...compute.regressions,
    ...compute.hiddenCost,
    ...compute.unpaired,
  ];
  const shownComputeRows = computeHighlights.slice(0, COMPUTE_HIGHLIGHT_LIMIT);
  const computeGlossary = formatComputeGlossary(shownComputeRows);

  const previewRows = regressions.slice(0, REGRESSION_PREVIEW_LIMIT);
  const remainingRows = regressions.slice(REGRESSION_PREVIEW_LIMIT);
  const renderRows = (rows) =>
    rows.map((row) => formatComparisonLine(row, context.chartUrl)).join("\n");
  const enginePanel = buildEngineSummaryPanel({ payloads, context });

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
              : baseline?.sameCommit
                ? `**基线** 本次测的就是线上版本 ${baselineLabel(baseline)}，同版本相比只有跑间波动，不做对比`
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
        // The two comparisons, one panel each. They answer different questions
        // against different references, so they stay in separate boxes — what
        // never worked was putting both verdicts on a single row.
        //
        // Without a baseline there is nothing to fold open: a panel reading
        // "较线上慢 0" would look like a clean run rather than an absent one, so
        // the counts are shown bare and the header above says why.
        ...(comparison.available
          ? [
              collapsiblePanel({
                title: `与线上对比 · 慢 ${regressions.length} · 严重 ${severeCount}`,
                expanded: regressions.length > 0,
                elements: [
                  releaseStatColumns(comparison),
                  {
                    tag: "column_set",
                    flex_mode: "none",
                    background_style: "grey",
                    columns: REGRESSION_TIERS.map((tier) =>
                      statColumn(tier.label, comparison.tiers[tier.key]),
                    ),
                  },
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
                  // Compute time answers what the rows above cannot: whether a
                  // case that got faster actually got cheaper. Its own panel
                  // rather than a column on those rows, because the two
                  // measurements disagree by design — a run can be "慢 0" and
                  // still have burned more machine.
                  ...(compute.available && computeHighlights.length > 0
                    ? [
                        collapsiblePanel({
                          title: `计算时间 · 异步转移 ${compute.counts.deferred} · 计算变慢 ${compute.counts.computeSlower}`,
                          expanded: compute.counts.deferred > 0,
                          elements: [
                            // First, not last. The panel is folded shut until
                            // someone opens it, and what they open it for is a
                            // term they cannot read — so the definitions meet
                            // them at the top rather than under the rows.
                            ...(computeGlossary
                              ? [larkDiv(computeGlossary)]
                              : []),
                            larkDiv(
                              shownComputeRows
                                .map((row) =>
                                  formatComputeLine(row, context.chartUrl),
                                )
                                .join("\n"),
                            ),
                            ...(computeHighlights.length >
                            shownComputeRows.length
                              ? [
                                  larkDiv(
                                    `其余 ${computeHighlights.length - shownComputeRows.length} 个见 Performance Track`,
                                  ),
                                ]
                              : []),
                          ],
                        }),
                      ]
                    : []),
                ],
              }),
            ]
          : [releaseStatColumns(comparison)]),
        ...(enginePanel ? [enginePanel] : []),
        ...(failures.length > 0
          ? [
              collapsiblePanel({
                title: `失败 ${failures.length}`,
                elements: [larkDiv(failures.join("\n"))],
              }),
            ]
          : []),
        { tag: "hr" },
        linkButtons(context),
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
  const compute = buildComputeComparison({
    payloads,
    baseline,
    releaseComparison: comparison,
  });
  const regressions = comparison.regressions;
  const runId = context.runId ?? payloads[0]?.runId ?? "";
  const tierLine = REGRESSION_TIERS.map(
    (tier) => `${tier.label} ${comparison.tiers[tier.key]}`,
  ).join(" · ");

  const heading = [
    "## Teable EE performance summary",
    "",
    `- Target: \`${context.teableRef || "unknown"}\`${context.sha ? ` @ \`${context.sha}\`` : ""}`,
    comparison.available
      ? `- Baseline: ${baselineLabel(comparison.baseline)} · run ${comparison.baseline?.runId}`
      : baseline?.sameCommit
        ? `- Baseline: none — this run measures the released commit itself (${baselineLabel(baseline)}), so a comparison could only report run-to-run noise`
        : "- Baseline: none — no recorded run for the released commit",
    `- Run: ${runId || "unknown"} · Job: ${context.executeResult || "unknown"}`,
    `- Results: ${counts.pass} passed · ${counts.skipped} skipped · ${counts.fail} failed`,
    `- Vs release: ${comparison.counts.compared} compared · ${comparison.counts.slower} slower · ${comparison.counts.faster} faster · ${comparison.counts.missingBaseline} without baseline`,
    // Compute time answers the question the line above cannot: whether a faster
    // wall clock is work saved or work relocated. Reported, never gated — the
    // band is inherited rather than calibrated, see compute-comparison-model.mjs.
    `- Compute vs release: ${compute.counts.compared} compared · ${compute.counts.computeSlower} slower · ${compute.counts.computeFaster} faster · ${compute.counts.deferred} moved not saved · ${compute.counts.shapeChanged} shape changed · ${compute.counts.missingBaseline} without baseline`,
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
  // Bounded on purpose: this block is fixed content, so it is measured against
  // the byte budget before any regression detail is allowed in, and an unbounded
  // list would starve the section above it. The omitted count is printed rather
  // than dropped — a truncated list that does not say so reads as a complete one.
  const computeHighlights = [
    ...compute.deferred,
    ...compute.regressions,
    ...compute.hiddenCost,
    ...compute.unpaired,
  ];
  const shownComputeRows = computeHighlights.slice(0, COMPUTE_HIGHLIGHT_LIMIT);
  const computeSection =
    compute.available && computeHighlights.length > 0
      ? [
          "",
          "### Compute time",
          "",
          // The same reading key the card carries, in the same place: the labels
          // are terms, and a term is only worth the space if its definition
          // arrives before the rows that use it.
          ...(formatComputeGlossary(shownComputeRows)
            ? [formatComputeGlossary(shownComputeRows), ""]
            : []),
          ...shownComputeRows.map((row) =>
            formatComputeLine(row, context.chartUrl),
          ),
          ...(computeHighlights.length > shownComputeRows.length
            ? [
                `- …and ${computeHighlights.length - shownComputeRows.length} more; full numbers in Performance Track.`,
              ]
            : []),
        ]
      : [];
  const footer = [
    // "Nothing was slower" and "nothing could be compared" are different
    // outcomes, and only one of them is a clean run.
    ...(regressions.length === 0
      ? [
          "",
          comparison.available
            ? "No case is slower than the released build."
            : "No comparison was possible.",
        ]
      : []),
    ...computeSection,
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
      `- [${row.caseId}](${chartUrlForCase(row.caseId, context.chartUrl)}) 本次 ${formatMetricSeconds(row.v2Value)} · ${formatReleaseNote(row)}`,
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

// ---------------------------------------------------------------------------
// V2 against V1 — its own panel on the run's one card.
//
// Everything below belongs to the V1 leg of the run and goes when that leg does,
// together with `engine-comparison-model.mjs`. It deliberately repeats none of
// the run's health: timings, trace warnings, failures, and the pass/skip/fail
// counts are stated once, above both panels.
// ---------------------------------------------------------------------------

// "V1 never ran this case" and "V1 ran it and failed" both leave the value
// undefined, and they are not the same thing to the reader.
const engineValueText = (value, result) => {
  if (value !== undefined) {
    return formatMetricSeconds(value);
  }
  if (result === undefined) {
    return "未运行";
  }
  return result === "skipped" ? "skip" : "fail";
};

const engineVerdict = (row) => formatRatioFactor(row.ratio) ?? "无对比";

export const formatEngineLine = (row, chartUrl) =>
  `${row.status === "attention" ? "🔴" : "⚪"} **[${row.caseId}](${chartUrlForCase(row.caseId, chartUrl)})**：V1 ${engineValueText(row.v1Value, row.v1Result)} → V2 ${engineValueText(row.v2Value, row.v2Result)} **${engineVerdict(row)}**`;

/**
 * The V1/V2 panel. Returns `undefined` when the run had no V1 leg — a panel of
 * "无对比" rows says nothing, and this is how the V1 half of the card drops off
 * on its own once V1 is retired.
 */
export const buildEngineSummaryPanel = ({ payloads, context = {} }) => {
  const comparison = buildEngineComparison({ payloads });
  if (!comparison.available) {
    return undefined;
  }

  const { counts, regressions, pending } = comparison;
  const previewRows = regressions.slice(0, REGRESSION_PREVIEW_LIMIT);
  const remainingRows = regressions.slice(REGRESSION_PREVIEW_LIMIT);
  const renderRows = (rows) =>
    rows.map((row) => formatEngineLine(row, context.chartUrl)).join("\n");

  return collapsiblePanel({
    title: `与 V1 对比 · 慢 ${counts.slower}`,
    // Folded open only on its own bad news. The card leads with the release
    // comparison, and two panels open at once is a card nobody reads.
    expanded: counts.slower > 0,
    elements: [
      {
        tag: "column_set",
        flex_mode: "none",
        background_style: "grey",
        columns: [
          statColumn("对比", counts.compared),
          statColumn("慢", counts.slower),
          statColumn("快", counts.faster),
          statColumn("待对比", counts.pending),
        ],
      },
      larkDiv(previewRows.length > 0 ? renderRows(previewRows) : "无"),
      ...(remainingRows.length > 0
        ? [
            collapsiblePanel({
              title: `其余 ${remainingRows.length}`,
              elements: [larkDiv(renderRows(remainingRows))],
            }),
          ]
        : []),
      // Cases V2 won are a count, not a list: there is nothing to act on, and
      // at 260 cases the rows would bury the ones there is.
      ...(counts.pending > 0
        ? [
            collapsiblePanel({
              title: `待对比 ${counts.pending}`,
              elements: [
                larkDiv(renderRows(pending.slice(0, REGRESSION_PREVIEW_LIMIT))),
                ...(counts.pending > REGRESSION_PREVIEW_LIMIT
                  ? [
                      larkDiv(
                        `其余 ${counts.pending - REGRESSION_PREVIEW_LIMIT} 项`,
                      ),
                    ]
                  : []),
              ],
            }),
          ]
        : []),
    ],
  });
};

/**
 * The V1/V2 section of the GitHub summary. Returns `undefined` on a run with no
 * V1 leg, for the same reason the card does.
 */
export const buildEngineSummaryMarkdown = ({
  payloads,
  context = {},
  maxBytes = DEFAULT_GITHUB_SUMMARY_MAX_BYTES,
}) => {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(
      `maxBytes must be a positive integer, received ${maxBytes}`,
    );
  }

  const comparison = buildEngineComparison({ payloads });
  if (!comparison.available) {
    return undefined;
  }

  const { counts, regressions } = comparison;
  const heading = [
    "## V2 vs V1",
    "",
    `- Compared: ${counts.compared} · ${counts.slower} slower · ${counts.faster} faster or equal · ${counts.pending} not compared`,
    "",
    "### Slower than V1",
    "",
  ];
  const footer = [
    ...(counts.slower === 0 ? ["", "No case is slower than V1."] : []),
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
  for (const row of regressions) {
    const candidate = [
      ...detailLines,
      `- [${row.caseId}](${chartUrlForCase(row.caseId, context.chartUrl)}) V1 ${engineValueText(row.v1Value, row.v1Result)} → V2 ${engineValueText(row.v2Value, row.v2Result)} ${engineVerdict(row)}`,
    ];
    if (
      markdownBytes(render(candidate, regressions.length - candidate.length)) >
      maxBytes
    ) {
      break;
    }
    detailLines.push(candidate.at(-1));
  }

  const markdown = render(detailLines, regressions.length - detailLines.length);
  if (markdownBytes(markdown) > maxBytes) {
    throw new Error(
      `GitHub engine summary fixed content exceeds ${maxBytes} bytes; increase the configured budget`,
    );
  }
  return markdown;
};
