import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const source = await readFile("framework/trace-collector.ts", "utf8");
const evidencePolicySource = await readFile(
  "framework/trace-evidence-policy.ts",
  "utf8",
);
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "framework/trace-collector.ts",
  reportDiagnostics: true,
});
const evidencePolicyOutput = ts.transpileModule(evidencePolicySource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "framework/trace-evidence-policy.ts",
  reportDiagnostics: true,
});

const errors = [output, evidencePolicyOutput]
  .flatMap((result) => result.diagnostics ?? [])
  .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
assert.equal(errors.length, 0);

const tempDir = await mkdtemp(join(tmpdir(), "perf-lab-trace-collector-"));
const collectorFile = join(tempDir, "trace-collector.mjs");
const classificationFile = join(tempDir, "trace-classification.mjs");
const evidencePolicyFile = join(tempDir, "trace-evidence-policy.mjs");
const artifactDir = join(tempDir, "artifacts");
const traceDir = join(artifactDir, "traces", "smoke-auth-user-v2");
const manifestPath = join(traceDir, "manifest.json");

try {
  await writeFile(
    classificationFile,
    [
      "export const normalizeTraceStepShape = (stepId) => stepId.replace(/\\bsample-\\d+\\b/g, 'sample-#').replace(/:\\d+$/g, ':#').replace(/-\\d+$/g, '-#');",
      "export const hasSavedTraceStepShape = (ref, refs, savedTraceIds) => {",
      "  const shape = normalizeTraceStepShape(ref.stepId);",
      "  return refs.some((candidate) => savedTraceIds.has(candidate.traceId) && normalizeTraceStepShape(candidate.stepId) === shape);",
      "};",
    ].join("\n"),
  );
  await writeFile(
    collectorFile,
    output.outputText
      .replace('from "@teable/openapi"', 'from "./teable-openapi.mjs"')
      .replace(
        'from "./trace-evidence-policy"',
        'from "./trace-evidence-policy.mjs"',
      ),
  );
  await writeFile(
    evidencePolicyFile,
    evidencePolicyOutput.outputText.replace(
      'from "./trace-classification"',
      'from "./trace-classification.mjs"',
    ),
  );
  await writeFile(
    join(tempDir, "teable-openapi.mjs"),
    [
      "const interceptor = { use: () => 0, eject: () => undefined };",
      "export const axios = { interceptors: { request: interceptor, response: interceptor } };",
    ].join("\n"),
  );

  const {
    installPerfTraceCollector,
    recordPerfTraceRefFromHeaders,
    resetPerfTraceRefs,
    setPerfTraceFlush,
    writeTraceArtifacts,
  } = await import(pathToFileURL(collectorFile));

  const previousEnv = {
    PERF_LAB_TRACE_ENABLED: process.env.PERF_LAB_TRACE_ENABLED,
    PERF_LAB_TRACE_MAX_SNAPSHOTS: process.env.PERF_LAB_TRACE_MAX_SNAPSHOTS,
    PERF_LAB_TRACE_FETCH_SETTLE_MS: process.env.PERF_LAB_TRACE_FETCH_SETTLE_MS,
    PERF_LAB_TRACE_FETCH_TIMEOUT_MS:
      process.env.PERF_LAB_TRACE_FETCH_TIMEOUT_MS,
    PERF_LAB_TRACE_FETCH_POLL_INTERVAL_MS:
      process.env.PERF_LAB_TRACE_FETCH_POLL_INTERVAL_MS,
    PERF_LAB_TRACE_FETCH_CONCURRENCY:
      process.env.PERF_LAB_TRACE_FETCH_CONCURRENCY,
    PERF_LAB_JAEGER_API_BASE_URL: process.env.PERF_LAB_JAEGER_API_BASE_URL,
  };
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;

  try {
    process.env.PERF_LAB_TRACE_ENABLED = "true";
    process.env.PERF_LAB_TRACE_MAX_SNAPSHOTS = "10";
    process.env.PERF_LAB_TRACE_FETCH_SETTLE_MS = "1";
    process.env.PERF_LAB_JAEGER_API_BASE_URL = "http://jaeger.example";
    globalThis.fetch = async () => {
      fetchCount += 1;
      throw new Error("fetch should not run after exporter outage");
    };

    const context = { runId: "run-1", engine: "v2" };
    const perfCase = { id: "smoke/auth-user" };

    installPerfTraceCollector();
    resetPerfTraceRefs();
    setPerfTraceFlush(async () => {
      throw new Error("connect ECONNREFUSED 136.119.178.56:4318");
    });

    recordPerfTraceRefFromHeaders({
      context,
      perfCase,
      stepId: "authUserMs",
      headers: {
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
        link: "<http://jaeger.example/trace/11111111111111111111111111111111>; rel=trace",
      },
      method: "GET",
      url: "http://127.0.0.1/api/auth/user",
      status: 200,
    });

    const summary = await writeTraceArtifacts({
      artifactDir,
      perfCase,
      engine: "v2",
    });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    assert.equal(fetchCount, 0);
    assert.equal(summary.savedTraceCount, 0);
    assert.equal(summary.failedTraceCount, 0);
    assert.equal(summary.skippedTraceCount, 1);
    assert.equal(summary.missingFetchCount, 0);
    assert.equal(summary.wastedFetchMs, 0);
    assert.match(
      summary.traceFetchSkippedReason,
      /Trace service unavailable; skipped Jaeger fetch/,
    );
    assert.deepEqual(manifest, JSON.parse(JSON.stringify(summary)));

    setPerfTraceFlush(undefined);
    resetPerfTraceRefs();
    process.env.PERF_LAB_TRACE_FETCH_TIMEOUT_MS = "1";
    process.env.PERF_LAB_TRACE_FETCH_POLL_INTERVAL_MS = "1";
    process.env.PERF_LAB_TRACE_FETCH_CONCURRENCY = "1";

    const fetchedTraceIds = [];
    globalThis.fetch = async (url) => {
      const traceId = String(url).split("/").at(-1);
      fetchedTraceIds.push(traceId);
      if (
        traceId === "22222222222222222222222222222222" ||
        traceId === "44444444444444444444444444444444" ||
        traceId === "55555555555555555555555555555555" ||
        traceId === "66666666666666666666666666666666"
      ) {
        return new Response(JSON.stringify({ data: [{ traceID: traceId }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 404 });
    };

    for (const traceId of [
      "11111111111111111111111111111111",
      "22222222222222222222222222222222",
      "33333333333333333333333333333333",
    ]) {
      recordPerfTraceRefFromHeaders({
        context,
        perfCase,
        stepId: "verifyRepeatedStep",
        headers: {
          traceparent: `00-${traceId}-2222222222222222-01`,
          link: `<http://jaeger.example/trace/${traceId}>; rel=trace`,
        },
        method: "GET",
        url: "http://127.0.0.1/api/table/tblTraceShape001/record",
        status: 200,
      });
    }
    recordPerfTraceRefFromHeaders({
      context,
      perfCase,
      stepId: "verifyRepeatedStep",
      headers: {
        traceparent: "00-44444444444444444444444444444444-2222222222222222-01",
        link: "<http://jaeger.example/trace/44444444444444444444444444444444>; rel=trace",
      },
      method: "GET",
      url: "http://127.0.0.1/api/table/tblTraceShape001/field",
      status: 200,
    });
    for (const traceId of [
      "55555555555555555555555555555555",
      "66666666666666666666666666666666",
    ]) {
      recordPerfTraceRefFromHeaders({
        context,
        perfCase,
        stepId: "createRepeatedField",
        headers: {
          traceparent: `00-${traceId}-2222222222222222-01`,
          link: `<http://jaeger.example/trace/${traceId}>; rel=trace`,
        },
        method: "POST",
        url: "http://127.0.0.1/api/table/tblTraceShape001/field",
        status: 201,
      });
    }

    const representativeSummary = await writeTraceArtifacts({
      artifactDir,
      perfCase,
      engine: "v2",
    });

    assert.equal(representativeSummary.traceRefCount, 6);
    assert.equal(representativeSummary.selectedTraceCount, 4);
    assert.equal(representativeSummary.savedTraceCount, 4);
    assert.equal(representativeSummary.failedTraceCount, 0);
    assert.equal(representativeSummary.skippedTraceCount, 2);
    assert.equal(representativeSummary.missingFetchCount, 1);
    assert.deepEqual(
      new Set(fetchedTraceIds),
      new Set([
        "11111111111111111111111111111111",
        "22222222222222222222222222222222",
        "44444444444444444444444444444444",
        "55555555555555555555555555555555",
        "66666666666666666666666666666666",
      ]),
    );
    assert.equal(
      representativeSummary.savedTraces.find(
        (trace) => trace.traceId === "33333333333333333333333333333333",
      )?.status,
      "skipped",
    );
    assert.match(
      representativeSummary.savedTraces.find(
        (trace) => trace.traceId === "33333333333333333333333333333333",
      )?.error,
      /representative for request shape verifyRepeatedStep GET \/api\/table\/:tbl\/record/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  console.log("Trace collector exporter outage checks ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
