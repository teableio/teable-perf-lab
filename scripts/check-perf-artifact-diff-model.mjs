import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalize, VOLATILE } from "./perf-artifact-diff-model.mjs";

const execFileAsync = promisify(execFile);
const writeJson = (path, value) => writeFile(path, JSON.stringify(value));

const baseline = {
  caseId: "field-create/10k-create-5-formula-fields",
  runId: "run-a",
  startedAt: "2026-06-21T00:00:00.000Z",
  finishedAt: "2026-06-21T00:01:00.000Z",
  durationMs: 1234,
  metrics: { readyMs: 1234, preserved: "text" },
  thresholds: [{ metric: "readyMs", actual: 1234, max: 5000, passed: true }],
  details: {
    operation: "createFields",
    tableId: "tblA",
    fieldIds: ["fldA", "fldB"],
    verifiedSamples: [
      { recordId: "recA", expected: "ok", actual: "ok" },
      { recordId: "recB", expected: "ok", actual: "ok" },
    ],
    ready: { dbTableName: "table_a", semanticValue: "keep" },
    observability: { traces: { refs: [{ traceId: "trace-a" }] } },
  },
};

const sameBehavior = {
  ...baseline,
  runId: "run-b",
  startedAt: "2026-06-21T00:02:00.000Z",
  finishedAt: "2026-06-21T00:03:00.000Z",
  durationMs: 5678,
  metrics: { readyMs: 5678, preserved: "text" },
  thresholds: [{ metric: "readyMs", actual: 5678, max: 5000, passed: false }],
  details: {
    ...baseline.details,
    tableId: "tblB",
    fieldIds: ["fldC", "fldD"],
    verifiedSamples: [
      { recordId: "recC", expected: "ok", actual: "ok" },
      { recordId: "recD", expected: "ok", actual: "ok" },
    ],
    ready: { dbTableName: "table_b", semanticValue: "keep" },
    observability: { traces: { refs: [{ traceId: "trace-b" }] } },
  },
};

const changedBehavior = {
  ...sameBehavior,
  details: {
    ...sameBehavior.details,
    verifiedSamples: [
      { recordId: "recC", expected: "ok", actual: "wrong" },
      { recordId: "recD", expected: "ok", actual: "ok" },
    ],
  },
};

const normalized = normalize(baseline);
assert.equal(normalized.runId, VOLATILE);
assert.equal(normalized.durationMs, VOLATILE);
assert.equal(normalized.metrics.readyMs, VOLATILE);
assert.equal(normalized.metrics.preserved, "text");
assert.equal(normalized.thresholds[0].metric, "readyMs");
assert.equal(normalized.thresholds[0].max, 5000);
assert.equal(normalized.thresholds[0].actual, VOLATILE);
assert.equal(normalized.details.tableId, VOLATILE);
assert.equal(normalized.details.fieldIds, VOLATILE);
assert.equal(normalized.details.verifiedSamples[0].recordId, VOLATILE);
assert.equal(normalized.details.verifiedSamples[0].expected, "ok");
assert.equal(normalized.details.ready.dbTableName, VOLATILE);
assert.equal(normalized.details.ready.semanticValue, "keep");
assert.equal(normalized.details.observability, VOLATILE);
assert.deepEqual(normalize(sameBehavior), normalized);
assert.notDeepEqual(normalize(changedBehavior), normalized);

const tempDir = await mkdtemp(join(tmpdir(), "perf-artifact-diff-model-"));
try {
  const baselineFile = join(tempDir, "baseline.json");
  const sameFile = join(tempDir, "same.json");
  const changedFile = join(tempDir, "changed.json");
  await writeJson(baselineFile, baseline);
  await writeJson(sameFile, sameBehavior);
  await writeJson(changedFile, changedBehavior);

  const ok = await execFileAsync("node", [
    "scripts/diff-artifacts.mjs",
    baselineFile,
    sameFile,
  ]);
  assert.match(ok.stdout, /Artifact diff ok/);

  await assert.rejects(
    () =>
      execFileAsync("node", [
        "scripts/diff-artifacts.mjs",
        baselineFile,
        changedFile,
      ]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Artifact diff fail/);
      return true;
    },
  );
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("Perf artifact diff model checks ok");
