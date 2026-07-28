import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareSelectedTraceSpool } from "../scripts/prepare-selected-traces.mjs";
import {
  buildPublishedTraceSummary,
  publishAndReconcileSelectedTraces,
} from "../scripts/publish-selected-traces.mjs";

const traceA = "11111111111111111111111111111111";
const traceB = "22222222222222222222222222222222";
const traceC = "33333333333333333333333333333333";

test("workflow spools execute traces locally and publishes only from report", async () => {
  const [workflow, collectorConfig] = await Promise.all([
    readFile(".github/workflows/teable-ee-e2e-perf.yml", "utf8"),
    readFile(".github/otel/trace-relay.yaml", "utf8"),
  ]);
  assert.match(workflow, /PERF_LAB_TRACE_ENABLED: "false"/);
  assert.match(workflow, /OTEL_EXPORT_RATIO: "0"/);
  assert.match(
    workflow,
    /OTEL_EXPORTER_OTLP_ENDPOINT: "http:\/\/127\.0\.0\.1:4318\/v1\/traces"/,
  );
  assert.match(workflow, /PERF_LAB_TRACE_DEFER_SHARED_PUBLISH="true"/);
  assert.ok(
    workflow.indexOf("- name: Prepare selected trace payload") <
      workflow.indexOf("- name: Upload perf artifacts"),
  );
  assert.ok(
    workflow.indexOf("- name: Publish selected traces to shared Jaeger") >
      workflow.indexOf("  report:"),
  );
  assert.match(collectorConfig, /file\/trace_spool:/);
  assert.doesNotMatch(collectorConfig, /otlp_http|UPSTREAM|4318\/v1\/traces/);
});

test("keeps every span for selected traces and writes one OTLP object per trace", async () => {
  const root = await mkdtemp(join(tmpdir(), "selected-trace-spool-"));
  const artifactDir = join(root, "artifacts");
  const manifestDir = join(artifactDir, "traces", "case-v1");
  const spoolPath = join(root, "trace-spool.jsonl");
  try {
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, "manifest.json"),
      JSON.stringify({ selectedTraceIds: [traceA, traceB] }),
    );
    await writeFile(
      spoolPath,
      [
        JSON.stringify({
          resourceSpans: [
            {
              resource: { attributes: [{ key: "service.name" }] },
              scopeSpans: [
                {
                  scope: { name: "first" },
                  spans: [
                    { traceId: traceA, spanId: "a1" },
                    { traceId: traceC, spanId: "c1" },
                  ],
                },
              ],
            },
          ],
        }),
        JSON.stringify({
          resourceSpans: [
            {
              resource: { attributes: [{ key: "service.name" }] },
              scopeSpans: [
                {
                  scope: { name: "second" },
                  spans: [
                    { traceId: traceA, spanId: "a2" },
                    { traceId: traceB, spanId: "b1" },
                  ],
                },
              ],
            },
          ],
        }),
      ].join("\n"),
    );

    const summary = await prepareSelectedTraceSpool({
      spoolPath,
      artifactDir,
    });
    assert.equal(summary.rawSpanCount, 4);
    assert.equal(summary.selectedSpanCount, 3);
    assert.equal(summary.foundTraceCount, 2);
    assert.deepEqual(summary.missingTraceIds, []);

    const payloads = (
      await readFile(join(artifactDir, "selected-traces.otlp.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(payloads.length, 2);
    const traceIds = payloads.map((payload) => [
      ...new Set(
        payload.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) =>
            scope.spans.map((span) => span.traceId),
          ),
        ),
      ),
    ]);
    assert.deepEqual(traceIds, [[traceA], [traceB]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails when a selected trace is absent from the local spool", async () => {
  const root = await mkdtemp(join(tmpdir(), "selected-trace-missing-"));
  const artifactDir = join(root, "artifacts");
  const manifestDir = join(artifactDir, "traces", "case-v1");
  const spoolPath = join(root, "trace-spool.jsonl");
  try {
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, "manifest.json"),
      JSON.stringify({ selectedTraceIds: [traceA] }),
    );
    await writeFile(
      spoolPath,
      `${JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [{ spans: [{ traceId: traceC, spanId: "c1" }] }],
          },
        ],
      })}\n`,
    );
    await assert.rejects(
      prepareSelectedTraceSpool({ spoolPath, artifactDir }),
      /1\/1 selected traces were absent/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconciles selected publication outcomes without losing ref accounting", () => {
  const manifest = {
    artifactDir: "traces/case-v1",
    selectedTraceIds: [traceA, traceB],
    refs: [
      { traceId: traceA, stepId: "first", sampled: true },
      { traceId: traceA, stepId: "duplicate", sampled: true },
      { traceId: traceB, stepId: "second", sampled: true },
      { traceId: traceC, stepId: "unselected", sampled: true },
    ],
  };
  const summary = buildPublishedTraceSummary({
    manifest,
    outcomesByTraceId: new Map([
      [
        traceA,
        {
          status: "saved",
          traceId: traceA,
          attempts: 1,
          durationMs: 12,
        },
      ],
      [
        traceB,
        {
          status: "missing",
          traceId: traceB,
          error: "not indexed",
          attempts: 3,
          durationMs: 1000,
        },
      ],
    ]),
    publishByTraceId: new Map([
      [traceA, { spanCount: 3 }],
      [traceB, { spanCount: 5 }],
    ]),
    fetchJobWaitMs: 1012,
  });

  assert.equal(summary.savedTraceCount, 1);
  assert.equal(summary.failedTraceCount, 1);
  assert.equal(summary.skippedTraceCount, 2);
  assert.equal(summary.missingFetchCount, 1);
  assert.equal(summary.sharedPublishSpanCount, 8);
  assert.equal(summary.savedTraces.length, manifest.refs.length);
  assert.equal(summary.traceFetchBreakerState, "partial-loss");
});

test("publishes selected OTLP traces serially and reconciles downloaded artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "selected-trace-publish-"));
  const artifactDir = join(root, "downloaded");
  const resultDir = join(artifactDir, "artifact", "v1");
  const manifestDir = join(resultDir, "traces", "case-v1");
  const published = new Set();
  const requests = [];
  const baseUrl = "http://trace.test";
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST" && url === `${baseUrl}/v1/traces`) {
      const payload = JSON.parse(String(init.body));
      const { traceId } = payload.resourceSpans[0].scopeSpans[0].spans[0];
      published.add(traceId);
      requests.push(traceId);
      return new Response("", { status: 200 });
    }
    const traceId = url.match(/\/api\/traces\/([0-9a-f]+)$/)?.[1];
    if (traceId && published.has(traceId)) {
      return Response.json({ data: [{ traceID: traceId, spans: [{}] }] });
    }
    return new Response("", { status: 404 });
  };

  try {
    await mkdir(manifestDir, { recursive: true });
    const traceLink = `${baseUrl}/trace/${traceA}`;
    const traceSummary = {
      enabled: true,
      traceRefCount: 2,
      uniqueTraceCount: 2,
      selectedTraceCount: 1,
      selectedTraceIds: [traceA],
      savedTraceCount: 0,
      failedTraceCount: 0,
      skippedTraceCount: 2,
      missingFetchCount: 0,
      wastedFetchMs: 0,
      traceFetchCaseBudgetMs: 15_000,
      traceFetchJobBudgetMs: 60_000,
      traceFetchWaitMs: 0,
      traceFetchJobWaitMs: 0,
      traceFetchRecoveryProbeCount: 0,
      traceFetchRecoverySucceeded: false,
      maxSnapshotCount: 10,
      fetchConcurrency: 1,
      traceFetchBreakerState: "pending-shared-publish",
      traceFetchSkippedReason: "pending",
      artifactDir: "traces/case-v1",
      manifestPath: "traces/case-v1/manifest.json",
      refs: [
        {
          traceId: traceA,
          stepId: "selected",
          sampled: true,
          traceLink,
        },
        {
          traceId: traceC,
          stepId: "unselected",
          sampled: true,
        },
      ],
      savedTraces: [],
    };
    await writeFile(
      join(manifestDir, "manifest.json"),
      JSON.stringify(traceSummary),
    );
    await writeFile(
      join(resultDir, "case-v1.json"),
      JSON.stringify({
        caseId: "case",
        title: "Case",
        runId: "run",
        engine: "v1",
        appUrl: "http://app",
        result: "pass",
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1).toISOString(),
        durationMs: 1,
        metrics: {},
        thresholds: [],
        details: { observability: { traces: traceSummary } },
      }),
    );
    await writeFile(
      join(resultDir, "selected-traces.otlp.jsonl"),
      `${JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [{ traceId: traceA, spanId: "aaaaaaaaaaaaaaaa" }],
              },
            ],
          },
        ],
      })}\n`,
    );

    const result = await publishAndReconcileSelectedTraces({
      artifactDir,
      endpoint: `${baseUrl}/v1/traces`,
      jaegerApiBaseUrl: baseUrl,
      outputPath: join(root, "trace-publish.json"),
      intervalMs: 0,
      settleMs: 0,
      fetchTimeoutMs: 100,
      fetchConcurrency: 1,
    });
    assert.equal(result.savedTraceCount, 1);
    assert.deepEqual(requests, [traceA]);

    const payload = JSON.parse(
      await readFile(join(resultDir, "case-v1.json"), "utf8"),
    );
    assert.equal(
      payload.details.observability.traces.traceFetchBreakerState,
      "closed",
    );
    assert.equal(payload.details.observability.traces.savedTraceCount, 1);
    assert.equal(payload.details.observability.traces.skippedTraceCount, 1);
    assert.equal(
      payload.details.observability.traces.refs[0].traceLink,
      traceLink,
    );
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});
