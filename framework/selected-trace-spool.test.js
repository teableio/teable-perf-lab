import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  prepareSelectedTraceSpool,
  sanitizeSelectedTraceAttributes,
} from "../scripts/prepare-selected-traces.mjs";
import {
  buildPublishedTraceSummary,
  publishAndReconcileSelectedTraces,
  splitSelectedTracePayload,
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
  assert.match(collectorConfig, /file\/trace_spool:/);
  assert.doesNotMatch(collectorConfig, /otlp_http|UPSTREAM|4318\/v1\/traces/);

  // The report job brings its own Jaeger up before it publishes and takes it
  // down afterwards. Nothing may point at the retired always-on host again.
  const startJaeger = workflow.indexOf("- name: Start report-local Jaeger");
  const publish = workflow.indexOf(
    "- name: Publish selected traces to report-local Jaeger",
  );
  const stopJaeger = workflow.indexOf("- name: Stop report-local Jaeger");
  assert.ok(workflow.indexOf("  report:") < startJaeger);
  assert.ok(startJaeger < publish);
  assert.ok(publish < stopJaeger);
  assert.doesNotMatch(workflow, /136\.119\.178\.56/);
  assert.match(
    workflow,
    /PERF_LAB_JAEGER_API_BASE_URL: "http:\/\/127\.0\.0\.1:16686"/,
  );
  assert.match(
    workflow,
    /PERF_LAB_OTEL_UPSTREAM_ENDPOINT: "http:\/\/127\.0\.0\.1:4318\/v1\/traces"/,
  );

  // Trace payloads are the bulk of every perf artifact. Storage is free on a
  // public repository, so these expire on an investigation window rather than a
  // storage limit — but every upload that carries traces still has to name one.
  const traceArtifactUploads = [
    "name: teable-ee-e2e-perf-${{ matrix.plan.artifactSuffix }}-",
    "name: teable-ee-e2e-perf-results-${{ matrix.plan.artifactSuffix }}-",
    "name: teable-ee-e2e-perf-reconciled-results-",
  ];
  for (const upload of traceArtifactUploads) {
    const start = workflow.indexOf(upload);
    assert.ok(start > 0, `${upload} is no longer uploaded`);
    const nextStep = workflow.indexOf("      - name:", start);
    assert.match(
      workflow.slice(start, nextStep === -1 ? undefined : nextStep),
      /retention-days: 14/,
      `${upload} must bound how long it keeps its trace payload`,
    );
  }
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

test("removes PostgreSQL bind values while preserving trace evidence", () => {
  const payload = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: traceA,
                spanId: "aaaaaaaaaaaaaaaa",
                droppedAttributesCount: 2,
                attributes: [
                  {
                    key: "db.postgresql.values",
                    value: {
                      arrayValue: {
                        values: [
                          { stringValue: "record snapshot" },
                          { stringValue: "another value" },
                        ],
                      },
                    },
                  },
                  {
                    key: "db.statement",
                    value: { stringValue: "INSERT INTO record_trash ..." },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const result = sanitizeSelectedTraceAttributes(payload);
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];

  assert.equal(result.redactedAttributeCount, 1);
  assert.ok(result.redactedAttributeBytes > 0);
  assert.equal(span.droppedAttributesCount, 3);
  assert.deepEqual(
    span.attributes.map((attribute) => attribute.key),
    ["db.statement"],
  );
  assert.equal(span.traceId, traceA);
  assert.equal(span.spanId, "aaaaaaaaaaaaaaaa");
});

test("makes a multi-megabyte PostgreSQL span publishable without changing its identity", () => {
  const payload = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: traceA,
                spanId: "bbbbbbbbbbbbbbbb",
                name: "pg.query:INSERT e2e_test_teable",
                attributes: [
                  {
                    key: "db.postgresql.values",
                    value: {
                      arrayValue: {
                        values: [{ stringValue: "x".repeat(5_970_000) }],
                      },
                    },
                  },
                  {
                    key: "db.statement",
                    value: { stringValue: "y".repeat(240_000) },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const oversized = {
    traceId: traceA,
    spanCount: 1,
    payload,
    body: JSON.stringify(payload),
    sourcePath: "selected-traces.otlp.jsonl",
  };

  assert.throws(
    () => splitSelectedTracePayload(oversized, 1_000_000),
    /single span that exceeds/,
  );

  const result = sanitizeSelectedTraceAttributes(payload);
  const redacted = { ...oversized, body: JSON.stringify(payload) };
  const chunks = splitSelectedTracePayload(redacted, 1_000_000);

  assert.equal(result.redactedAttributeCount, 1);
  assert.ok(result.redactedAttributeBytes > 5_970_000);
  assert.equal(chunks.length, 1);
  assert.ok(Buffer.byteLength(chunks[0].body) < 1_000_000);
  assert.equal(
    chunks[0].payload.resourceSpans[0].scopeSpans[0].spans[0].traceId,
    traceA,
  );
});

test("bounds oversized Prisma query text and marks the retained span", () => {
  const payload = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: traceA,
                spanId: "cccccccccccccccc",
                name: "prisma:engine:db_query",
                attributes: [
                  {
                    key: "db.query.text",
                    value: { stringValue: "x".repeat(1_151_700) },
                  },
                  {
                    key: "db.system",
                    value: { stringValue: "postgresql" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const result = sanitizeSelectedTraceAttributes(payload);
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
  const queryText = span.attributes.find(
    (attribute) => attribute.key === "db.query.text",
  );
  const marker = span.attributes.find(
    (attribute) => attribute.key === "perf_lab.truncated_trace_attributes",
  );

  assert.equal(result.truncatedAttributeCount, 1);
  assert.ok(result.truncatedAttributeBytes > 895_000);
  assert.equal(Buffer.byteLength(queryText.value.stringValue), 256_000);
  assert.deepEqual(marker.value.arrayValue.values, [
    { stringValue: "db.query.text:1151700->256000" },
  ]);
  assert.equal(span.traceId, traceA);
  assert.ok(Buffer.byteLength(JSON.stringify(span)) < 1_000_000);
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

test("splits an oversized trace into bounded OTLP requests with the same trace id", () => {
  const payload = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: "teable" }] },
        scopeSpans: [
          {
            scope: { name: "test" },
            spans: Array.from({ length: 6 }, (_, index) => ({
              traceId: traceA,
              spanId: String(index).padStart(16, "0"),
              attributes: [{ key: "payload", value: "x".repeat(250) }],
            })),
          },
        ],
      },
    ],
  };
  const selected = {
    traceId: traceA,
    spanCount: 6,
    payload,
    body: JSON.stringify(payload),
    sourcePath: "selected-traces.otlp.jsonl",
  };
  const maxRequestBytes = 800;
  const chunks = splitSelectedTracePayload(selected, maxRequestBytes);

  assert.ok(chunks.length > 1);
  assert.equal(
    chunks.reduce((sum, chunk) => sum + chunk.spanCount, 0),
    selected.spanCount,
  );
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk.body) <= maxRequestBytes);
    assert.deepEqual(
      [
        ...new Set(
          chunk.payload.resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) =>
              scope.spans.map((span) => span.traceId),
            ),
          ),
        ),
      ],
      [traceA],
    );
  }
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
      const body = String(init.body);
      if (Buffer.byteLength(body) > 800) {
        return Response.json(
          { code: 3, message: "http: request body too large" },
          { status: 400 },
        );
      }
      const payload = JSON.parse(body);
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
      // Distinctive execute-job measurements: the report job must preserve
      // these, not overwrite them with its own publish elapsed time.
      traceFetchWaitMs: 1_234,
      traceFetchJobWaitMs: 4_242,
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
                spans: Array.from({ length: 6 }, (_, index) => ({
                  traceId: traceA,
                  spanId: String(index).padStart(16, "a"),
                  attributes: [{ key: "payload", value: "x".repeat(250) }],
                })),
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
      maxRequestBytes: 800,
      settleMs: 0,
      fetchTimeoutMs: 100,
      fetchConcurrency: 1,
    });
    assert.equal(result.savedTraceCount, 1);
    assert.ok(requests.length > 1);
    assert.deepEqual(new Set(requests), new Set([traceA]));
    assert.equal(result.publishRequestCount, requests.length);

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
    // The report job publishes once for the whole run, so writing its elapsed
    // time into every case's manifest replaced each execute job's own
    // measurement with one shared number — which acceptance then checked
    // against the per-execute-job budget. Keep the two apart.
    assert.equal(
      payload.details.observability.traces.traceFetchJobWaitMs,
      4_242,
      "execute job trace-fetch job wait must survive report-stage reconcile",
    );
    assert.equal(
      payload.details.observability.traces.traceFetchWaitMs,
      1_234,
      "execute job trace-fetch case wait must survive report-stage reconcile",
    );
    assert.equal(
      typeof payload.details.observability.traces.sharedPublishWaitMs,
      "number",
      "report-stage publish elapsed must be recorded under its own field",
    );
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});
