import assert from "node:assert/strict";
import {
  buildCaseRows,
  buildPerfSummaryCard,
  buildPerfSummaryMarkdown,
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
    {
      caseId: "lookup/slightly-slower",
      status: "attention",
      comparison: "慢 1.1x",
    },
    { caseId: "field/fail", status: "attention", comparison: "无 V1 基线" },
    { caseId: "smoke/skip", status: "neutral", comparison: "无 V1 基线" },
    { caseId: "formula/fast", status: "ok", comparison: "快 2.0x" },
  ],
);

const [v2OnlyRow] = buildCaseRows(
  [
    {
      caseId: "import-base/v2-only",
      engine: "v1",
      result: "skipped",
      durationMs: 1,
      thresholds: [],
    },
    {
      caseId: "import-base/v2-only",
      engine: "v2",
      result: "pass",
      durationMs: 1500,
      thresholds: [
        { metric: "importBaseStreamMs", actual: 1500, passed: true },
      ],
    },
  ],
  {
    comparisonBaselines: {
      "import-base/v2-only": { value: 1000, label: "Baseline" },
    },
  },
);
assert.deepEqual(
  {
    caseId: v2OnlyRow.caseId,
    status: v2OnlyRow.status,
    baselineLabel: v2OnlyRow.baselineLabel,
    baseline: v2OnlyRow.baseline,
    v1: v2OnlyRow.v1,
    v2: v2OnlyRow.v2,
    comparison: v2OnlyRow.comparison,
  },
  {
    caseId: "import-base/v2-only",
    status: "attention",
    baselineLabel: "Baseline",
    baseline: "1.00s",
    v1: "skip",
    v2: "1.50s",
    comparison: "慢 1.5x",
  },
);

const v2OnlyCard = buildPerfSummaryCard({
  payloads: [
    {
      caseId: "import-base/v2-only",
      engine: "v1",
      result: "skipped",
      durationMs: 1,
      thresholds: [],
    },
    {
      caseId: "import-base/v2-only",
      engine: "v2",
      result: "pass",
      durationMs: 1500,
      thresholds: [
        { metric: "importBaseStreamMs", actual: 1500, passed: true },
      ],
    },
  ],
  timings: {},
  comparisonBaselines: {
    "import-base/v2-only": { value: 1000, label: "Baseline" },
  },
  context: {
    chartUrl: "https://charts.example",
    executeResult: "success",
  },
});
const v2OnlyRegressionText = v2OnlyCard.card.elements.find(
  (element) => element.tag === "collapsible_panel",
).elements[0].text.content;
assert.match(
  v2OnlyRegressionText,
  /Baseline 1\.00s → V2 1\.50s\s+\*\*慢 1\.5x\*\*/,
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
  "Teable EE 性能回归 · 用例失败 · 退化 3",
);
assert.match(card.card.elements[0].text.content, /6 通过 \/ 1 跳过 \/ 1 失败/);
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
const panels = card.card.elements.filter(
  (element) => element.tag === "collapsible_panel",
);
assert.equal(panels[0].header.title.content, "**退化 3**");
assert.equal(panels[1].header.title.content, "**待确认 1**");
assert.match(
  panels[0].elements[0].text.content,
  /🔴 \*\*\[lookup\/slightly-slower\].*慢 1\.1x/,
);
assert.doesNotMatch(JSON.stringify(card), /formula\/fast/);
assert.match(JSON.stringify(card), /已省略 1 个 V2 更快或持平项/);

const markdown = buildPerfSummaryMarkdown({
  payloads,
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
assert.match(markdown, /smoke\/skip/);
assert.doesNotMatch(markdown, /formula\/fast/);
assert.match(markdown, /Omitted 1 V2 faster or equal comparisons/);
assert.match(markdown, /\[CI run\]\(https:\/\/github\.example\/run\/123\)/);

const manyFastPayloads = Array.from({ length: 1_000 }, (_, index) => [
  {
    caseId: `record-read/fast-${index}`,
    engine: "v1",
    result: "pass",
    durationMs: 2_000,
    thresholds: [{ metric: "durationMs", actual: 2_000, passed: true }],
  },
  {
    caseId: `record-read/fast-${index}`,
    engine: "v2",
    result: "pass",
    durationMs: 1_000,
    thresholds: [{ metric: "durationMs", actual: 1_000, passed: true }],
  },
]).flat();
const manyFastCard = buildPerfSummaryCard({
  payloads: manyFastPayloads,
  timings: {},
  context: { chartUrl: "https://charts.example", executeResult: "success" },
});
const manyFastCardJson = JSON.stringify(manyFastCard);
assert.ok(Buffer.byteLength(manyFastCardJson, "utf8") < 100 * 1024);
assert.doesNotMatch(manyFastCardJson, /record-read\/fast-/);
assert.match(manyFastCardJson, /已省略 1000 个 V2 更快或持平项/);

const manyAttentionPayloads = Array.from({ length: 1_000 }, (_, index) => [
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
    thresholds: [{ metric: "durationMs", actual: 2_000, passed: true }],
  },
]).flat();
const boundedMarkdown = buildPerfSummaryMarkdown({
  payloads: manyAttentionPayloads,
  maxBytes: 4_096,
  context: { chartUrl: "https://charts.example" },
});
assert.ok(Buffer.byteLength(boundedMarkdown, "utf8") <= 4_096);
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

const baselineAdapter = createInMemoryPerformanceTrackAdapter({
  records: [
    {
      id: "rec-current-run",
      fields: {
        "Case ID": "import-base/v2-only",
        Engine: "v2",
        Result: "pass",
        "Primary Metric": "importBaseStreamMs",
        "Primary Metric Value": 700,
        "Run ID": "900",
        "Finished At": "2026-07-14T03:00:00.000Z",
      },
    },
    {
      id: "rec-current-payload",
      fields: {
        "Case ID": "import-base/v2-only",
        Engine: "v2",
        Result: "pass",
        "Primary Metric": "importBaseStreamMs",
        "Primary Metric Value": 800,
        "Run ID": "900-1-v2",
        "Finished At": "2026-07-14T02:00:00.000Z",
      },
    },
    {
      id: "rec-older",
      fields: {
        "Case ID": "import-base/v2-only",
        Engine: "v2",
        Result: "pass",
        "Primary Metric": "importBaseStreamMs",
        "Primary Metric Value": 1200,
        "Run ID": "899",
        "Finished At": "2026-07-12T00:00:00.000Z",
      },
    },
    {
      id: "rec-latest-previous",
      fields: {
        "Case ID": "import-base/v2-only",
        Engine: "v2",
        Result: "pass",
        "Primary Metric": "importBaseStreamMs",
        "Primary Metric Value": 1100,
        "Run ID": "898",
        "Finished At": "2026-07-13T00:00:00.000Z",
      },
    },
  ],
});
const baselineModule = createPerformanceTrackRecordModule(baselineAdapter);
assert.deepEqual(
  await baselineModule.comparisonBaselines({
    currentRunId: "900",
    payloads: [
      {
        caseId: "import-base/v2-only",
        engine: "v1",
        result: "skipped",
        runId: "900-1-v1",
        thresholds: [],
      },
      {
        caseId: "import-base/v2-only",
        engine: "v2",
        result: "pass",
        runId: "900-1-v2",
        thresholds: [
          {
            metric: "importBaseStreamMs",
            actual: 1000,
            passed: true,
          },
        ],
      },
    ],
  }),
  {
    "import-base/v2-only": {
      label: "Baseline",
      metric: "importBaseStreamMs",
      runId: "898",
      value: 1100,
    },
  },
);

const baselineRequests = [];
const teableBaselineModule = createPerformanceTrackRecordModule(
  createTeablePerformanceTrackAdapter({
    tableId: "tbl-performance-track",
    request: async (request) => {
      baselineRequests.push(request);
      return {
        records: [
          {
            id: "rec-baseline",
            fields: {
              "Run ID": "899",
              "Primary Metric Value": 950,
              "Finished At": "2026-07-13T00:00:00.000Z",
            },
          },
        ],
      };
    },
  }),
);
assert.deepEqual(
  await teableBaselineModule.comparisonBaselines({
    currentRunId: "900",
    payloads: [
      {
        caseId: "import-base/v2-only",
        engine: "v1",
        result: "skipped",
        runId: "900-1-v1",
        thresholds: [],
      },
      {
        caseId: "import-base/v2-only",
        engine: "v2",
        result: "pass",
        runId: "900-1-v2",
        thresholds: [
          {
            metric: "importBaseStreamMs",
            actual: 1000,
            passed: true,
          },
        ],
      },
    ],
  }),
  {
    "import-base/v2-only": {
      label: "Baseline",
      metric: "importBaseStreamMs",
      runId: "899",
      value: 950,
    },
  },
);
assert.equal(baselineRequests.length, 1);
assert.equal(baselineRequests[0].method, "GET");
const baselineQuery = new URL(
  baselineRequests[0].path,
  "https://teable.example",
);
assert.equal(baselineQuery.pathname, "/table/tbl-performance-track/record");
assert.equal(baselineQuery.searchParams.get("fieldKeyType"), "name");
assert.equal(baselineQuery.searchParams.get("take"), "20");
assert.deepEqual(JSON.parse(baselineQuery.searchParams.get("filter")), {
  conjunction: "and",
  filterSet: [
    {
      fieldId: "Case ID",
      operator: "is",
      value: "import-base/v2-only",
    },
    { fieldId: "Engine", operator: "is", value: "v2" },
    { fieldId: "Result", operator: "is", value: "pass" },
    {
      fieldId: "Primary Metric",
      operator: "is",
      value: "importBaseStreamMs",
    },
  ],
});
assert.deepEqual(JSON.parse(baselineQuery.searchParams.get("orderBy")), [
  { fieldId: "Finished At", order: "desc" },
]);

console.log("Perf run summary and Performance Track record checks ok");
