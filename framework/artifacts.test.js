import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getArtifactJsonName,
  getSummaryMarkdownName,
  updatePerfArtifactTraceSummary,
  writePerfArtifacts,
} from "./artifacts.ts";
import { writeFileAtomically } from "./atomic-file.js";

const perfCase = { id: "trace/job-tail-artifact", title: "Trace job tail" };
const payload = {
  caseId: perfCase.id,
  title: perfCase.title,
  runId: "run-1",
  engine: "v2",
  appUrl: "http://127.0.0.1",
  result: "pass",
  startedAt: "2026-07-23T00:00:00.000Z",
  finishedAt: "2026-07-23T00:00:01.000Z",
  durationMs: 1_000,
  metrics: { readyMs: 900 },
  thresholds: [],
  details: {
    business: { preserved: true },
    observability: {
      logs: { preserved: true },
      traces: {
        traceFetchBreakerState: "pending-job-tail",
        traceRefCount: 1,
      },
    },
  },
};
const finalTraceSummary = {
  enabled: true,
  traceRefCount: 1,
  uniqueTraceCount: 1,
  selectedTraceCount: 1,
  savedTraceCount: 1,
  failedTraceCount: 0,
  skippedTraceCount: 0,
  missingFetchCount: 0,
  wastedFetchMs: 0,
  traceFetchCaseBudgetMs: 15_000,
  traceFetchJobBudgetMs: 60_000,
  traceFetchWaitMs: 5,
  traceFetchJobWaitMs: 10,
  traceFetchBreakerState: "closed",
  traceFetchRecoveryProbeCount: 0,
  traceFetchRecoverySucceeded: false,
  maxSnapshotCount: 100,
  fetchConcurrency: 8,
  refs: [],
  savedTraces: [],
  manifestPath: "traces/trace-job-tail-artifact-v2/manifest.json",
};

test("job-tail trace finalization rewrites observability without changing the measured result", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "perf-artifact-tail-"));
  try {
    await writePerfArtifacts(artifactDir, perfCase, payload);
    await updatePerfArtifactTraceSummary({
      artifactDir,
      perfCase,
      engine: "v2",
      traceSummary: finalTraceSummary,
    });

    const updated = JSON.parse(
      await readFile(
        join(artifactDir, getArtifactJsonName(perfCase.id, "v2")),
        "utf8",
      ),
    );
    assert.equal(updated.durationMs, 1_000);
    assert.deepEqual(updated.details.business, { preserved: true });
    assert.deepEqual(updated.details.observability.logs, { preserved: true });
    assert.deepEqual(updated.details.observability.traces, finalTraceSummary);

    const markdown = await readFile(
      join(artifactDir, getSummaryMarkdownName(perfCase.id, "v2")),
      "utf8",
    );
    assert.match(markdown, /saved JSON traces \| 1/);
    assert.doesNotMatch(markdown, /pending-job-tail/);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("atomic artifact replacement preserves the old payload when commit fails", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "perf-artifact-atomic-"));
  const payloadPath = join(artifactDir, "payload.json");
  try {
    await writeFile(payloadPath, '{"state":"old"}');
    await assert.rejects(
      writeFileAtomically(payloadPath, '{"state":"new"}', {
        renameFile: async () => {
          throw new Error("simulated interruption before atomic commit");
        },
      }),
      /simulated interruption/,
    );
    assert.deepEqual(JSON.parse(await readFile(payloadPath, "utf8")), {
      state: "old",
    });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("paired artifact writes settle before reporting one side's failure", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "perf-artifact-settle-"));
  let releaseSummaryWrite;
  let markPayloadAttempted;
  const summaryWriteGate = new Promise((resolve) => {
    releaseSummaryWrite = resolve;
  });
  const payloadAttempted = new Promise((resolve) => {
    markPayloadAttempted = resolve;
  });
  let settled = false;
  try {
    const writing = writePerfArtifacts(
      artifactDir,
      perfCase,
      payload,
      async (path, contents) => {
        if (path.endsWith(getArtifactJsonName(perfCase.id, "v2"))) {
          markPayloadAttempted();
          throw new Error("simulated payload write failure");
        }
        await summaryWriteGate;
        await writeFileAtomically(path, contents);
      },
    ).finally(() => {
      settled = true;
    });
    const observedWriting = writing.catch((error) => error);
    await payloadAttempted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    releaseSummaryWrite();
    assert.match(
      String(await observedWriting),
      /simulated payload write failure/,
    );
  } finally {
    releaseSummaryWrite?.();
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("trace rewrite failure converges payload, summary, and manifest on tail-error", async () => {
  const artifactDir = await mkdtemp(
    join(tmpdir(), "perf-artifact-tail-error-"),
  );
  try {
    await writePerfArtifacts(artifactDir, perfCase, payload);
    const manifestPath = join(artifactDir, finalTraceSummary.manifestPath);
    await mkdir(join(artifactDir, "traces", "trace-job-tail-artifact-v2"), {
      recursive: true,
    });
    await writeFile(
      manifestPath,
      JSON.stringify(payload.details.observability.traces),
    );

    let failOnce = true;
    const committed = await updatePerfArtifactTraceSummary({
      artifactDir,
      perfCase,
      engine: "v2",
      traceSummary: finalTraceSummary,
      writeArtifactFile: async (path, contents) => {
        if (failOnce && path.endsWith(getArtifactJsonName(perfCase.id, "v2"))) {
          failOnce = false;
          throw new Error("simulated payload commit failure");
        }
        await writeFileAtomically(path, contents);
      },
    });

    assert.equal(committed.traceFetchBreakerState, "tail-error");
    const updated = JSON.parse(
      await readFile(
        join(artifactDir, getArtifactJsonName(perfCase.id, "v2")),
        "utf8",
      ),
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const markdown = await readFile(
      join(artifactDir, getSummaryMarkdownName(perfCase.id, "v2")),
      "utf8",
    );
    assert.equal(
      updated.details.observability.traces.traceFetchBreakerState,
      "tail-error",
    );
    assert.equal(manifest.traceFetchBreakerState, "tail-error");
    assert.match(markdown, /tail-error/);
    assert.equal(updated.durationMs, payload.durationMs);
    assert.deepEqual(updated.details.business, payload.details.business);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
