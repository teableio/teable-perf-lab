import assert from "node:assert/strict";
import {
  buildCaseRows,
  buildPerfSummaryCard,
  formatDuration,
  formatMetricSeconds,
  resolveRunTimingFromJobs,
  resultCounts,
} from "./perf-run-summary-model.mjs";

assert.equal(formatDuration(undefined), "-");
assert.equal(formatDuration(999), "999ms");
assert.equal(formatDuration(12_345), "12s");
assert.equal(formatDuration(65_000), "1m05s");
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

assert.deepEqual(resultCounts(payloads), { pass: 4, skipped: 1, fail: 1 });

const rows = buildCaseRows(payloads);
assert.deepEqual(
  rows.map(({ caseId, status, comparison }) => ({
    caseId,
    status,
    comparison,
  })),
  [
    {
      caseId: "lookup/regressed",
      status: "attention",
      comparison: "慢 1.4x",
    },
    { caseId: "field/fail", status: "attention", comparison: "无 V1 基线" },
    { caseId: "smoke/skip", status: "neutral", comparison: "无 V1 基线" },
    { caseId: "formula/fast", status: "ok", comparison: "快 2.0x" },
  ],
);

const card = buildPerfSummaryCard({
  payloads,
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
assert.equal(card.card.header.template, "red");
assert.equal(
  card.card.header.title.content,
  "Teable EE 性能回归 · 用例失败 · 2 项退化",
);
assert.match(card.card.elements[0].text.content, /4 通过 \/ 1 跳过 \/ 1 失败/);
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
              "Trace service unavailable; skipped Jaeger fetch: connect ECONNREFUSED 136.119.178.56:4318",
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
assert.match(outageText, /observability-stack \/ teable-perf-jaeger/);
assert.doesNotMatch(outageText, /OTLP/);
assert.doesNotMatch(
  JSON.stringify(outageCard.card.elements),
  /Trace 抓取浪费/,
);

console.log("Perf run summary model checks ok");
