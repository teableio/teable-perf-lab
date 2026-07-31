import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pinTrace, unpinTrace } from "../scripts/pin-perf-trace.mjs";
import {
  buildTraceDocument,
  collectPublishableTraces,
  publishTraceSite,
  pruneStaleRuns,
  slimJaegerTrace,
} from "../scripts/publish-trace-pages.mjs";

const traceA = "11111111111111111111111111111111";
const traceB = "22222222222222222222222222222222";

const viewerDir = "viewer";

const jaegerSnapshot = ({ traceId, spans }) => ({
  data: [
    {
      traceID: traceId,
      spans,
      processes: { p1: { serviceName: "teable-api", tags: [] } },
    },
  ],
  total: 0,
  limit: 0,
  offset: 0,
  errors: null,
});

const jaegerSpan = ({
  spanID,
  parentSpanID,
  operationName = "op",
  startTime = 1_000,
  duration = 100,
  tags = [],
}) => ({
  traceID: traceA,
  spanID,
  operationName,
  startTime,
  duration,
  processID: "p1",
  tags,
  references: parentSpanID
    ? [{ refType: "CHILD_OF", traceID: traceA, spanID: parentSpanID }]
    : [],
});

// One execute artifact: a perf payload whose reconciled trace manifest points at
// a stored Jaeger snapshot, exactly as the publish step leaves it.
const writeArtifact = async ({
  artifactDir,
  caseId,
  engine,
  traceId,
  snapshot,
  savedStatus = "saved",
}) => {
  const artifactRoot = join(artifactDir, `teable-ee-e2e-perf-${engine}-1-1`);
  const traceRelativeDir = join("traces", `${caseId}-${engine}`);
  await mkdir(join(artifactRoot, traceRelativeDir), { recursive: true });

  const snapshotName = `step-0-${traceId}.json`;
  if (snapshot) {
    await writeFile(
      join(artifactRoot, traceRelativeDir, snapshotName),
      JSON.stringify(snapshot),
    );
  }

  const manifest = {
    enabled: true,
    artifactDir: traceRelativeDir,
    manifestPath: join(traceRelativeDir, "manifest.json"),
    selectedTraceIds: [traceId],
    refs: [{ traceId, stepId: "step:0", sampled: true }],
    savedTraces: [
      {
        traceId,
        stepId: "step:0",
        path:
          savedStatus === "saved" ? join(traceRelativeDir, snapshotName) : "",
        status: savedStatus,
      },
    ],
  };
  await writeFile(
    join(artifactRoot, traceRelativeDir, "manifest.json"),
    JSON.stringify(manifest),
  );
  await writeFile(
    join(artifactRoot, `${caseId}-${engine}.json`),
    JSON.stringify({
      caseId,
      engine,
      title: `${caseId} title`,
      result: "pass",
      durationMs: 4321,
      metrics: [],
      thresholds: [],
      details: { observability: { traces: manifest } },
    }),
  );
};

const withTempDir = async (prefix, run) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("slims a Jaeger snapshot into a viewer document", () => {
  const document = slimJaegerTrace({
    snapshot: jaegerSnapshot({
      traceId: traceA,
      spans: [
        jaegerSpan({
          spanID: "child",
          parentSpanID: "root",
          startTime: 2_000,
          tags: [
            { key: "db.query.text", type: "string", value: "x".repeat(9_000) },
          ],
        }),
        jaegerSpan({
          spanID: "root",
          operationName: "POST /api/record",
          startTime: 1_000,
          duration: 5_000,
          tags: [{ key: "http.status_code", type: "int64", value: 201 }],
        }),
      ],
    }),
    traceId: traceA,
    maxTagBytes: 64,
  });

  assert.equal(document.traceId, traceA);
  assert.equal(document.spanCount, 2);
  assert.equal(document.droppedSpanCount, 0);
  // Start order, not snapshot order: the waterfall reads top to bottom.
  assert.deepEqual(
    document.spans.map((span) => span.id),
    ["root", "child"],
  );
  assert.equal(document.spans[0].parentId, undefined);
  assert.equal(document.spans[1].parentId, "root");
  assert.equal(document.spans[0].service, "teable-api");
  assert.equal(document.spans[0].tags["http.status_code"], "201");
  assert.match(
    document.spans[1].tags["db.query.text"],
    /^x{64}…\[\+8936 bytes\]$/,
  );
  assert.equal(document.droppedTagBytes, 8_936);
});

test("caps the spans a single trace can publish", () => {
  const document = slimJaegerTrace({
    snapshot: jaegerSnapshot({
      traceId: traceA,
      spans: Array.from({ length: 40 }, (_, index) =>
        jaegerSpan({ spanID: `s${index}`, startTime: index }),
      ),
    }),
    traceId: traceA,
    maxSpans: 10,
  });

  assert.equal(document.spanCount, 40);
  assert.equal(document.spans.length, 10);
  assert.equal(document.droppedSpanCount, 30);
});

test("publishes the linked trace per result and skips results without one", async () => {
  await withTempDir("trace-site-publish-", async (root) => {
    const artifactDir = join(root, "artifacts");
    await writeArtifact({
      artifactDir,
      caseId: "alpha-case",
      engine: "v2",
      traceId: traceA,
      snapshot: jaegerSnapshot({
        traceId: traceA,
        spans: [jaegerSpan({ spanID: "root" })],
      }),
    });
    await writeArtifact({
      artifactDir,
      caseId: "beta-case",
      engine: "v1",
      traceId: traceB,
      savedStatus: "missing",
    });

    const { publishable, skipped } = await collectPublishableTraces({
      artifactDir,
    });
    assert.deepEqual(
      publishable.map(({ payload }) => payload.caseId),
      ["alpha-case"],
    );
    assert.deepEqual(
      skipped.map(({ caseId, reason }) => ({ caseId, reason })),
      [
        {
          caseId: "beta-case",
          reason: "primary trace has no stored Jaeger snapshot",
        },
      ],
    );

    const siteDir = join(root, "site");
    const summary = await publishTraceSite({
      artifactDir,
      siteDir,
      viewerDir,
      runId: "run-1",
      runUrl: "https://example/run-1",
      teableEeRef: "abc123",
      publishedAt: "2026-07-31T00:00:00.000Z",
    });

    assert.equal(summary.publishedTraceCount, 1);
    assert.equal(summary.skipped.length, 1);

    const document = JSON.parse(
      await readFile(join(siteDir, "r", "run-1", `${traceA}.json`), "utf8"),
    );
    assert.equal(document.runId, "run-1");
    assert.equal(document.case.caseId, "alpha-case");
    assert.equal(document.case.durationMs, 4321);
    assert.equal(document.case.runUrl, "https://example/run-1");

    const index = JSON.parse(
      await readFile(join(siteDir, "r", "run-1", "index.json"), "utf8"),
    );
    assert.equal(index.teableEeRef, "abc123");
    assert.deepEqual(
      index.traces.map((trace) => trace.traceId),
      [traceA],
    );

    const runs = JSON.parse(await readFile(join(siteDir, "runs.json"), "utf8"));
    assert.deepEqual(
      runs.runs.map((run) => run.runId),
      ["run-1"],
    );

    // The viewer ships with the data it renders, so a published site is
    // self-contained rather than depending on a separately deployed app.
    for (const fileName of ["index.html", "trace.html", ".nojekyll"]) {
      await readFile(join(siteDir, fileName), "utf8");
    }
  });
});

test("prunes runs past the retention window but never the pinned copy", async () => {
  await withTempDir("trace-site-prune-", async (root) => {
    const artifactDir = join(root, "artifacts");
    await writeArtifact({
      artifactDir,
      caseId: "alpha-case",
      engine: "v2",
      traceId: traceA,
      snapshot: jaegerSnapshot({
        traceId: traceA,
        spans: [jaegerSpan({ spanID: "root" })],
      }),
    });

    const siteDir = join(root, "site");
    await publishTraceSite({
      artifactDir,
      siteDir,
      viewerDir,
      runId: "run-old",
      publishedAt: "2026-07-30T00:00:00.000Z",
    });
    await pinTrace({
      siteDir,
      runId: "run-old",
      traceId: traceA,
      pinnedAt: "2026-07-30T01:00:00.000Z",
    });

    const summary = await publishTraceSite({
      artifactDir,
      siteDir,
      viewerDir,
      runId: "run-new",
      publishedAt: "2026-07-31T02:00:00.000Z",
    });

    assert.deepEqual(
      summary.prunedRuns.map(({ runId }) => runId),
      ["run-old"],
    );
    assert.deepEqual(summary.retainedRuns, ["run-new"]);
    await assert.rejects(
      readFile(join(siteDir, "r", "run-old", "index.json"), "utf8"),
    );

    const pinned = JSON.parse(
      await readFile(join(siteDir, "pinned", `${traceA}.json`), "utf8"),
    );
    assert.equal(pinned.pinnedFromRunId, "run-old");
    assert.equal(pinned.case.caseId, "alpha-case");

    const pinnedIndex = JSON.parse(
      await readFile(join(siteDir, "pinned", "index.json"), "utf8"),
    );
    assert.deepEqual(
      pinnedIndex.traces.map((trace) => trace.traceId),
      [traceA],
    );

    await unpinTrace({ siteDir, traceId: traceA });
    assert.deepEqual(
      JSON.parse(await readFile(join(siteDir, "pinned", "index.json"), "utf8"))
        .traces,
      [],
    );
    await assert.rejects(
      unpinTrace({ siteDir, traceId: traceA }),
      /not pinned/,
    );
  });
});

test("publishes an empty run when the report job downloaded no artifacts", async () => {
  await withTempDir("trace-site-empty-", async (root) => {
    const siteDir = join(root, "site");
    const summary = await publishTraceSite({
      artifactDir: join(root, "never-downloaded"),
      siteDir,
      viewerDir,
      runId: "run-empty",
      publishedAt: "2026-07-31T00:00:00.000Z",
    });

    assert.equal(summary.publishedTraceCount, 0);
    const index = JSON.parse(
      await readFile(join(siteDir, "r", "run-empty", "index.json"), "utf8"),
    );
    assert.deepEqual(index.traces, []);
  });
});

test("never prunes the run being published, whatever the clock says", async () => {
  await withTempDir("trace-site-keep-", async (root) => {
    const siteDir = join(root, "site");
    const runDir = join(siteDir, "r", "run-now");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "index.json"),
      JSON.stringify({
        runId: "run-now",
        publishedAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    const stale = join(siteDir, "r", "run-stale");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "index.json"), "{ not json");

    const { removed, kept } = await pruneStaleRuns({
      siteDir,
      nowMs: Date.parse("2026-07-31T00:00:00.000Z"),
      retentionMs: 24 * 60 * 60 * 1000,
      keepRunId: "run-now",
    });

    assert.deepEqual(
      removed.map(({ runId }) => runId),
      ["run-stale"],
    );
    assert.deepEqual(
      kept.map(({ runId }) => runId),
      ["run-now"],
    );
  });
});

test("refuses to pin a trace the site no longer holds", async () => {
  await withTempDir("trace-site-pin-missing-", async (root) => {
    await assert.rejects(
      pinTrace({
        siteDir: root,
        runId: "run-gone",
        traceId: traceA,
        pinnedAt: "2026-07-31T00:00:00.000Z",
      }),
      /may already have been pruned/,
    );
  });
});

test("builds the document a result row links to", () => {
  const document = buildTraceDocument({
    payload: {
      caseId: "alpha-case",
      engine: "v2",
      title: "alpha",
      result: "fail",
      durationMs: 900,
      thresholds: [],
    },
    ref: { traceId: traceA, stepId: "step:3", url: "https://api.example/x" },
    snapshot: jaegerSnapshot({
      traceId: traceA,
      spans: [jaegerSpan({ spanID: "root" })],
    }),
    runId: "run-9",
    runUrl: "https://example/run-9",
  });

  assert.equal(document.traceId, traceA);
  assert.equal(document.runId, "run-9");
  assert.deepEqual(document.case, {
    caseId: "alpha-case",
    title: "alpha",
    engine: "v2",
    result: "fail",
    durationMs: 900,
    stepId: "step:3",
    url: "https://api.example/x",
    runUrl: "https://example/run-9",
  });
});

test("workflow publishes the viewer before reporting and gates on it", async () => {
  const workflow = await readFile(
    ".github/workflows/teable-ee-e2e-perf.yml",
    "utf8",
  );

  const publishSite = workflow.indexOf("- name: Publish trace viewer site");
  assert.ok(publishSite > 0);
  // Teable rows and the Feishu summary carry viewer links, so the site has to
  // exist before either goes out.
  assert.ok(
    publishSite < workflow.indexOf("- name: Report perf results to Teable"),
  );
  assert.ok(publishSite < workflow.indexOf("- name: Send Feishu perf summary"));
  assert.match(workflow, /steps\.trace-site\.outcome != 'success'/);
  assert.match(workflow, /steps\.trace-site\.outcome == 'failure'/);
  assert.match(
    workflow,
    /PERF_LAB_TRACE_VIEW_BASE_URL: "https:\/\/teableio\.github\.io\/teable-perf-lab"/,
  );
  // The engine's captured Link header would otherwise point at a retired host.
  assert.match(workflow, /TRACE_LINK_BASE_URL: ""/);
});
