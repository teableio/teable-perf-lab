import assert from "node:assert/strict";
import {
  attributeChangePoints,
  harnessMoved,
  runnerSources,
} from "./harness-attribution-model.mjs";

assert.deepEqual(runnerSources("record-read"), [
  "framework/runners/record-read.runner.ts",
  "framework/runners/record-read-model.ts",
  "framework/runners/record-read-workload.ts",
]);
assert.deepEqual(runnerSources(""), []);
assert.deepEqual(runnerSources(undefined), []);

const perfLabAt = { eeA: "perf1", eeB: "perf2", eeC: "perf2" };

// The real incident: f60f31e7 changed what getRecordsQueryOverheadMs means for
// selective record-read variants, so a step across it has two candidate causes.
{
  const verdict = harnessMoved({
    runner: "record-read",
    beforeCommit: "eeA",
    afterCommit: "eeB",
    perfLabAt,
    changedPaths: {
      perf2: ["framework/runners/record-read-model.ts", "scripts/report.mjs"],
    },
  });
  assert.equal(verdict.moved, true);
  assert.deepEqual(verdict.paths, ["framework/runners/record-read-model.ts"]);
}

// A perf-lab change that did not touch this runner leaves attribution intact.
// 167 of 266 perf-lab commits touch some runner, so a rule that fired on any
// perf-lab change at all would downgrade nearly everything.
assert.equal(
  harnessMoved({
    runner: "record-read",
    beforeCommit: "eeA",
    afterCommit: "eeB",
    perfLabAt,
    changedPaths: { perf2: ["framework/runners/csv-import.runner.ts"] },
  }).moved,
  false,
);

// Same perf-lab commit either side: the apparatus is identical and cannot be
// the cause, whatever else that commit changed.
assert.equal(
  harnessMoved({
    runner: "record-read",
    beforeCommit: "eeB",
    afterCommit: "eeC",
    perfLabAt,
    changedPaths: { perf2: ["framework/runners/record-read-model.ts"] },
  }).moved,
  false,
);

// An unknown side is not evidence of interference. The corpus already cuts a
// series where the digest is unknown, and inventing a downgrade here would
// double-count the same uncertainty.
assert.equal(
  harnessMoved({
    runner: "record-read",
    beforeCommit: "eeA",
    afterCommit: "unknown",
    perfLabAt,
    changedPaths: {},
  }).moved,
  false,
);

// --- attaching verdicts -----------------------------------------------------

{
  const attributed = attributeChangePoints({
    points: [
      { caseId: "record-read/sort", beforeCommit: "eeA", afterCommit: "eeB" },
      { caseId: "csv-import/mixed", beforeCommit: "eeA", afterCommit: "eeB" },
    ],
    runnerOf: (caseId) => caseId.split("/")[0],
    perfLabAt,
    changedPaths: {
      perf2: ["framework/runners/record-read-model.ts"],
    },
  });
  assert.equal(attributed[0].attribution, "ambiguous");
  assert.deepEqual(attributed[0].harnessPaths, [
    "framework/runners/record-read-model.ts",
  ]);
  // A different runner is untouched by the same perf-lab commit.
  assert.equal(attributed[1].attribution, "confident");

  // Nothing is dropped. A harness change that shifted a case by 3x is still
  // worth attention, it just is not a product regression.
  assert.equal(attributed.length, 2);
}

console.log("harness attribution model checks passed");
