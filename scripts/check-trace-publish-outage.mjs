#!/usr/bin/env node

// Covers the temporary Jaeger-outage path in scripts/publish-selected-traces.mjs.
// See framework/jaeger-availability.ts for why that path exists.
//
// The behaviour worth protecting is the split: an unreachable Jaeger degrades
// the run, a reachable one that loses traces still fails it. Both directions
// are asserted here so nobody "simplifies" the outage branch into an
// unconditional skip.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { setJaegerTransport, resetJaegerTransport } from "../framework/jaeger-transport.ts";
import { probeJaegerAvailability } from "../framework/jaeger-availability.ts";
import {
  buildPublishedTraceSummary,
  publishAndReconcileSelectedTraces,
} from "./publish-selected-traces.mjs";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const connectionRefused = () => {
  const error = new TypeError("fetch failed");
  error.cause = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:4318"), {
    code: "ECONNREFUSED",
  });
  return error;
};

// --- probe classification -------------------------------------------------

{
  const result = await probeJaegerAvailability({
    jaegerApiBaseUrl: "http://jaeger.invalid:16686",
    fetchImpl: async () => {
      throw connectionRefused();
    },
    attempts: 2,
    retryDelayMs: 0,
  });
  assert.equal(result.available, false);
  assert.match(
    result.error,
    /ECONNREFUSED/,
    "the probe must surface error.cause, not a bare 'fetch failed'",
  );
}

{
  const result = await probeJaegerAvailability({
    jaegerApiBaseUrl: "http://jaeger.invalid:16686",
    fetchImpl: async () => jsonResponse({ data: ["teable"] }),
  });
  assert.equal(result.available, true);
}

{
  // Alive but broken counts as an outage; a 4xx still counts as reachable.
  const down = await probeJaegerAvailability({
    jaegerApiBaseUrl: "http://jaeger.invalid:16686",
    fetchImpl: async () => new Response("boom", { status: 503 }),
    attempts: 1,
  });
  assert.equal(down.available, false);

  const up = await probeJaegerAvailability({
    jaegerApiBaseUrl: "http://jaeger.invalid:16686",
    fetchImpl: async () => new Response("nope", { status: 404 }),
    attempts: 1,
  });
  assert.equal(up.available, true);
}

// --- outage summary shape -------------------------------------------------

{
  const manifest = {
    manifestPath: "traces/case/manifest.json",
    traceRefCount: 2,
    selectedTraceIds: [TRACE_ID],
    refs: [
      { traceId: TRACE_ID, stepId: "step-a", sampled: true },
      { traceId: "1111111111111111aaaaaaaaaaaaaaaa", stepId: "step-b" },
    ],
  };
  const summary = buildPublishedTraceSummary({
    manifest,
    outcomesByTraceId: new Map(),
    publishByTraceId: new Map(),
    fetchJobWaitMs: 0,
    outage: "connect ECONNREFUSED",
  });

  // verify-full-run-result-acceptance.mjs rejects `pending-shared-publish` and
  // only allows this fixed set of breaker states.
  assert.equal(summary.traceFetchBreakerState, "hard-outage");
  assert.ok(
    typeof summary.traceFetchBreakerReason === "string" &&
      summary.traceFetchBreakerReason.length > 0,
    "a hard-outage state requires a non-empty breaker reason",
  );
  // perf-run-summary-model.mjs keys the "Trace 服务不可用" card off this field.
  assert.ok(
    typeof summary.traceFetchSkippedReason === "string" &&
      summary.traceFetchSkippedReason.length > 0,
    "the outage card needs traceFetchSkippedReason to be set",
  );

  // Internal consistency, as traceEvidenceIssues() recomputes it.
  const statuses = summary.savedTraces.map(({ status }) => status);
  assert.deepEqual(statuses, ["skipped", "skipped"]);
  assert.equal(summary.savedTraces.length, manifest.traceRefCount);
  assert.equal(summary.savedTraceCount, 0);
  assert.equal(summary.failedTraceCount, 0);
  assert.equal(summary.skippedTraceCount, 2);
  assert.equal(summary.missingFetchCount, 0);
  assert.equal(summary.wastedFetchMs, 0);
}

// --- end to end: unreachable Jaeger degrades, it does not throw ------------

const stageArtifacts = async () => {
  const root = await mkdtemp(join(tmpdir(), "perf-lab-publish-outage-"));
  const traceDir = join(root, "traces", "case");
  await mkdir(traceDir, { recursive: true });

  const manifest = {
    manifestPath: "traces/case/manifest.json",
    traceRefCount: 1,
    selectedTraceIds: [TRACE_ID],
    refs: [{ traceId: TRACE_ID, stepId: "step-a", sampled: true }],
    traceFetchBreakerState: "pending-shared-publish",
  };
  await writeFile(
    join(traceDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    join(root, "result.json"),
    `${JSON.stringify(
      {
        caseId: "record-read/example",
        engine: "v1",
        result: "pass",
        durationMs: 12,
        metrics: {},
        thresholds: [],
        details: {
          observability: {
            traces: { manifestPath: "traces/case/manifest.json" },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(root, "selected-traces.otlp.jsonl"),
    `${JSON.stringify({
      resourceSpans: [
        { scopeSpans: [{ spans: [{ traceId: TRACE_ID, spanId: SPAN_ID }] }] },
      ],
    })}\n`,
  );
  return root;
};

{
  const artifactDir = await stageArtifacts();
  const outputPath = join(artifactDir, "trace-publish.json");
  let publishAttempts = 0;

  setJaegerTransport(async () => {
    publishAttempts += 1;
    throw connectionRefused();
  });

  const summary = await publishAndReconcileSelectedTraces({
    artifactDir,
    endpoint: "http://jaeger.invalid:4318/v1/traces",
    jaegerApiBaseUrl: "http://jaeger.invalid:16686",
    outputPath,
    intervalMs: 1,
    settleMs: 1,
    fetchTimeoutMs: 10,
    fetchConcurrency: 1,
  });

  assert.equal(summary.status, "skipped-jaeger-unavailable");
  assert.match(summary.outage, /ECONNREFUSED/);
  assert.equal(summary.selectedTraceCount, 1);

  // The preflight must short-circuit: no OTLP publishing should be attempted
  // against a Jaeger already known to be gone.
  assert.equal(
    publishAttempts,
    2,
    "only the two probe attempts should reach the transport",
  );

  const reconciled = JSON.parse(
    await readFile(join(artifactDir, "traces", "case", "manifest.json"), "utf8"),
  );
  assert.equal(
    reconciled.traceFetchBreakerState,
    "hard-outage",
    "the outage path must resolve pending-shared-publish, or acceptance fails instead",
  );

  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(written.status, "skipped-jaeger-unavailable");

  await rm(artifactDir, { recursive: true, force: true });
}

// --- end to end: reachable Jaeger that loses traces still fails ------------

{
  const artifactDir = await stageArtifacts();
  const outputPath = join(artifactDir, "trace-publish.json");

  setJaegerTransport(async (url, init) => {
    if (init?.method === "POST") {
      return new Response("", { status: 200 });
    }
    // Reachable, answering, but the trace never shows up.
    return jsonResponse({ data: [] });
  });

  await assert.rejects(
    publishAndReconcileSelectedTraces({
      artifactDir,
      endpoint: "http://jaeger.invalid:4318/v1/traces",
      jaegerApiBaseUrl: "http://jaeger.invalid:16686",
      outputPath,
      intervalMs: 1,
      settleMs: 1,
      fetchTimeoutMs: 10,
      fetchConcurrency: 1,
    }),
    /were missing from the report-local Jaeger/,
    "a reachable Jaeger losing traces is a real regression and must stay fatal",
  );

  await rm(artifactDir, { recursive: true, force: true });
}

// --- end to end: Jaeger lost during the recovery publish still degrades ----

{
  const artifactDir = await stageArtifacts();
  const outputPath = join(artifactDir, "trace-publish.json");
  let posts = 0;

  setJaegerTransport(async (url, init) => {
    if (init?.method !== "POST") {
      // Reachable for the probe, and the trace never lands, which is what sends
      // the run into the recovery publish.
      return url.includes("/api/traces/")
        ? jsonResponse({ data: [] })
        : jsonResponse({ data: ["teable-perf"] });
    }
    posts += 1;
    // The first publish succeeds; Jaeger disappears before the recovery pass.
    if (posts === 1) {
      return new Response("", { status: 200 });
    }
    throw connectionRefused();
  });

  const summary = await publishAndReconcileSelectedTraces({
    artifactDir,
    endpoint: "http://jaeger.invalid:4318/v1/traces",
    jaegerApiBaseUrl: "http://jaeger.invalid:16686",
    outputPath,
    intervalMs: 1,
    settleMs: 1,
    fetchTimeoutMs: 10,
    fetchConcurrency: 1,
  });

  // Without this path the run falls through to "1/1 selected traces were
  // missing" and goes red for the same outage the first publish degrades.
  assert.equal(summary.status, "skipped-jaeger-unavailable");
  assert.match(summary.outage, /ECONNREFUSED/);
  const reconciled = JSON.parse(
    await readFile(join(artifactDir, "traces", "case", "manifest.json"), "utf8"),
  );
  assert.equal(reconciled.traceFetchBreakerState, "hard-outage");

  await rm(artifactDir, { recursive: true, force: true });
}

resetJaegerTransport();
console.log("Trace publish outage checks ok");
