import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildTraceViewUrl } from "./trace-view-url.js";
import { pinTrace, unpinTrace } from "../scripts/pin-perf-trace.mjs";
import {
  buildTraceDocument,
  collectPublishableTraces,
  enforceSiteBudget,
  publishTraceSite,
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

const siteBytes = async (directory) => {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory()
      ? await siteBytes(path)
      : (await stat(path)).size;
  }
  return total;
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

test("evicts the oldest run to stay in budget but never the pinned copy", async () => {
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

    // Exactly enough room for the site as it stands, so a second run has to
    // evict the first.
    const summary = await publishTraceSite({
      artifactDir,
      siteDir,
      viewerDir,
      runId: "run-new",
      publishedAt: "2026-07-31T02:00:00.000Z",
      budgetBytes: await siteBytes(siteDir),
    });

    assert.deepEqual(
      summary.evictedRuns.map(({ runId, reason }) => ({ runId, reason })),
      [{ runId: "run-old", reason: "site byte budget" }],
    );
    assert.deepEqual(summary.retainedRuns, ["run-new"]);
    assert.equal(summary.overBudgetBytes, 0);
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

test("publishes the trace under the id the result row links to", async () => {
  await withTempDir("trace-site-identity-", async (root) => {
    const artifactDir = join(root, "artifacts");
    await writeArtifact({
      artifactDir,
      caseId: "alpha-case",
      engine: "v2",
      traceId: traceA,
      // A snapshot that disagrees with the ref would otherwise be published
      // under its own id, leaving the row's link pointing at nothing.
      snapshot: jaegerSnapshot({
        traceId: traceB,
        spans: [jaegerSpan({ spanID: "root" })],
      }),
    });

    const siteDir = join(root, "site");
    await publishTraceSite({
      artifactDir,
      siteDir,
      viewerDir,
      runId: "run-1",
      publishedAt: "2026-07-31T00:00:00.000Z",
    });

    await readFile(join(siteDir, "r", "run-1", `${traceA}.json`), "utf8");
    const index = JSON.parse(
      await readFile(join(siteDir, "r", "run-1", "index.json"), "utf8"),
    );
    assert.deepEqual(
      index.traces.map((trace) => trace.traceId),
      [traceA],
    );
  });
});

// The URL builder and the publisher are separate owners; if they drift, the
// only symptom is a 404 nobody sees until they click a result row.
test("the link a result row carries resolves to a published file", async () => {
  await withTempDir("trace-site-url-", async (root) => {
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
      runId: "run-1",
      publishedAt: "2026-07-31T00:00:00.000Z",
    });

    const url = new URL(
      buildTraceViewUrl(traceA, "run-1", "https://viewer.example/site/"),
    );
    assert.equal(url.pathname, "/site/trace.html");
    // Exactly what viewer/trace.html fetches for those query parameters.
    await readFile(
      join(
        siteDir,
        "r",
        url.searchParams.get("run"),
        `${url.searchParams.get("trace")}.json`,
      ),
      "utf8",
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

test("keeps the newest runs that fit and drops an indexless directory", async () => {
  await withTempDir("trace-site-budget-", async (root) => {
    const siteDir = join(root, "site");
    const writeRun = async (runId, publishedAt, padding) => {
      const runDir = join(siteDir, "r", runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "index.json"),
        JSON.stringify({ runId, publishedAt, traces: [] }),
      );
      await writeFile(join(runDir, "trace.json"), "x".repeat(padding));
    };
    await writeRun("run-newest", "2026-07-31T00:00:00.000Z", 400);
    await writeRun("run-middle", "2026-07-30T00:00:00.000Z", 400);
    await writeRun("run-oldest", "2026-07-29T00:00:00.000Z", 400);
    // No index: nothing links to it and nothing can date it.
    await mkdir(join(siteDir, "r", "run-garbage"), { recursive: true });
    await writeFile(join(siteDir, "r", "run-garbage", "stray.json"), "junk");

    const budget = await enforceSiteBudget({
      siteDir,
      budgetBytes: 1_200,
      keepRunId: "run-newest",
    });

    assert.deepEqual(
      budget.kept.map(({ runId }) => runId),
      ["run-newest", "run-middle"],
    );
    assert.deepEqual(
      budget.evicted.map(({ runId, reason }) => ({ runId, reason })),
      [
        { runId: "run-garbage", reason: "no run index" },
        { runId: "run-oldest", reason: "site byte budget" },
      ],
    );
    assert.ok(budget.usedBytes <= budget.budgetBytes);
    assert.equal(budget.overBudgetBytes, 0);
  });
});

test("keeps the published run even when it alone busts the budget", async () => {
  await withTempDir("trace-site-overbudget-", async (root) => {
    const siteDir = join(root, "site");
    const runDir = join(siteDir, "r", "run-now");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "index.json"),
      JSON.stringify({
        runId: "run-now",
        publishedAt: "2026-07-31T00:00:00.000Z",
      }),
    );
    await writeFile(join(runDir, "trace.json"), "x".repeat(5_000));

    const budget = await enforceSiteBudget({
      siteDir,
      budgetBytes: 1_000,
      keepRunId: "run-now",
    });

    // Dropping it would break the links the run is about to publish, so the
    // site goes over budget loudly instead of quietly losing this run.
    assert.deepEqual(
      budget.kept.map(({ runId }) => runId),
      ["run-now"],
    );
    assert.deepEqual(budget.evicted, []);
    assert.ok(budget.overBudgetBytes > 0);
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
