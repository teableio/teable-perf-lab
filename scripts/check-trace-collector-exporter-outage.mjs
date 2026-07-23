import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const source = await readFile("framework/trace-collector.ts", "utf8");
const atomicFileSource = await readFile("framework/atomic-file.js", "utf8");
const evidencePolicySource = await readFile(
  "framework/trace-evidence-policy.ts",
  "utf8",
);
const fetchControlSource = await readFile(
  "framework/trace-fetch-control.ts",
  "utf8",
);
const exportPolicySource = await readFile(
  "framework/trace-export-policy.ts",
  "utf8",
);
const runPerfCaseSource = await readFile("framework/run-perf-case.ts", "utf8");
const runPerfSeedSource = await readFile("framework/run-perf-seed.ts", "utf8");
const perfSpecSource = await readFile("perf-lab.e2e-spec.ts", "utf8");
assert.match(runPerfCaseSource, /deferPerfTraceDetails/);
assert.doesNotMatch(runPerfCaseSource, /writeTraceArtifacts/);
assert.match(runPerfSeedSource, /deferPerfTraceDetails/);
assert.doesNotMatch(runPerfSeedSource, /writeTraceArtifacts/);
assert.match(perfSpecSource, /finalizePerfTraceJobTailLifecycle/);
assert.ok(
  perfSpecSource.indexOf("finalizePerfTraceJobTailLifecycle({") <
    perfSpecSource.indexOf("await app?.close()"),
  "trace job tail must finish before the engine app closes",
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
const fetchControlOutput = ts.transpileModule(fetchControlSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "framework/trace-fetch-control.ts",
  reportDiagnostics: true,
});
const exportPolicyOutput = ts.transpileModule(exportPolicySource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "framework/trace-export-policy.ts",
  reportDiagnostics: true,
});

const errors = [
  output,
  evidencePolicyOutput,
  fetchControlOutput,
  exportPolicyOutput,
]
  .flatMap((result) => result.diagnostics ?? [])
  .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
assert.equal(errors.length, 0);

const tempDir = await mkdtemp(join(tmpdir(), "perf-lab-trace-collector-"));
const collectorFile = join(tempDir, "trace-collector.mjs");
const atomicFile = join(tempDir, "atomic-file.mjs");
const classificationFile = join(tempDir, "trace-classification.mjs");
const evidencePolicyFile = join(tempDir, "trace-evidence-policy.mjs");
const fetchControlFile = join(tempDir, "trace-fetch-control.mjs");
const exportPolicyFile = join(tempDir, "trace-export-policy.mjs");
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
      .replace(
        'from "@opentelemetry/api"',
        'from "./opentelemetry-api.mjs"',
      )
      .replace('from "@teable/openapi"', 'from "./teable-openapi.mjs"')
      .replace('from "axios"', 'from "./axios.mjs"')
      .replace('from "./atomic-file.js"', 'from "./atomic-file.mjs"')
      .replace(
        'from "./trace-evidence-policy"',
        'from "./trace-evidence-policy.mjs"',
      )
      .replace(
        'from "./trace-fetch-control"',
        'from "./trace-fetch-control.mjs"',
      )
      .replace(
        'from "./trace-export-policy"',
        'from "./trace-export-policy.mjs"',
      ),
  );
  await writeFile(atomicFile, atomicFileSource);
  await writeFile(
    evidencePolicyFile,
    evidencePolicyOutput.outputText.replace(
      'from "./trace-classification"',
      'from "./trace-classification.mjs"',
    ),
  );
  await writeFile(fetchControlFile, fetchControlOutput.outputText);
  await writeFile(exportPolicyFile, exportPolicyOutput.outputText);
  await writeFile(
    join(tempDir, "opentelemetry-api.mjs"),
    [
      "export const context = { active: () => ({}), with: (_context, callback) => callback() };",
      "export const trace = { setSpanContext: (activeContext, spanContext) => ({ ...activeContext, spanContext }), getSpanContext: (activeContext) => activeContext.spanContext };",
      "export const TraceFlags = { SAMPLED: 1 };",
    ].join("\n"),
  );
  await writeFile(
    join(tempDir, "axios.mjs"),
    "export const getAdapter = () => async () => ({ status: 200 });\n",
  );
  await writeFile(
    join(tempDir, "teable-openapi.mjs"),
    [
      "const interceptor = { use: () => 0, eject: () => undefined };",
      "export const axios = { defaults: {}, interceptors: { request: interceptor, response: interceptor } };",
    ].join("\n"),
  );

  const {
    deferPerfTraceDetails,
    deferTraceArtifacts,
    finalizePerfTraceJobTail,
    finalizePerfTraceJobTailLifecycle,
    installPerfTraceCollector,
    recordPerfTraceRefFromHeaders,
    resetPerfTraceJobBudget,
    resetPerfTraceRefs,
    resetPerfTraceJobTail,
    setPerfTraceFlush,
    buildPerfTraceHeaders,
    withPerfTraceStep,
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
    PERF_LAB_TRACE_CASE_BUDGET_MS: process.env.PERF_LAB_TRACE_CASE_BUDGET_MS,
    PERF_LAB_TRACE_JOB_BUDGET_MS: process.env.PERF_LAB_TRACE_JOB_BUDGET_MS,
    PERF_LAB_TRACE_FINALIZE_RESERVE_MS:
      process.env.PERF_LAB_TRACE_FINALIZE_RESERVE_MS,
    PERF_LAB_TRACE_PARTIAL_LOSS_THRESHOLD:
      process.env.PERF_LAB_TRACE_PARTIAL_LOSS_THRESHOLD,
    PERF_LAB_TRACE_RECOVERY_PROBE_LIMIT:
      process.env.PERF_LAB_TRACE_RECOVERY_PROBE_LIMIT,
    PERF_LAB_JAEGER_API_BASE_URL: process.env.PERF_LAB_JAEGER_API_BASE_URL,
    OTEL_EXPORT_RATIO: process.env.OTEL_EXPORT_RATIO,
  };
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  const reconcileTailArtifact = async (result) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (result.artifactDir && result.summary.manifestPath) {
      await writeFile(
        join(result.artifactDir, result.summary.manifestPath),
        JSON.stringify(result.summary, null, 2),
      );
    }
    return result.summary;
  };

  try {
    process.env.PERF_LAB_TRACE_ENABLED = "false";
    process.env.OTEL_EXPORT_RATIO = "0";
    assert.equal(
      withPerfTraceStep(
        { runId: "seed-run", engine: "seed" },
        { id: "seed/case" },
        "seedBuild",
        () => "seed-without-trace",
      ),
      "seed-without-trace",
    );

    process.env.PERF_LAB_TRACE_ENABLED = "true";
    process.env.OTEL_EXPORT_RATIO = "0.001";
    process.env.PERF_LAB_TRACE_MAX_SNAPSHOTS = "10";
    process.env.PERF_LAB_TRACE_FETCH_SETTLE_MS = "1";
    process.env.PERF_LAB_JAEGER_API_BASE_URL = "http://jaeger.example";
    globalThis.fetch = async () => {
      fetchCount += 1;
      throw new Error("fetch should not run after exporter outage");
    };

    const context = { runId: "run-1", engine: "v2" };
    const perfCase = { id: "smoke/auth-user" };

    const selectedHeaders = withPerfTraceStep(
      context,
      perfCase,
      "isolatedRequest",
      () => buildPerfTraceHeaders(context, perfCase, "isolatedRequest"),
      { checkpoint: { index: 0, total: 5 } },
    );
    assert.equal(selectedHeaders["x-teable-perf-trace-checkpoint"], "1");
    assert.match(selectedHeaders.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const ignoredRef = withPerfTraceStep(
      context,
      perfCase,
      "isolatedRequest",
      () =>
        recordPerfTraceRefFromHeaders({
          context,
          perfCase,
          stepId: "isolatedRequest",
          headers: selectedHeaders,
          status: 200,
        }),
      { checkpoint: { index: 1, total: 5 } },
    );
    assert.equal(ignoredRef, undefined);

    const recordDistinctTraceRefs = ({
      targetCase = perfCase,
      prefix,
      traceIds,
    }) => {
      for (const [index, traceId] of traceIds.entries()) {
        recordPerfTraceRefFromHeaders({
          context,
          perfCase: targetCase,
          stepId: `${prefix}-${index + 1}`,
          headers: {
            traceparent: `00-${traceId}-2222222222222222-01`,
          },
          method: "GET",
          url: `http://127.0.0.1/api/${prefix}/${index + 1}`,
          status: 200,
        });
      }
    };

    installPerfTraceCollector();
    resetPerfTraceJobBudget();
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
        traceId === "66666666666666666666666666666666" ||
        traceId === "77777777777777777777777777777777"
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
    for (const [index, traceId] of [
      "55555555555555555555555555555555",
      "66666666666666666666666666666666",
    ].entries()) {
      recordPerfTraceRefFromHeaders({
        context,
        perfCase,
        stepId: `createRepeatedField:${index + 1}`,
        headers: {
          traceparent: `00-${traceId}-2222222222222222-01`,
          link: `<http://jaeger.example/trace/${traceId}>; rel=trace`,
        },
        method: "POST",
        url: "http://127.0.0.1/api/table/tblTraceShape001/field",
        requestBody: {
          records: [{ fields: { Name: "same request shape" } }],
        },
        status: 201,
      });
    }
    recordPerfTraceRefFromHeaders({
      context,
      perfCase,
      stepId: "createRepeatedField:3",
      headers: {
        traceparent: "00-77777777777777777777777777777777-2222222222222222-01",
        link: "<http://jaeger.example/trace/77777777777777777777777777777777>; rel=trace",
      },
      method: "POST",
      url: "http://127.0.0.1/api/table/tblTraceShape001/field",
      requestBody: { recordIds: ["recDifferentWriteShape001"] },
      status: 201,
    });

    const representativeSummary = await writeTraceArtifacts({
      artifactDir,
      perfCase,
      engine: "v2",
    });

    assert.equal(representativeSummary.traceRefCount, 7);
    assert.equal(representativeSummary.selectedTraceCount, 7);
    assert.equal(representativeSummary.savedTraceCount, 5);
    assert.equal(representativeSummary.failedTraceCount, 2);
    assert.equal(representativeSummary.skippedTraceCount, 0);
    assert.equal(representativeSummary.missingFetchCount, 2);
    assert.deepEqual(
      new Set(fetchedTraceIds),
      new Set([
        "11111111111111111111111111111111",
        "22222222222222222222222222222222",
        "33333333333333333333333333333333",
        "44444444444444444444444444444444",
        "55555555555555555555555555555555",
        "66666666666666666666666666666666",
        "77777777777777777777777777777777",
      ]),
    );
    assert.equal(
      representativeSummary.savedTraces.find(
        (trace) => trace.traceId === "33333333333333333333333333333333",
      )?.status,
      "error",
    );
    assert.match(
      representativeSummary.savedTraces.find(
        (trace) => trace.traceId === "33333333333333333333333333333333",
      )?.error,
      /Jaeger API returned 404/,
    );

    resetPerfTraceRefs();
    resetPerfTraceJobBudget();
    fetchCount = 0;
    process.env.PERF_LAB_TRACE_FETCH_TIMEOUT_MS = "10";
    process.env.PERF_LAB_TRACE_FETCH_POLL_INTERVAL_MS = "1";
    process.env.PERF_LAB_TRACE_FETCH_CONCURRENCY = "1";
    process.env.PERF_LAB_TRACE_CASE_BUDGET_MS = "50";
    process.env.PERF_LAB_TRACE_JOB_BUDGET_MS = "100";
    process.env.PERF_LAB_TRACE_PARTIAL_LOSS_THRESHOLD = "2";
    process.env.PERF_LAB_TRACE_RECOVERY_PROBE_LIMIT = "1";
    globalThis.fetch = async () => {
      fetchCount += 1;
      throw new Error("connect ECONNREFUSED jaeger.example:16686");
    };
    recordDistinctTraceRefs({
      prefix: "hard-outage-shape",
      traceIds: [
        "88888888888888888888888888888888",
        "99999999999999999999999999999999",
        "99999999999999999999999999999999",
      ],
    });
    const hardOutageSummary = await writeTraceArtifacts({
      artifactDir,
      perfCase,
      engine: "v2",
    });
    assert.equal(fetchCount, 1);
    assert.equal(hardOutageSummary.failedTraceCount, 1);
    assert.equal(hardOutageSummary.traceRefCount, 3);
    assert.equal(hardOutageSummary.uniqueTraceCount, 2);
    assert.equal(hardOutageSummary.skippedTraceCount, 2);
    assert.equal(hardOutageSummary.traceFetchBreakerState, "hard-outage");
    assert.match(
      hardOutageSummary.traceFetchBreakerReason,
      /Jaeger unavailable: connect ECONNREFUSED/,
    );
    assert.equal(
      hardOutageSummary.savedTraceCount +
        hardOutageSummary.failedTraceCount +
        hardOutageSummary.skippedTraceCount,
      hardOutageSummary.traceRefCount,
    );

    resetPerfTraceRefs();
    resetPerfTraceJobBudget();
    fetchCount = 0;
    process.env.PERF_LAB_TRACE_FETCH_TIMEOUT_MS = "3";
    process.env.PERF_LAB_TRACE_FETCH_POLL_INTERVAL_MS = "1";
    process.env.PERF_LAB_TRACE_FETCH_CONCURRENCY = "1";
    process.env.PERF_LAB_TRACE_CASE_BUDGET_MS = "100";
    process.env.PERF_LAB_TRACE_JOB_BUDGET_MS = "200";
    process.env.PERF_LAB_TRACE_PARTIAL_LOSS_THRESHOLD = "2";
    process.env.PERF_LAB_TRACE_RECOVERY_PROBE_LIMIT = "1";
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [] }), { status: 404 });
    };
    recordDistinctTraceRefs({
      prefix: "partial-loss-shape",
      traceIds: [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "cccccccccccccccccccccccccccccccc",
        "dddddddddddddddddddddddddddddddd",
      ],
    });
    const partialLossSummary = await writeTraceArtifacts({
      artifactDir,
      perfCase,
      engine: "v2",
    });
    assert.equal(partialLossSummary.savedTraceCount, 0);
    assert.equal(partialLossSummary.failedTraceCount, 3);
    assert.equal(partialLossSummary.skippedTraceCount, 1);
    assert.equal(partialLossSummary.missingFetchCount, 3);
    assert.equal(partialLossSummary.traceFetchBreakerState, "partial-loss");
    assert.match(
      partialLossSummary.traceFetchBreakerReason,
      /recovery probe limit 1 exhausted/,
    );
    assert.equal(partialLossSummary.traceFetchRecoveryProbeCount, 1);
    assert.equal(partialLossSummary.traceFetchRecoverySucceeded, false);
    assert.ok(partialLossSummary.wastedFetchMs > 0);
    assert.ok(partialLossSummary.traceFetchWaitMs <= 100);
    assert.equal(partialLossSummary.refs.length, 4);
    assert.equal(
      partialLossSummary.savedTraceCount +
        partialLossSummary.failedTraceCount +
        partialLossSummary.skippedTraceCount,
      partialLossSummary.uniqueTraceCount,
    );

    resetPerfTraceRefs();
    resetPerfTraceJobBudget();
    fetchCount = 0;
    process.env.PERF_LAB_TRACE_FETCH_TIMEOUT_MS = "3";
    process.env.PERF_LAB_TRACE_PARTIAL_LOSS_THRESHOLD = "1";
    const recoveryTraceIds = [
      "1111111111111111111111111111111a",
      "2222222222222222222222222222222b",
      "3333333333333333333333333333333c",
    ];
    globalThis.fetch = async (url) => {
      fetchCount += 1;
      const traceId = String(url).split("/").at(-1);
      if (traceId === recoveryTraceIds[0]) {
        return new Response(JSON.stringify({ data: [] }), { status: 404 });
      }
      return new Response(JSON.stringify({ data: [{ traceID: traceId }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    recordDistinctTraceRefs({
      prefix: "recovery-shape",
      traceIds: recoveryTraceIds,
    });
    const recoverySummary = await writeTraceArtifacts({
      artifactDir,
      perfCase,
      engine: "v2",
    });
    assert.equal(recoverySummary.savedTraceCount, 2);
    assert.equal(recoverySummary.failedTraceCount, 1);
    assert.equal(recoverySummary.skippedTraceCount, 0);
    assert.equal(recoverySummary.missingFetchCount, 1);
    assert.equal(recoverySummary.traceFetchBreakerState, "recovered");
    assert.equal(recoverySummary.traceFetchRecoveryProbeCount, 1);
    assert.equal(recoverySummary.traceFetchRecoverySucceeded, true);
    assert.equal(
      recoverySummary.savedTraceCount +
        recoverySummary.failedTraceCount +
        recoverySummary.skippedTraceCount,
      recoverySummary.uniqueTraceCount,
    );

    const neverResolvingFetch = (_url, init = {}) => {
      fetchCount += 1;
      return new Promise((_, reject) => {
        const abort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init.signal?.aborted) {
          abort();
          return;
        }
        init.signal?.addEventListener("abort", abort, { once: true });
      });
    };

    resetPerfTraceRefs();
    resetPerfTraceJobBudget();
    fetchCount = 0;
    process.env.PERF_LAB_TRACE_FETCH_TIMEOUT_MS = "100";
    process.env.PERF_LAB_TRACE_CASE_BUDGET_MS = "12";
    process.env.PERF_LAB_TRACE_JOB_BUDGET_MS = "100";
    process.env.PERF_LAB_TRACE_PARTIAL_LOSS_THRESHOLD = "3";
    globalThis.fetch = neverResolvingFetch;
    recordDistinctTraceRefs({
      prefix: "case-budget-shape",
      traceIds: [
        "41111111111111111111111111111111",
        "42222222222222222222222222222222",
        "43333333333333333333333333333333",
      ],
    });
    const caseBudgetSummary = await writeTraceArtifacts({
      artifactDir,
      perfCase,
      engine: "v2",
    });
    assert.equal(fetchCount, 1);
    assert.equal(caseBudgetSummary.traceFetchBreakerState, "case-budget");
    assert.match(caseBudgetSummary.traceFetchBreakerReason, /case budget 12ms/);
    assert.ok(caseBudgetSummary.traceFetchWaitMs <= 12);
    assert.equal(caseBudgetSummary.failedTraceCount, 1);
    assert.equal(caseBudgetSummary.skippedTraceCount, 2);
    assert.equal(
      caseBudgetSummary.savedTraceCount +
        caseBudgetSummary.failedTraceCount +
        caseBudgetSummary.skippedTraceCount,
      caseBudgetSummary.uniqueTraceCount,
    );

    resetPerfTraceRefs();
    resetPerfTraceJobBudget();
    fetchCount = 0;
    process.env.PERF_LAB_TRACE_CASE_BUDGET_MS = "20";
    process.env.PERF_LAB_TRACE_JOB_BUDGET_MS = "10";
    globalThis.fetch = neverResolvingFetch;
    const firstJobBudgetCase = { id: "trace/job-budget-first" };
    recordDistinctTraceRefs({
      targetCase: firstJobBudgetCase,
      prefix: "job-budget-first-shape",
      traceIds: ["51111111111111111111111111111111"],
    });
    const firstJobBudgetSummary = await writeTraceArtifacts({
      artifactDir,
      perfCase: firstJobBudgetCase,
      engine: "v2",
    });
    assert.equal(firstJobBudgetSummary.traceFetchBreakerState, "job-budget");
    assert.equal(firstJobBudgetSummary.traceFetchJobWaitMs, 10);

    resetPerfTraceRefs();
    const secondJobBudgetCase = { id: "trace/job-budget-second" };
    recordDistinctTraceRefs({
      targetCase: secondJobBudgetCase,
      prefix: "job-budget-second-shape",
      traceIds: ["52222222222222222222222222222222"],
    });
    const fetchCountBeforeSecondJobCase = fetchCount;
    const secondJobBudgetSummary = await writeTraceArtifacts({
      artifactDir,
      perfCase: secondJobBudgetCase,
      engine: "v2",
    });
    assert.equal(fetchCount, fetchCountBeforeSecondJobCase);
    assert.equal(secondJobBudgetSummary.traceFetchBreakerState, "job-budget");
    assert.equal(secondJobBudgetSummary.traceFetchJobWaitMs, 10);
    assert.equal(secondJobBudgetSummary.failedTraceCount, 0);
    assert.equal(secondJobBudgetSummary.skippedTraceCount, 1);

    resetPerfTraceJobTail();
    resetPerfTraceJobBudget();
    fetchCount = 0;
    let batchFlushCount = 0;
    process.env.PERF_LAB_TRACE_FETCH_SETTLE_MS = "1";
    process.env.PERF_LAB_TRACE_FETCH_TIMEOUT_MS = "10";
    process.env.PERF_LAB_TRACE_FETCH_POLL_INTERVAL_MS = "1";
    process.env.PERF_LAB_TRACE_FETCH_CONCURRENCY = "1";
    process.env.PERF_LAB_TRACE_CASE_BUDGET_MS = "20";
    process.env.PERF_LAB_TRACE_JOB_BUDGET_MS = "60";
    process.env.PERF_LAB_TRACE_PARTIAL_LOSS_THRESHOLD = "3";
    process.env.PERF_LAB_TRACE_RECOVERY_PROBE_LIMIT = "1";
    setPerfTraceFlush(async () => {
      batchFlushCount += 1;
    });
    globalThis.fetch = async (url) => {
      fetchCount += 1;
      const traceId = String(url).split("/").at(-1);
      return new Response(JSON.stringify({ data: [{ traceID: traceId }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const healthyTailCases = [
      {
        perfCase: { id: "trace/job-tail-healthy-a" },
        traceId: "61111111111111111111111111111111",
      },
      {
        perfCase: { id: "trace/job-tail-healthy-b" },
        traceId: "62222222222222222222222222222222",
      },
    ];
    for (const { perfCase: tailCase, traceId } of healthyTailCases) {
      resetPerfTraceRefs();
      recordDistinctTraceRefs({
        targetCase: tailCase,
        prefix: `${tailCase.id}-shape`,
        traceIds: [traceId],
      });
      const pending = await deferTraceArtifacts({
        artifactDir,
        perfCase: tailCase,
        engine: "v2",
      });
      assert.equal(pending.traceFetchBreakerState, "pending-job-tail");
      assert.equal(pending.skippedTraceCount, 1);
    }
    assert.equal(batchFlushCount, 0);
    assert.equal(fetchCount, 0);

    const healthyTailStartedAt = Date.now();
    const healthyTailLifecycle = await finalizePerfTraceJobTailLifecycle({
      reconcileArtifact: reconcileTailArtifact,
    });
    const healthyTail = healthyTailLifecycle.results;
    const healthyTailElapsedMs = Date.now() - healthyTailStartedAt;
    assert.equal(batchFlushCount, 1);
    assert.equal(fetchCount, 2);
    assert.equal(healthyTail.length, 2);
    assert.deepEqual(
      healthyTail.map(({ perfCase: tailCase, summary: tailSummary }) => ({
        caseId: tailCase.id,
        saved: tailSummary.savedTraceCount,
        failed: tailSummary.failedTraceCount,
        skipped: tailSummary.skippedTraceCount,
      })),
      [
        {
          caseId: "trace/job-tail-healthy-a",
          saved: 1,
          failed: 0,
          skipped: 0,
        },
        {
          caseId: "trace/job-tail-healthy-b",
          saved: 1,
          failed: 0,
          skipped: 0,
        },
      ],
    );
    assert.ok(
      Math.max(
        ...healthyTail.map(({ summary: tailSummary }) =>
          Number(tailSummary.traceFetchJobWaitMs),
        ),
      ) <= 60,
    );
    assert.ok(healthyTailElapsedMs <= 60);
    for (const [index, result] of healthyTail.entries()) {
      const expectedCase = healthyTailCases[index].perfCase;
      assert.equal(result.perfCase.id, expectedCase.id);
      assert.equal(result.engine, "v2");
      assert.ok(
        result.summary.refs.every(
          (ref) => ref.caseId === expectedCase.id && ref.engine === "v2",
        ),
      );
      assert.match(
        result.summary.manifestPath,
        new RegExp(
          `traces/${expectedCase.id.replaceAll("/", "-")}-v2/manifest\\.json$`,
        ),
      );
      assert.ok(
        result.summary.savedTraces.every(
          (trace) =>
            trace.stepId.startsWith(`${expectedCase.id}-shape`) &&
            trace.path.includes(expectedCase.id.replaceAll("/", "-")),
        ),
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(
            join(artifactDir, result.summary.manifestPath),
            "utf8",
          ),
        ),
        JSON.parse(JSON.stringify(result.summary)),
      );
    }

    resetPerfTraceJobTail();
    resetPerfTraceJobBudget();
    fetchCount = 0;
    batchFlushCount = 0;
    process.env.PERF_LAB_TRACE_FETCH_TIMEOUT_MS = "3";
    process.env.PERF_LAB_TRACE_CASE_BUDGET_MS = "20";
    process.env.PERF_LAB_TRACE_JOB_BUDGET_MS = "60";
    process.env.PERF_LAB_TRACE_PARTIAL_LOSS_THRESHOLD = "2";
    process.env.PERF_LAB_TRACE_RECOVERY_PROBE_LIMIT = "1";
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [] }), { status: 404 });
    };
    const partialTailCases = [
      {
        perfCase: { id: "trace/job-tail-partial-a" },
        traceIds: [
          "71111111111111111111111111111111",
          "72222222222222222222222222222222",
          "73333333333333333333333333333333",
          "74444444444444444444444444444444",
        ],
      },
      {
        perfCase: { id: "trace/job-tail-partial-b" },
        traceIds: [
          "75555555555555555555555555555555",
          "76666666666666666666666666666666",
        ],
      },
    ];
    for (const { perfCase: tailCase, traceIds } of partialTailCases) {
      resetPerfTraceRefs();
      recordDistinctTraceRefs({
        targetCase: tailCase,
        prefix: `${tailCase.id}-shape`,
        traceIds,
      });
      await deferTraceArtifacts({
        artifactDir,
        perfCase: tailCase,
        engine: "v2",
      });
    }

    const partialTailStartedAt = Date.now();
    const partialTailLifecycle = await finalizePerfTraceJobTailLifecycle({
      reconcileArtifact: reconcileTailArtifact,
    });
    const partialTail = partialTailLifecycle.results;
    const partialTailElapsedMs = Date.now() - partialTailStartedAt;
    assert.equal(batchFlushCount, 1);
    assert.equal(partialTail.length, 2);
    assert.ok(
      partialTail.reduce(
        (total, { summary: tailSummary }) =>
          total + tailSummary.missingFetchCount,
        0,
      ) <= 3,
    );
    assert.equal(partialTail[0].summary.traceFetchBreakerState, "partial-loss");
    assert.equal(partialTail[1].summary.savedTraceCount, 0);
    assert.equal(partialTail[1].summary.failedTraceCount, 0);
    assert.equal(partialTail[1].summary.skippedTraceCount, 2);
    assert.match(
      partialTail[1].summary.traceFetchBreakerReason,
      /partial loss threshold 2 reached/,
    );
    assert.ok(partialTail[1].summary.traceFetchJobWaitMs <= 60);
    assert.ok(partialTailElapsedMs <= 60);

    resetPerfTraceJobTail();
    resetPerfTraceRefs();
    const tailFailureCase = { id: "trace/job-tail-write-failure" };
    const tailFailureArtifactDir = join(tempDir, "tail-failure-artifacts");
    recordDistinctTraceRefs({
      targetCase: tailFailureCase,
      prefix: "job-tail-write-failure-shape",
      traceIds: ["81111111111111111111111111111111"],
    });
    const interruptedSummary = await deferTraceArtifacts({
      artifactDir: tailFailureArtifactDir,
      perfCase: tailFailureCase,
      engine: "v2",
    });
    const interruptedManifest = JSON.parse(
      await readFile(
        join(tailFailureArtifactDir, interruptedSummary.manifestPath),
        "utf8",
      ),
    );
    assert.equal(
      interruptedManifest.traceFetchBreakerState,
      "pending-job-tail",
    );
    assert.equal(interruptedManifest.skippedTraceCount, 1);

    await rm(tailFailureArtifactDir, { recursive: true, force: true });
    await writeFile(tailFailureArtifactDir, "blocks trace directory writes");
    const failedTail = await finalizePerfTraceJobTail();
    assert.equal(failedTail.length, 1);
    assert.match(failedTail[0].tailError, /ENOTDIR|not a directory/i);
    assert.equal(failedTail[0].summary.traceFetchBreakerState, "tail-error");
    assert.equal(failedTail[0].summary.skippedTraceCount, 1);

    resetPerfTraceJobTail();
    resetPerfTraceRefs();
    const deferralFailureCase = { id: "trace/job-tail-deferral-failure" };
    const deferralFailureArtifactDir = join(
      tempDir,
      "deferral-failure-artifacts",
    );
    await writeFile(
      deferralFailureArtifactDir,
      "blocks provisional trace manifest writes",
    );
    recordDistinctTraceRefs({
      targetCase: deferralFailureCase,
      prefix: "job-tail-deferral-failure-shape",
      traceIds: ["82222222222222222222222222222222"],
    });
    const preservedDetails = await deferPerfTraceDetails({
      context: {
        ...context,
        artifactDir: deferralFailureArtifactDir,
      },
      perfCase: deferralFailureCase,
      details: { business: { preserved: true } },
    });
    assert.deepEqual(preservedDetails.business, { preserved: true });
    assert.equal(
      preservedDetails.observability.traces.traceFetchBreakerState,
      "tail-error",
    );
    assert.equal(preservedDetails.observability.traces.skippedTraceCount, 1);
    assert.match(
      preservedDetails.observability.traces.traceFetchBreakerReason,
      /Trace deferral failed before job tail.*ENOTDIR|Trace deferral failed before job tail.*not a directory/i,
    );

    resetPerfTraceJobTail();
    resetPerfTraceRefs();
    setPerfTraceFlush(undefined);
    fetchCount = 0;
    process.env.PERF_LAB_TRACE_FETCH_SETTLE_MS = "1";
    process.env.PERF_LAB_TRACE_FETCH_TIMEOUT_MS = "1000";
    process.env.PERF_LAB_TRACE_FETCH_CONCURRENCY = "1";
    process.env.PERF_LAB_TRACE_CASE_BUDGET_MS = "1000";
    process.env.PERF_LAB_TRACE_JOB_BUDGET_MS = "100";
    process.env.PERF_LAB_TRACE_FINALIZE_RESERVE_MS = "80";
    globalThis.fetch = neverResolvingFetch;
    const pendingFetchCases = Array.from({ length: 30 }, (_, index) => ({
      perfCase: { id: `trace/job-tail-pending-${index + 1}` },
      traceId:
        `${String(index + 1).padStart(2, "0")}3333333333333333333333333333333`.slice(
          0,
          32,
        ),
    }));
    for (const { perfCase: pendingCase, traceId } of pendingFetchCases) {
      resetPerfTraceRefs();
      recordDistinctTraceRefs({
        targetCase: pendingCase,
        prefix: `${pendingCase.id}-shape`,
        traceIds: [traceId],
      });
      await deferTraceArtifacts({
        artifactDir,
        perfCase: pendingCase,
        engine: "v2",
      });
    }
    const pendingFetchTailStartedAt = Date.now();
    const pendingFetchTailLifecycle =
      await finalizePerfTraceJobTailLifecycle({
        reconcileArtifact: reconcileTailArtifact,
      });
    const pendingFetchTail = pendingFetchTailLifecycle.results;
    const pendingFetchTailElapsedMs = Date.now() - pendingFetchTailStartedAt;
    assert.ok(
      pendingFetchTailElapsedMs <= 100,
      `pending fetch tail took ${pendingFetchTailElapsedMs}ms`,
    );
    assert.equal(pendingFetchTail.length, pendingFetchCases.length);
    assert.ok(
      pendingFetchTail.every(({ summary: tailSummary }) =>
        tailSummary.savedTraces.every((trace) =>
          ["saved", "missing", "error", "skipped"].includes(trace.status),
        ),
      ),
    );
    assert.ok(
      pendingFetchTail.every(
        ({ summary: tailSummary }) =>
          tailSummary.savedTraceCount +
            tailSummary.failedTraceCount +
            tailSummary.skippedTraceCount ===
          tailSummary.traceRefCount,
      ),
    );
    assert.match(
      pendingFetchTail.at(-1).summary.traceFetchBreakerReason,
      /job budget 100ms/,
    );
    assert.ok(
      pendingFetchTail.at(-1).summary.traceFetchJobWaitMs >=
        pendingFetchTailElapsedMs - 5,
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
