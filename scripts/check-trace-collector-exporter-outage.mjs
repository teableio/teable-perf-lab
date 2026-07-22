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
const fetchControlSource = await readFile(
  "framework/trace-fetch-control.ts",
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
const fetchControlOutput = ts.transpileModule(fetchControlSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "framework/trace-fetch-control.ts",
  reportDiagnostics: true,
});

const errors = [output, evidencePolicyOutput, fetchControlOutput]
  .flatMap((result) => result.diagnostics ?? [])
  .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
assert.equal(errors.length, 0);

const tempDir = await mkdtemp(join(tmpdir(), "perf-lab-trace-collector-"));
const collectorFile = join(tempDir, "trace-collector.mjs");
const classificationFile = join(tempDir, "trace-classification.mjs");
const evidencePolicyFile = join(tempDir, "trace-evidence-policy.mjs");
const fetchControlFile = join(tempDir, "trace-fetch-control.mjs");
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
      )
      .replace(
        'from "./trace-fetch-control"',
        'from "./trace-fetch-control.mjs"',
      ),
  );
  await writeFile(
    evidencePolicyFile,
    evidencePolicyOutput.outputText.replace(
      'from "./trace-classification"',
      'from "./trace-classification.mjs"',
    ),
  );
  await writeFile(fetchControlFile, fetchControlOutput.outputText);
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
    resetPerfTraceJobBudget,
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
    PERF_LAB_TRACE_CASE_BUDGET_MS: process.env.PERF_LAB_TRACE_CASE_BUDGET_MS,
    PERF_LAB_TRACE_JOB_BUDGET_MS: process.env.PERF_LAB_TRACE_JOB_BUDGET_MS,
    PERF_LAB_TRACE_PARTIAL_LOSS_THRESHOLD:
      process.env.PERF_LAB_TRACE_PARTIAL_LOSS_THRESHOLD,
    PERF_LAB_TRACE_RECOVERY_PROBE_LIMIT:
      process.env.PERF_LAB_TRACE_RECOVERY_PROBE_LIMIT,
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
    assert.equal(representativeSummary.selectedTraceCount, 4);
    assert.equal(representativeSummary.savedTraceCount, 4);
    assert.equal(representativeSummary.failedTraceCount, 0);
    assert.equal(representativeSummary.skippedTraceCount, 3);
    assert.equal(representativeSummary.missingFetchCount, 1);
    assert.deepEqual(
      new Set(fetchedTraceIds),
      new Set([
        "11111111111111111111111111111111",
        "22222222222222222222222222222222",
        "44444444444444444444444444444444",
        "55555555555555555555555555555555",
        "77777777777777777777777777777777",
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
