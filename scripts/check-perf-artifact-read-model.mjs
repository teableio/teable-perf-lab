import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  artifactJsonName,
  compactTraceManifest,
  legacyArtifactJsonName,
  primaryMetricValue,
  readArtifactPayloads,
  resolvePrimaryTraceUrl,
  sanitizeCaseId,
  sanitizeSegment,
  summaryMarkdownName,
  traceServiceOutage,
  traceWaste,
} from "./perf-artifact-read-model.mjs";

const writeJson = (path, value) => writeFile(path, JSON.stringify(value));

const tempDir = await mkdtemp(join(tmpdir(), "perf-artifact-read-model-"));

try {
  assert.equal(sanitizeCaseId("lookup/dual link"), "lookup-dual-link");
  assert.equal(sanitizeSegment("v2/hybrid computed"), "v2-hybrid-computed");
  assert.equal(
    artifactJsonName("lookup/dual link", "v2/hybrid computed"),
    "lookup-dual-link-v2-hybrid-computed.json",
  );
  assert.equal(
    legacyArtifactJsonName("lookup/dual link"),
    "lookup-dual-link.json",
  );
  assert.equal(
    summaryMarkdownName("lookup/dual link", "v2"),
    "summary-lookup-dual-link-v2.md",
  );

  const artifactName = "teable-ee-e2e-perf-v2-123-1";
  const nestedArtifactDir = join(tempDir, artifactName);
  await mkdir(nestedArtifactDir, { recursive: true });
  await writeFile(join(tempDir, "manifest.json"), "{}");
  await writeFile(join(tempDir, "ignore.txt"), "not a payload");
  await writeFile(join(nestedArtifactDir, "manifest.json"), "{}");

  const executePayload = {
    caseId: "lookup/dual-link",
    engine: "v2",
    result: "pass",
    durationMs: "456",
    thresholds: [{ metric: "readyMs", actual: 123, max: 1000, passed: true }],
    details: {
      observability: {
        traces: {
          refs: [
            { stepId: "http", traceId: "trace-a" },
            {
              stepId: "create formula field",
              traceId: "trace-b",
              traceLink: "https://trace.example/direct",
            },
          ],
          savedTraces: [
            { traceId: "trace-a", status: "saved" },
            { traceId: "trace-b", status: "saved" },
          ],
          missingFetchCount: 4,
          wastedFetchMs: 4000,
          fetchConcurrency: 2,
        },
      },
    },
  };
  const seedPayload = {
    caseId: "lookup/dual-link",
    engine: "seed",
    result: "pass",
  };
  await writeJson(
    join(nestedArtifactDir, "lookup-dual-link-v2.json"),
    executePayload,
  );
  await writeJson(join(tempDir, "lookup-dual-link-seed.json"), seedPayload);

  const allPayloads = await readArtifactPayloads({ artifactDir: tempDir });
  assert.deepEqual(allPayloads.map(({ payload }) => payload.engine).sort(), [
    "seed",
    "v2",
  ]);
  assert.equal(
    allPayloads.find(({ payload }) => payload.engine === "v2")?.artifactName,
    artifactName,
  );

  const executePayloads = await readArtifactPayloads({
    artifactDir: tempDir,
    includeSeed: false,
  });
  assert.deepEqual(
    executePayloads.map(({ payload }) => payload.engine),
    ["v2"],
  );

  assert.equal(primaryMetricValue(executePayload), 123);
  assert.equal(primaryMetricValue({ durationMs: "789", thresholds: [] }), 789);

  assert.equal(
    resolvePrimaryTraceUrl({
      payload: executePayload,
      traceBaseUrl: "https://jaeger.example/",
    }),
    "https://trace.example/direct",
  );
  assert.equal(
    resolvePrimaryTraceUrl({
      payload: {
        details: {
          observability: { traces: { refs: [{ traceId: "trace-c" }] } },
        },
      },
      traceBaseUrl: "https://jaeger.example/",
    }),
    "https://jaeger.example/trace/trace-c?uiEmbed=v0",
  );

  const compacted = compactTraceManifest({
    enabled: true,
    traceRefCount: 30,
    refs: Array.from({ length: 25 }, (_, index) => ({
      stepId: `step-${index}`,
      traceId: `trace-${index}`,
    })),
    savedTraces: [
      { traceId: "trace-1", status: "saved" },
      { traceId: "trace-2", status: "missing" },
    ],
  });
  assert.equal(compacted.refsSample.length, 20);
  assert.deepEqual(compacted.nonSavedTracesSample, [
    { traceId: "trace-2", status: "missing" },
  ]);

  assert.deepEqual(traceWaste([executePayload]), {
    missingCount: 4,
    wastedMs: 2000,
    byEngine: { v2: { missing: 4, wastedMs: 2000 } },
  });
  assert.deepEqual(traceServiceOutage([executePayload]), {
    skippedFetchCount: 0,
    byEngine: {},
  });
  assert.deepEqual(
    traceServiceOutage([
      {
        engine: "v2",
        details: {
          observability: {
            traces: {
              traceRefCount: 30,
              selectedTraceCount: 20,
              traceFetchSkippedReason:
                "Trace service unavailable; skipped Jaeger fetch: connect ECONNREFUSED 136.119.178.56:4318",
            },
          },
        },
      },
    ]),
    {
      skippedFetchCount: 20,
      byEngine: {
        v2: {
          skippedFetchCount: 20,
          reason:
            "Trace service unavailable; skipped Jaeger fetch: connect ECONNREFUSED 136.119.178.56:4318",
        },
      },
    },
  );

  const fallbackDir = await mkdtemp(join(tmpdir(), "perf-artifact-fallback-"));
  try {
    const [fallbackEntry] = await readArtifactPayloads({
      artifactDir: fallbackDir,
      fallbackCaseId: "missing/case",
      fallbackEngine: "v1",
      buildMissingPayload: ({ caseId, engine, payloadPath }) => ({
        caseId,
        engine,
        result: "fail",
        error: { message: `missing ${payloadPath}` },
      }),
    });
    assert.equal(fallbackEntry.payload.caseId, "missing/case");
    assert.equal(fallbackEntry.payload.engine, "v1");
    assert.match(fallbackEntry.payload.error.message, /missing-case\.json$/);
  } finally {
    await rm(fallbackDir, { recursive: true, force: true });
  }

  const emptyDir = await mkdtemp(join(tmpdir(), "perf-artifact-empty-"));
  try {
    assert.deepEqual(
      await readArtifactPayloads({ artifactDir: emptyDir, allowEmpty: true }),
      [],
    );
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }

  console.log("Perf artifact read model checks ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
