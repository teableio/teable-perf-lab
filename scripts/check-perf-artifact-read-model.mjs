import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  artifactJsonName,
  compactTraceManifest,
  extractSeedCacheIdentities,
  legacyArtifactJsonName,
  primaryMetricValue,
  readArtifactPayloads,
  readSeedCacheStatuses,
  readSeedObservationReport,
  readSeedObservations,
  readTraceManifests,
  resolvePrimaryTraceUrl,
  sanitizeCaseId,
  sanitizeSegment,
  summarizeSeedPayloadCoverage,
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
  await writeJson(join(tempDir, "manifest.json"), {
    traceFetchWaitMs: 100,
  });
  await writeFile(join(tempDir, "ignore.txt"), "not a payload");
  await writeJson(join(nestedArtifactDir, "manifest.json"), {
    traceFetchJobWaitMs: 200,
  });
  await writeJson(
    join(nestedArtifactDir, "seed-cache-status-shard-1-of-2.json"),
    { mode: "exact-hit", stableSlot: "slot-1" },
  );

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
          traceFetchWaitMs: 1500,
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

  const traceManifests = await readTraceManifests({ artifactDir: tempDir });
  assert.deepEqual(
    traceManifests.map(({ fileName, artifactName, manifest }) => ({
      fileName,
      artifactName,
      waitMs: manifest.traceFetchJobWaitMs ?? manifest.traceFetchWaitMs,
    })),
    [
      {
        fileName: "manifest.json",
        artifactName: undefined,
        waitMs: 100,
      },
      {
        fileName: `${artifactName}/manifest.json`,
        artifactName,
        waitMs: 200,
      },
    ],
  );
  assert.deepEqual(
    (await readSeedCacheStatuses({ artifactDir: tempDir })).map(
      ({ fileName, status }) => ({ fileName, status }),
    ),
    [
      {
        fileName: `${artifactName}/seed-cache-status-shard-1-of-2.json`,
        status: { mode: "exact-hit", stableSlot: "slot-1" },
      },
    ],
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
    traceFetchCaseBudgetMs: 15_000,
    traceFetchJobBudgetMs: 60_000,
    traceFetchWaitMs: 12_000,
    traceFetchJobWaitMs: 42_000,
    traceFetchBreakerState: "partial-loss",
    traceFetchBreakerReason: "partial loss threshold 3 reached",
    traceFetchRecoveryProbeCount: 1,
    traceFetchRecoverySucceeded: false,
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
  assert.equal(compacted.traceFetchCaseBudgetMs, 15_000);
  assert.equal(compacted.traceFetchJobBudgetMs, 60_000);
  assert.equal(compacted.traceFetchWaitMs, 12_000);
  assert.equal(compacted.traceFetchJobWaitMs, 42_000);
  assert.equal(compacted.traceFetchBreakerState, "partial-loss");
  assert.equal(compacted.traceFetchRecoveryProbeCount, 1);
  assert.equal(compacted.traceFetchRecoverySucceeded, false);
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

  assert.deepEqual(
    extractSeedCacheIdentities({
      details: {
        seed: {
          cache: {
            seedHash: "shared-seed",
            seedAffinity: "fixture/shared",
            cacheHit: false,
          },
          samples: [
            {
              cache: {
                seedHash: "sample-a",
                cacheHit: true,
              },
            },
            {
              cache: {
                seedHash: "sample-b",
                cacheHit: false,
              },
            },
          ],
        },
        prepare: {
          seedHash: "bare-prepare-seed",
          seedAffinity: "fixture/prepare",
          cacheHit: false,
        },
      },
    }),
    [
      {
        seedHash: "bare-prepare-seed",
        seedAffinity: "fixture/prepare",
        cacheHit: false,
        paths: ["details.prepare"],
      },
      {
        seedHash: "sample-a",
        cacheHit: true,
        paths: ["details.seed.samples[0].cache"],
      },
      {
        seedHash: "sample-b",
        cacheHit: false,
        paths: ["details.seed.samples[1].cache"],
      },
      {
        seedHash: "shared-seed",
        seedAffinity: "fixture/shared",
        cacheHit: false,
        paths: ["details.seed.cache"],
      },
    ],
  );

  const seedObservationDir = join(tempDir, "seed-observations");
  const seedShardOne = join(
    seedObservationDir,
    "teable-ee-e2e-perf-seed-shard-1-of-2-123-1",
  );
  const seedShardTwo = join(
    seedObservationDir,
    "teable-ee-e2e-perf-seed-shard-2-of-2-123-1",
  );
  await mkdir(seedShardOne, { recursive: true });
  await mkdir(seedShardTwo, { recursive: true });
  await writeJson(join(seedShardOne, "case-a-seed.json"), {
    caseId: "case/a",
    engine: "seed",
    durationMs: 12_000,
    details: {
      seed: {
        cache: {
          seedHash: "shared-seed",
          cacheHit: false,
        },
      },
    },
  });
  await writeJson(join(seedShardTwo, "case-b-seed.json"), {
    caseId: "case/b",
    engine: "seed",
    durationMs: 9_000,
    details: {
      prepare: {
        seedHash: "shared-seed",
        cacheHit: false,
      },
    },
  });
  assert.deepEqual(
    await readSeedObservations({
      artifactDir: seedObservationDir,
      affinityByCaseId: new Map([
        ["case/a", "fixture/shared"],
        ["case/b", "fixture/shared"],
      ]),
    }),
    [
      {
        caseId: "case/a",
        shard: "shard-1-of-2",
        seedHash: "shared-seed",
        affinityId: "fixture/shared",
        buildMs: 12_000,
        cacheHit: false,
        paths: ["details.seed.cache"],
      },
      {
        caseId: "case/b",
        shard: "shard-2-of-2",
        seedHash: "shared-seed",
        affinityId: "fixture/shared",
        buildMs: 9_000,
        cacheHit: false,
        paths: ["details.prepare"],
      },
    ],
  );
  const seedObservationPayloads = await readArtifactPayloads({
    artifactDir: seedObservationDir,
  });
  assert.deepEqual(
    summarizeSeedPayloadCoverage({
      payloadEntries: seedObservationPayloads,
      expectedCaseIds: ["case/a", "case/b"],
    }),
    {
      expectedCaseCount: 2,
      observedCaseCount: 2,
      missingCaseIds: [],
      unexpectedCaseIds: [],
      duplicateCaseIds: [],
      complete: true,
    },
  );
  assert.deepEqual(
    summarizeSeedPayloadCoverage({
      payloadEntries: [
        ...seedObservationPayloads,
        { payload: { caseId: "case/a", engine: "seed" } },
        { payload: { caseId: "case/unexpected", engine: "seed" } },
      ],
      expectedCaseIds: ["case/a", "case/b", "case/missing"],
    }),
    {
      expectedCaseCount: 3,
      observedCaseCount: 3,
      missingCaseIds: ["case/missing"],
      unexpectedCaseIds: ["case/unexpected"],
      duplicateCaseIds: ["case/a"],
      complete: false,
    },
  );

  const artifactOnlyAffinityDir = await mkdtemp(
    join(tmpdir(), "perf-artifact-orphan-affinity-"),
  );
  try {
    const artifactOnlyShard = join(
      artifactOnlyAffinityDir,
      "teable-ee-e2e-perf-seed-shard-1-of-1-123-1",
    );
    await mkdir(artifactOnlyShard, { recursive: true });
    await writeJson(join(artifactOnlyShard, "case-orphan-seed.json"), {
      caseId: "case/orphan",
      engine: "seed",
      details: {
        cache: {
          seedHash: "orphan-seed",
          seedAffinity: "fixture/orphan",
        },
      },
    });
    await assert.rejects(
      readSeedObservations({ artifactDir: artifactOnlyAffinityDir }),
      /artifact reports fixture\/orphan but the planner has no declaration \(seed orphan-seed, shard-1-of-1\)/,
    );
    assert.deepEqual(
      await readSeedObservationReport({
        artifactDir: artifactOnlyAffinityDir,
      }),
      {
        observations: [
          {
            caseId: "case/orphan",
            shard: "shard-1-of-1",
            seedHash: "orphan-seed",
            buildMs: 0,
            paths: ["details.cache"],
          },
        ],
        issues: [
          {
            issue: "artifact-affinity-without-declaration",
            caseId: "case/orphan",
            shard: "shard-1-of-1",
            seedHash: "orphan-seed",
            artifactAffinity: "fixture/orphan",
          },
        ],
        payloadEntries: [
          {
            payload: {
              caseId: "case/orphan",
              engine: "seed",
              details: {
                cache: {
                  seedHash: "orphan-seed",
                  seedAffinity: "fixture/orphan",
                },
              },
            },
            payloadPath: join(artifactOnlyShard, "case-orphan-seed.json"),
            fileName: `${artifactOnlyShard.split("/").at(-1)}/case-orphan-seed.json`,
            artifactName: artifactOnlyShard.split("/").at(-1),
          },
        ],
      },
    );
  } finally {
    await rm(artifactOnlyAffinityDir, { recursive: true, force: true });
  }

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
