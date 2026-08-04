import assert from "node:assert/strict";
import {
  buildPerfSummaryCard,
  buildPerfSummaryMarkdown,
  formatEngineNote,
  formatDuration,
  formatMetricSeconds,
  resolveRunTimingFromJobs,
  resultCounts,
} from "./perf-run-summary-model.mjs";
import {
  buildPerformanceTrackResultRecord,
  chunkPerformanceTrackWriteRecords,
  createInMemoryPerformanceTrackAdapter,
  createPerformanceTrackRecordModule,
  createTeablePerformanceTrackAdapter,
  DEFAULT_PERFORMANCE_TRACK_WRITE_MAX_BYTES,
} from "./performance-track-record-model.mjs";
import { PERFORMANCE_TRACK_CONTRACT_FIELDS } from "./performance-track-contract.fixture.mjs";

assert.equal(formatDuration(undefined), "-");
assert.equal(formatDuration(999), "999ms");
assert.equal(formatDuration(12_345), "12s");
assert.equal(formatDuration(65_000), "1m05s");
// A duration that rounds up through a minute boundary must carry into the
// minutes rather than render a 60-second remainder ("1m60s", "59m60s").
assert.equal(formatDuration(119_700), "2m00s");
assert.equal(formatDuration(3_599_600), "60m00s");
assert.equal(formatMetricSeconds(undefined), "skip");
assert.equal(formatMetricSeconds(50), "50ms");
assert.equal(formatMetricSeconds(1234), "1.23s");

const jobs = [
  {
    name: "Prepare perf seed DB",
    started_at: "2026-06-21T00:00:00.000Z",
    completed_at: "2026-06-21T00:01:00.000Z",
    steps: [
      {
        name: "Publish seed database cache hit summary",
        conclusion: "success",
      },
      { name: "Build perf seed DB", conclusion: "skipped" },
    ],
  },
  {
    name: "Run perf cases (v1)",
    started_at: "2026-06-21T00:01:00.000Z",
    completed_at: "2026-06-21T00:03:00.000Z",
  },
  {
    name: "Run perf cases (v2-sync-default)",
    started_at: "2026-06-21T00:01:00.000Z",
    completed_at: "2026-06-21T00:02:00.000Z",
  },
  {
    name: "Run perf cases (v2-hybrid-computed)",
    started_at: "2026-06-21T00:02:00.000Z",
    completed_at: "2026-06-21T00:04:00.000Z",
  },
];

assert.deepEqual(resolveRunTimingFromJobs(jobs), {
  totalMs: 240_000,
  seedMs: 60_000,
  seedCache: "命中",
  v1Ms: 120_000,
  v2Ms: undefined,
  v2SyncMs: 60_000,
  v2HybridMs: 120_000,
});

const shardedJobs = [
  jobs[0],
  {
    name: "Run perf cases (v1-shard-1-of-4)",
    started_at: "2026-06-21T00:01:00.000Z",
    completed_at: "2026-06-21T00:03:00.000Z",
  },
  {
    name: "Run perf cases (v1-shard-2-of-4)",
    started_at: "2026-06-21T00:01:10.000Z",
    completed_at: "2026-06-21T00:02:30.000Z",
  },
  {
    name: "Run perf cases (v1-shard-3-of-4)",
    started_at: "2026-06-21T00:01:05.000Z",
    completed_at: "2026-06-21T00:04:00.000Z",
  },
  {
    name: "Run perf cases (v1-shard-4-of-4)",
    started_at: "2026-06-21T00:01:15.000Z",
    completed_at: "2026-06-21T00:03:30.000Z",
  },
  {
    name: "Run perf cases (v2-sync-default-shard-1-of-4)",
    started_at: "2026-06-21T00:01:00.000Z",
    completed_at: "2026-06-21T00:02:30.000Z",
  },
  {
    name: "Run perf cases (v2-sync-default-shard-2-of-4)",
    started_at: "2026-06-21T00:01:20.000Z",
    completed_at: "2026-06-21T00:03:00.000Z",
  },
  {
    name: "Run perf cases (v2-sync-default-shard-3-of-4)",
    started_at: "2026-06-21T00:01:10.000Z",
    completed_at: "2026-06-21T00:02:40.000Z",
  },
  {
    name: "Run perf cases (v2-sync-default-shard-4-of-4)",
    started_at: "2026-06-21T00:01:15.000Z",
    completed_at: "2026-06-21T00:02:50.000Z",
  },
  {
    name: "Run perf cases (v2-hybrid-computed-shard-1-of-4)",
    started_at: "2026-06-21T00:02:00.000Z",
    completed_at: "2026-06-21T00:04:30.000Z",
  },
  {
    name: "Run perf cases (v2-hybrid-computed-shard-2-of-4)",
    started_at: "2026-06-21T00:02:15.000Z",
    completed_at: "2026-06-21T00:05:00.000Z",
  },
  {
    name: "Run perf cases (v2-hybrid-computed-shard-3-of-4)",
    started_at: "2026-06-21T00:02:05.000Z",
    completed_at: "2026-06-21T00:04:40.000Z",
  },
  {
    name: "Run perf cases (v2-hybrid-computed-shard-4-of-4)",
    started_at: "2026-06-21T00:02:10.000Z",
    completed_at: "2026-06-21T00:04:50.000Z",
  },
];

assert.deepEqual(resolveRunTimingFromJobs(shardedJobs), {
  totalMs: 300_000,
  seedMs: 60_000,
  seedCache: "命中",
  v1Ms: 180_000,
  v2Ms: undefined,
  v2SyncMs: 120_000,
  v2HybridMs: 180_000,
});

const shardedSeedJobs = [
  {
    name: "Prepare perf seed DB (shard-1-of-4)",
    started_at: "2026-06-21T00:00:00.000Z",
    completed_at: "2026-06-21T00:01:00.000Z",
    steps: [
      {
        name: "Publish seed database cache hit summary",
        conclusion: "success",
      },
      { name: "Build perf seed DB", conclusion: "skipped" },
    ],
  },
  {
    name: "Prepare perf seed DB (shard-2-of-4)",
    started_at: "2026-06-21T00:00:10.000Z",
    completed_at: "2026-06-21T00:01:20.000Z",
    steps: [
      {
        name: "Publish seed database cache hit summary",
        conclusion: "skipped",
      },
      { name: "Build perf seed DB", conclusion: "success" },
    ],
  },
];

assert.deepEqual(resolveRunTimingFromJobs(shardedSeedJobs), {
  totalMs: 80_000,
  seedMs: 80_000,
  seedCache: "部分重建",
  v1Ms: undefined,
  v2Ms: undefined,
  v2SyncMs: undefined,
  v2HybridMs: undefined,
});

const payloads = [
  {
    caseId: "formula/fast",
    engine: "v1",
    result: "pass",
    durationMs: 1000,
    thresholds: [{ metric: "durationMs", actual: 1000, passed: true }],
  },
  {
    caseId: "formula/fast",
    engine: "v2",
    result: "pass",
    durationMs: 500,
    thresholds: [{ metric: "durationMs", actual: 500, passed: true }],
  },
  {
    caseId: "lookup/regressed",
    engine: "v1",
    result: "pass",
    durationMs: 1000,
    thresholds: [{ metric: "readyMs", actual: 1000, passed: true }],
  },
  {
    caseId: "lookup/regressed",
    engine: "v2",
    result: "pass",
    durationMs: 1400,
    thresholds: [{ metric: "readyMs", actual: 1400, passed: true }],
    details: {
      observability: {
        traces: {
          missingFetchCount: 4,
          wastedFetchMs: 80_000,
          fetchConcurrency: 2,
        },
      },
    },
  },
  {
    caseId: "lookup/slightly-slower",
    engine: "v1",
    result: "pass",
    durationMs: 1000,
    thresholds: [{ metric: "readyMs", actual: 1000, passed: true }],
  },
  {
    caseId: "lookup/slightly-slower",
    engine: "v2",
    result: "pass",
    durationMs: 1100,
    thresholds: [{ metric: "readyMs", actual: 1100, passed: true }],
  },
  {
    caseId: "field/fail",
    engine: "v2",
    result: "fail",
    durationMs: 200,
    thresholds: [{ metric: "durationMs", actual: 200, passed: false }],
  },
  {
    caseId: "smoke/skip",
    engine: "v2",
    result: "skipped",
    thresholds: [],
  },
];

assert.deepEqual(resultCounts(payloads), { pass: 6, skipped: 1, fail: 1 });

const releaseBaseline = (entries) => ({
  commit: "e0dae6da17f302d3def079b095c5151af3b3581f",
  release: "release.2026-07-30T06-45-38Z.2429",
  runId: "30520608995",
  runAttempt: 1,
  runUrl: "https://github.example/run/30520608995",
  values: Object.fromEntries(
    entries.map(([caseId, engine, value, metric]) => [
      `${caseId}::${engine}`,
      { value, metric },
    ]),
  ),
});

const baseline = releaseBaseline([
  ["formula/fast", "v1", 1000, "durationMs"],
  ["formula/fast", "v2", 500, "durationMs"],
  ["lookup/regressed", "v1", 1000, "readyMs"],
  ["lookup/regressed", "v2", 700, "readyMs"],
  ["lookup/slightly-slower", "v1", 1000, "readyMs"],
  ["lookup/slightly-slower", "v2", 850, "readyMs"],
  ["field/fail", "v2", 100, "durationMs"],
]);

const card = buildPerfSummaryCard({
  payloads,
  baseline,
  timings: resolveRunTimingFromJobs(jobs),
  context: {
    chartUrl: "https://charts.example",
    executeResult: "success",
    runId: "123",
    runUrl: "https://github.example/run/123",
    sha: "abcdef0",
    teableRef: "main",
    teableResultsUrl: "https://teable.example/results",
  },
});

assert.equal(card.msg_type, "interactive");
// A failed case outranks the regression colour.
assert.equal(card.card.header.template, "red");
assert.equal(card.card.header.title.content, "性能回归 · 较线上慢 2 · 严重 1");
assert.match(card.card.elements[0].text.content, /6✓ 1⊘ 1✗/);
// The baseline itself is on the card, so a comparison against the wrong build
// is visible rather than inferred.
assert.match(
  card.card.elements[0].text.content,
  /release\.2026-07-30T06-45-38Z\.2429 · e0dae6d/,
);
assert.match(card.card.elements[0].text.content, /run 30520608995/);
assert.match(card.card.elements[1].text.content, /Trace 抓取浪费 40s/);
assert.match(
  card.card.elements[2].columns[3].elements[0].content,
  /hybrid 2m00s/,
);
assert.equal(
  card.card.elements.at(-1).actions[0].url,
  "https://github.example/run/123",
);
assert.equal(
  card.card.elements.at(-1).actions[2].url,
  "https://charts.example",
);

const statColumns = card.card.elements.filter(
  (element) => element.tag === "column_set",
);
assert.deepEqual(
  statColumns[1].columns.map((column) => column.elements[0].content),
  ["**对比** 3", "**慢** 2", "**快** 0", "**无基线** 0"],
);
// V2 over V1 per band. lookup/regressed doubled while its V1 stayed flat, so
// the severe band reads 1 against 0 — engine-side, not environmental.
assert.deepEqual(
  statColumns[2].columns.map((column) =>
    column.elements.map((element) => element.content),
  ),
  [
    ["**>2x** 1", "V1 0"],
    ["**>50%** 0", "V1 0"],
    ["**>20%** 1", "V1 0"],
  ],
);

const panels = card.card.elements.filter(
  (element) => element.tag === "collapsible_panel",
);
assert.equal(panels[0].header.title.content, "**较线上慢 2**");
assert.equal(panels[0].expanded, true);
assert.match(
  panels[0].elements[0].text.content,
  /🔴 \*\*\[lookup\/regressed\]\(https:\/\/charts\.example#lookup\/regressed\)\*\*\n线上 0\.70s → 1\.40s \*\*\+100%\*\* · V1 1\.00s 慢1\.4x/,
);
assert.match(panels[0].elements[0].text.content, /lookup\/slightly-slower/);
// A ratio that rounds to 1.0x is a tie, not a direction.
assert.equal(
  formatEngineNote({ v1Value: 1_010, v2Value: 1_000, engineRatio: 1.01 }),
  "V1 1.01s 持平",
);
assert.equal(
  formatEngineNote({ v1Value: 1_000, v2Value: 1_010, engineRatio: 0.99 }),
  "V1 1.00s 持平",
);
// A case that matched the released build is not news.
assert.doesNotMatch(JSON.stringify(card), /formula\/fast/);
// field/fail measured 200ms against a 100ms baseline, but it failed, so it
// belongs in the failure panel rather than the regression list.
assert.equal(panels.at(-1).header.title.content, "**失败 1**");
assert.match(panels.at(-1).elements[0].text.content, /field\/fail \(v2\)/);

// The regression the V1/V2 report could never show: slower than the released
// build while still ahead of V1. It carries ⚠️ instead of 🔴, and the panel
// title counts how many of them there are.
const hiddenCard = buildPerfSummaryCard({
  payloads: [
    {
      caseId: "lookup/depth5",
      engine: "v1",
      result: "pass",
      thresholds: [{ metric: "readyMs", actual: 2_100, passed: true }],
    },
    {
      caseId: "lookup/depth5",
      engine: "v2",
      result: "pass",
      thresholds: [{ metric: "readyMs", actual: 1_544, passed: true }],
    },
  ],
  timings: {},
  baseline: releaseBaseline([
    ["lookup/depth5", "v1", 2_000, "readyMs"],
    ["lookup/depth5", "v2", 321, "readyMs"],
  ]),
  context: { chartUrl: "https://charts.example", executeResult: "success" },
});
const [hiddenPanel] = hiddenCard.card.elements.filter(
  (element) => element.tag === "collapsible_panel",
);
assert.equal(hiddenPanel.header.title.content, "**较线上慢 1   ⚠️1**");
assert.match(
  hiddenPanel.elements[0].text.content,
  /⚠️ \*\*\[lookup\/depth5\].*\n线上 0\.32s → 1\.54s \*\*\+381%\*\* · V1 2\.10s 快1\.4x/,
);
assert.match(
  buildPerfSummaryMarkdown({
    payloads: hiddenCard ? [] : [],
    baseline: undefined,
    context: {},
  }),
  /Baseline: none/,
);

// No baseline must say so. Reporting "较线上慢 0" would read as a clean run.
const noBaselineCard = buildPerfSummaryCard({
  payloads,
  timings: {},
  context: { chartUrl: "https://charts.example", executeResult: "success" },
});
assert.equal(noBaselineCard.card.header.template, "grey");
assert.equal(noBaselineCard.card.header.title.content, "性能回归 · 无线上基线");
assert.match(
  noBaselineCard.card.elements[0].text.content,
  /未找到线上版本的历史结果/,
);
assert.doesNotMatch(JSON.stringify(noBaselineCard), /较线上慢 0/);

// A case V2 has always lost stays out of the regression count and gets its own
// panel: it is a known gap, not something this run introduced.
const residentCard = buildPerfSummaryCard({
  payloads: [
    {
      caseId: "duplicate-table/50k-20f",
      engine: "v1",
      result: "pass",
      thresholds: [{ metric: "durationMs", actual: 20_700, passed: true }],
    },
    {
      caseId: "duplicate-table/50k-20f",
      engine: "v2",
      result: "pass",
      thresholds: [{ metric: "durationMs", actual: 27_722, passed: true }],
    },
  ],
  timings: {},
  baseline: releaseBaseline([
    ["duplicate-table/50k-20f", "v1", 20_000, "durationMs"],
    ["duplicate-table/50k-20f", "v2", 27_000, "durationMs"],
  ]),
  context: { chartUrl: "https://charts.example", executeResult: "success" },
});
assert.equal(
  residentCard.card.header.title.content,
  "性能回归 · 较线上慢 0 · 严重 0",
);
assert.equal(residentCard.card.header.template, "green");
const residentPanels = residentCard.card.elements.filter(
  (element) => element.tag === "collapsible_panel",
);
assert.equal(residentPanels[1].header.title.content, "**V2<V1 常驻 1**");
// ⚪, not 🔴: the case is a known V2 gap, not something this run regressed. A
// red dot here read as an alarm beside cases that had improved against the
// release.
assert.match(
  residentPanels[1].elements[0].text.content,
  /⚪ \*\*\[duplicate-table\/50k-20f\][\s\S]*V1 20\.70s 慢1\.3x/,
);

// A measured 0 ms yields no ratio in either direction. It must not be reported
// as a regression, and it must not be counted as a missing baseline either.
const zeroPayloads = ["v1", "v2"].map((engine) => ({
  caseId: "record-read/zero-overhead",
  engine,
  result: "pass",
  durationMs: 29_512,
  thresholds: [
    { metric: "getRecordsQueryOverheadMs", actual: 0, passed: true },
  ],
}));
const zeroCard = buildPerfSummaryCard({
  payloads: zeroPayloads,
  timings: {},
  baseline: releaseBaseline([
    ["record-read/zero-overhead", "v2", 5, "getRecordsQueryOverheadMs"],
  ]),
  context: { chartUrl: "https://charts.example", executeResult: "success" },
});
assert.equal(
  zeroCard.card.header.title.content,
  "性能回归 · 较线上慢 0 · 严重 0",
);
assert.deepEqual(
  zeroCard.card.elements
    .filter((element) => element.tag === "column_set")[1]
    .columns.map((column) => column.elements[0].content),
  ["**对比** 0", "**慢** 0", "**快** 0", "**无基线** 0"],
);

const manyRegressionPayloads = Array.from({ length: 12 }, (_, index) => [
  {
    caseId: `record-read/regressed-${index}`,
    engine: "v1",
    result: "pass",
    thresholds: [{ metric: "durationMs", actual: 1_000, passed: true }],
  },
  {
    caseId: `record-read/regressed-${index}`,
    engine: "v2",
    result: "pass",
    thresholds: [{ metric: "durationMs", actual: 2_000 + index, passed: true }],
  },
]).flat();
const manyRegressionCard = buildPerfSummaryCard({
  payloads: manyRegressionPayloads,
  timings: {},
  baseline: releaseBaseline(
    Array.from({ length: 12 }, (_, index) => [
      `record-read/regressed-${index}`,
      "v2",
      1_000,
      "durationMs",
    ]),
  ),
  context: { chartUrl: "https://charts.example", executeResult: "success" },
});
const [manyRegressionPanel] = manyRegressionCard.card.elements.filter(
  (element) => element.tag === "collapsible_panel",
);
// Worst first, so the ten expanded rows are the ten largest regressions.
assert.match(
  manyRegressionPanel.elements[0].text.content,
  /record-read\/regressed-11/,
);
assert.doesNotMatch(
  manyRegressionPanel.elements[0].text.content,
  /record-read\/regressed-1\b/,
);
assert.equal(
  manyRegressionPanel.elements[1].header.title.content,
  "**其余 2**",
);
assert.equal(manyRegressionPanel.elements[1].expanded, false);
assert.match(
  manyRegressionPanel.elements[1].elements[0].text.content,
  /record-read\/regressed-1\b/,
);

const markdown = buildPerfSummaryMarkdown({
  payloads,
  baseline,
  context: {
    chartUrl: "https://charts.example",
    executeResult: "success",
    runId: "123",
    runUrl: "https://github.example/run/123",
    sha: "abcdef0",
    teableRef: "main",
    teableResultsUrl: "https://teable.example/results",
  },
});
assert.match(markdown, /lookup\/regressed/);
assert.match(markdown, /Baseline: release\.2026-07-30T06-45-38Z\.2429/);
assert.match(markdown, /Bands: >2x 1 \(V1 0\)/);
assert.match(markdown, /Every regression here is also slower than V1/);
assert.doesNotMatch(markdown, /formula\/fast/);
assert.match(markdown, /\[CI run\]\(https:\/\/github\.example\/run\/123\)/);

const noBaselineMarkdown = buildPerfSummaryMarkdown({
  payloads,
  context: { chartUrl: "https://charts.example" },
});
assert.match(noBaselineMarkdown, /Baseline: none/);
assert.doesNotMatch(noBaselineMarkdown, /Bands:/);
assert.match(noBaselineMarkdown, /No comparison was possible/);

// With nothing slower, "every regression here is also slower than V1" is a
// claim about an empty set.
const cleanMarkdown = buildPerfSummaryMarkdown({
  payloads: [
    {
      caseId: "smoke/auth-user",
      engine: "v2",
      result: "pass",
      thresholds: [{ metric: "p95Ms", actual: 8, passed: true }],
    },
  ],
  baseline: releaseBaseline([["smoke/auth-user", "v2", 13, "p95Ms"]]),
  context: {},
});
assert.match(cleanMarkdown, /No case is slower than the released build/);
assert.doesNotMatch(cleanMarkdown, /Every regression here/);

// A thousand cases that all match the release must not inflate the card past
// what Feishu will render.
const manyFastPayloads = Array.from({ length: 1_000 }, (_, index) => [
  {
    caseId: `record-read/fast-${index}`,
    engine: "v1",
    result: "pass",
    thresholds: [{ metric: "durationMs", actual: 2_000, passed: true }],
  },
  {
    caseId: `record-read/fast-${index}`,
    engine: "v2",
    result: "pass",
    thresholds: [{ metric: "durationMs", actual: 500, passed: true }],
  },
]).flat();
const manyFastCard = buildPerfSummaryCard({
  payloads: manyFastPayloads,
  timings: {},
  baseline: releaseBaseline(
    Array.from({ length: 1_000 }, (_, index) => [
      `record-read/fast-${index}`,
      "v2",
      1_000,
      "durationMs",
    ]),
  ),
  context: { chartUrl: "https://charts.example", executeResult: "success" },
});
const manyFastCardJson = JSON.stringify(manyFastCard);
assert.ok(Buffer.byteLength(manyFastCardJson, "utf8") < 100 * 1024);
assert.doesNotMatch(manyFastCardJson, /record-read\/fast-/);
assert.match(manyFastCardJson, /\*\*快\*\* 1000/);

const boundedMarkdown = buildPerfSummaryMarkdown({
  payloads: manyRegressionPayloads,
  maxBytes: 1_024,
  baseline: releaseBaseline(
    Array.from({ length: 12 }, (_, index) => [
      `record-read/regressed-${index}`,
      "v2",
      1_000,
      "durationMs",
    ]),
  ),
  context: { chartUrl: "https://charts.example" },
});
assert.ok(Buffer.byteLength(boundedMarkdown, "utf8") <= 1_024);
assert.match(boundedMarkdown, /Truncated \d+ detail rows/);

const outageCard = buildPerfSummaryCard({
  payloads: [
    {
      caseId: "smoke/auth-user",
      engine: "v2",
      result: "pass",
      durationMs: 1000,
      thresholds: [{ metric: "durationMs", actual: 1000, passed: true }],
      details: {
        observability: {
          traces: {
            traceRefCount: 3,
            selectedTraceCount: 3,
            savedTraceCount: 0,
            failedTraceCount: 0,
            skippedTraceCount: 3,
            missingFetchCount: 0,
            wastedFetchMs: 0,
            traceFetchSkippedReason:
              "Trace service unavailable; skipped Jaeger fetch: connect ECONNREFUSED 127.0.0.1:4318",
          },
        },
      },
    },
  ],
  timings: resolveRunTimingFromJobs(jobs),
  context: {
    chartUrl: "https://charts.example",
    executeResult: "success",
    runId: "456",
    runUrl: "https://github.example/run/456",
    sha: "abcdef1",
    teableRef: "main",
    teableResultsUrl: "https://teable.example/results",
  },
});

const outageText = outageCard.card.elements[1].text.content;
assert.match(outageText, /Trace 服务不可用，本轮跳过 Trace 抓取/);
// Point the reader at the two steps that own the trace host now that it is the
// report job's own container, not a service someone else operates.
assert.match(outageText, /report-local Jaeger/);
assert.doesNotMatch(outageText, /observability-stack/);
assert.doesNotMatch(outageText, /OTLP/);
assert.doesNotMatch(JSON.stringify(outageCard.card.elements), /Trace 抓取浪费/);

const resultRecord = buildPerformanceTrackResultRecord({
  payload: {
    caseId: "formula/fast",
    title: "Fast formula",
    runId: "payload-run",
    engine: "v2",
    result: "pass",
    startedAt: "2026-07-14T01:00:00.000Z",
    finishedAt: "2026-07-14T01:00:01.000Z",
    durationMs: 1000,
    metrics: { readyMs: 900 },
    thresholds: [{ metric: "readyMs", actual: 900, max: 1200, passed: true }],
    phases: [{ name: "ready", durationMs: 900 }],
    details: {
      observability: {
        traces: {
          traceRefCount: 2,
          savedTraceCount: 1,
          failedTraceCount: 0,
          manifestPath: "traces/formula-fast-v2/manifest.json",
        },
      },
    },
  },
  traceManifest: {
    enabled: true,
    traceRefCount: 2,
    savedTraceCount: 1,
    failedTraceCount: 0,
    manifestPath: "traces/formula-fast-v2/manifest.json",
  },
  summaryMarkdown: "# Formula fast",
  context: {
    runId: "901",
    runAttempt: "2",
    engine: "v2",
    jobId: "execute-v2",
    workflow: "Teable EE perf",
    teableEeRef: "main",
    commitSha: "abcdef123",
    artifactName: "teable-ee-e2e-perf-v2-901-2",
    artifactUrl: "https://github.example/artifact/1",
    runUrl: "https://github.example/run/901",
    traceUrl: "https://jaeger.example/trace/abc",
  },
});
assert.equal(resultRecord.runKey, "901-2-formula/fast-v2");
assert.deepEqual(
  {
    runKey: resultRecord.fields["Run Key"],
    runId: resultRecord.fields["Run ID"],
    runAttempt: resultRecord.fields["Run Attempt"],
    caseId: resultRecord.fields["Case ID"],
    metric: resultRecord.fields["Primary Metric"],
    metricValue: resultRecord.fields["Primary Metric Value"],
    traceRefCount: resultRecord.fields["Trace Ref Count"],
    manifestPath: resultRecord.fields["Manifest Path"],
  },
  {
    runKey: "901-2-formula/fast-v2",
    runId: "901",
    runAttempt: 2,
    caseId: "formula/fast",
    metric: "readyMs",
    metricValue: 900,
    traceRefCount: 2,
    manifestPath: "traces/formula-fast-v2/manifest.json",
  },
);

const writeAdapter = createInMemoryPerformanceTrackAdapter({
  fields: PERFORMANCE_TRACK_CONTRACT_FIELDS,
});
const writeModule = createPerformanceTrackRecordModule(writeAdapter);
await writeModule.assertContract();
await assert.rejects(
  createPerformanceTrackRecordModule(
    createInMemoryPerformanceTrackAdapter({ fields: [{ name: "Run Key" }] }),
  ).assertContract(),
  /Missing Teable report fields: Run ID/,
);
assert.deepEqual(
  await writeModule.upsertResult({
    fields: resultRecord.fields,
  }),
  { action: "created", recordId: "rec-memory-1" },
);
assert.deepEqual(
  await writeModule.upsertResult({
    fields: { ...resultRecord.fields, Result: "fail" },
  }),
  { action: "updated", recordId: "rec-memory-1" },
);
assert.equal(writeAdapter.snapshot().length, 1);
assert.equal(writeAdapter.snapshot()[0].fields.Result, "fail");
await assert.rejects(
  writeModule.upsertResult({ fields: { Result: "pass" } }),
  /requires a non-empty "Run Key" field/,
);
await assert.rejects(
  writeModule.upsertResult({ fields: { "Run Key": "   " } }),
  /requires a non-empty "Run Key" field/,
);

const performanceTrackWriteBodyBytes = (records) =>
  Buffer.byteLength(
    JSON.stringify({ fieldKeyType: "name", typecast: true, records }),
  );
const performanceTrackWriteRecords = [
  { fields: { "Run Key": "run-1", Result: "pass" } },
  { fields: { "Run Key": "run-2", Result: "pass" } },
  { fields: { "Run Key": "run-3", Result: "pass" } },
];
const twoPerformanceTrackRecordsMaxBytes = performanceTrackWriteBodyBytes(
  performanceTrackWriteRecords.slice(0, 2),
);
assert.deepEqual(
  chunkPerformanceTrackWriteRecords(
    performanceTrackWriteRecords,
    twoPerformanceTrackRecordsMaxBytes,
  ),
  [
    performanceTrackWriteRecords.slice(0, 2),
    performanceTrackWriteRecords.slice(2),
  ],
);
assert.equal(DEFAULT_PERFORMANCE_TRACK_WRITE_MAX_BYTES, 512 * 1024);
await assert.rejects(
  async () =>
    chunkPerformanceTrackWriteRecords(
      [performanceTrackWriteRecords[0]],
      performanceTrackWriteBodyBytes([performanceTrackWriteRecords[0]]) - 1,
    ),
  /Performance Track write record run-1 exceeds/,
);

const batchWriteAdapter = createInMemoryPerformanceTrackAdapter({
  fields: PERFORMANCE_TRACK_CONTRACT_FIELDS,
  records: [
    {
      id: "rec-existing-batch",
      fields: {
        "Run Key": "901-3-formula/existing-v2",
        "Run ID": "901",
        "Run Attempt": 3,
        Result: "pass",
      },
    },
    {
      id: "rec-other-run",
      fields: {
        "Run Key": "900-1-formula/existing-v2",
        "Run ID": "900",
        "Run Attempt": 1,
        Result: "pass",
      },
    },
  ],
});
const batchWriteModule = createPerformanceTrackRecordModule(batchWriteAdapter);
const batchWriteResult = await batchWriteModule.upsertResults({
  runId: "901",
  runAttempt: "3",
  records: [
    {
      fields: {
        "Run Key": "901-3-formula/existing-v2",
        "Run ID": "901",
        "Run Attempt": 3,
        Result: "fail",
      },
    },
    {
      fields: {
        "Run Key": "901-3-formula/new-v2",
        "Run ID": "901",
        "Run Attempt": 3,
        Result: "pass",
      },
    },
  ],
});
assert.deepEqual(batchWriteResult, {
  total: 2,
  updated: [
    {
      runKey: "901-3-formula/existing-v2",
      recordId: "rec-existing-batch",
    },
  ],
  created: [{ runKey: "901-3-formula/new-v2", recordId: "rec-memory-3" }],
});
assert.equal(batchWriteAdapter.snapshot().length, 3);
assert.equal(
  batchWriteAdapter.snapshot().find(({ id }) => id === "rec-existing-batch")
    .fields.Result,
  "fail",
);
assert.equal(
  batchWriteAdapter.snapshot().find(({ id }) => id === "rec-other-run").fields
    .Result,
  "pass",
);
await assert.rejects(
  batchWriteModule.upsertResults({
    runId: "901",
    runAttempt: 3,
    records: [
      {
        fields: {
          "Run Key": "duplicate",
          "Run ID": "901",
          "Run Attempt": 3,
        },
      },
      {
        fields: {
          "Run Key": "duplicate",
          "Run ID": "901",
          "Run Attempt": 3,
        },
      },
    ],
  }),
  /Duplicate desired Run Key: duplicate/,
);

const updateRequests = [];
const updateTrack = createPerformanceTrackRecordModule(
  createTeablePerformanceTrackAdapter({
    tableId: "tbl-performance-track",
    request: async (request) => {
      updateRequests.push(request);
      if (request.method === "GET") {
        return {
          records: [
            {
              id: "rec-existing",
              fields: { "Run Key": "run-existing" },
            },
          ],
        };
      }
      if (request.method === "PATCH") {
        return {};
      }
      throw new Error(`Unexpected request ${request.method} ${request.path}`);
    },
  }),
);
assert.deepEqual(
  await updateTrack.upsertResult({
    fields: { "Run Key": "run-existing", Result: "fail" },
  }),
  { action: "updated", recordId: "rec-existing" },
);
const updateQuery = new URL(updateRequests[0].path, "https://teable.example");
assert.equal(updateRequests[0].method, "GET");
assert.equal(updateQuery.pathname, "/table/tbl-performance-track/record");
assert.equal(updateQuery.searchParams.get("fieldKeyType"), "name");
assert.equal(updateQuery.searchParams.get("take"), "1");
assert.equal(updateQuery.searchParams.get("projection"), "Run Key");
assert.deepEqual(JSON.parse(updateQuery.searchParams.get("filter")), {
  conjunction: "and",
  filterSet: [
    {
      fieldId: "fldBtUJjGxgsPWsqLua",
      operator: "is",
      value: "run-existing",
    },
  ],
});
assert.deepEqual(updateRequests[1], {
  method: "PATCH",
  path: "/table/tbl-performance-track/record",
  body: {
    fieldKeyType: "name",
    typecast: true,
    records: [
      {
        id: "rec-existing",
        fields: { "Run Key": "run-existing", Result: "fail" },
      },
    ],
  },
});

const createRequests = [];
const createTrack = createPerformanceTrackRecordModule(
  createTeablePerformanceTrackAdapter({
    tableId: "tbl-performance-track",
    request: async (request) => {
      createRequests.push(request);
      if (request.method === "GET") {
        return { records: [] };
      }
      if (request.method === "POST") {
        return { records: [{ id: "rec-created" }] };
      }
      throw new Error(`Unexpected request ${request.method} ${request.path}`);
    },
  }),
);
assert.deepEqual(
  await createTrack.upsertResult({
    fields: { "Run Key": "run-created", Result: "pass" },
  }),
  { action: "created", recordId: "rec-created" },
);
assert.deepEqual(createRequests[1], {
  method: "POST",
  path: "/table/tbl-performance-track/record",
  body: {
    fieldKeyType: "name",
    typecast: true,
    records: [
      {
        fields: { "Run Key": "run-created", Result: "pass" },
      },
    ],
  },
});

const batchRequests = [];
const batchTrack = createPerformanceTrackRecordModule(
  createTeablePerformanceTrackAdapter({
    tableId: "tbl-performance-track",
    request: async (request) => {
      batchRequests.push(request);
      if (request.method === "GET") {
        return {
          records: [
            {
              id: "rec-batch-existing",
              fields: { "Run Key": "902-1-case-existing-v2" },
            },
          ],
        };
      }
      if (request.method === "PATCH") {
        return {};
      }
      if (request.method === "POST") {
        return {
          records: request.body.records.map((_, index) => ({
            id: `rec-batch-created-${index + 1}`,
          })),
        };
      }
      throw new Error(`Unexpected request ${request.method} ${request.path}`);
    },
  }),
);
assert.deepEqual(
  await batchTrack.upsertResults({
    runId: "902",
    runAttempt: 1,
    records: [
      {
        fields: {
          "Run Key": "902-1-case-existing-v2",
          "Run ID": "902",
          "Run Attempt": 1,
          Result: "fail",
        },
      },
      {
        fields: {
          "Run Key": "902-1-case-new-v2",
          "Run ID": "902",
          "Run Attempt": 1,
          Result: "pass",
        },
      },
    ],
  }),
  {
    total: 2,
    updated: [
      {
        runKey: "902-1-case-existing-v2",
        recordId: "rec-batch-existing",
      },
    ],
    created: [{ runKey: "902-1-case-new-v2", recordId: "rec-batch-created-1" }],
  },
);
assert.deepEqual(
  batchRequests.map(({ method }) => method),
  ["GET", "PATCH", "POST"],
);
const batchQuery = new URL(batchRequests[0].path, "https://teable.example");
assert.equal(batchQuery.searchParams.get("take"), "1000");
assert.equal(batchQuery.searchParams.get("skip"), "0");
assert.equal(batchQuery.searchParams.get("projection"), "Run Key");
assert.deepEqual(JSON.parse(batchQuery.searchParams.get("filter")), {
  conjunction: "and",
  filterSet: [
    { fieldId: "Run ID", operator: "is", value: "902" },
    { fieldId: "Run Attempt", operator: "is", value: 1 },
  ],
});
assert.equal(batchRequests[1].body.records.length, 1);
assert.equal(batchRequests[2].body.records.length, 1);

console.log("Perf run summary and Performance Track record checks ok");
