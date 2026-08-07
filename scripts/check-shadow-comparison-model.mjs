import assert from "node:assert/strict";
import { accumulate, reconcileRun } from "./shadow-comparison-model.mjs";

// --- one run ----------------------------------------------------------------

{
  const run = reconcileRun({
    oldFlagged: ["a", "b", "c", "d"],
    newFlagged: ["a", "e"],
    unjudged: ["d"],
    confirmed: [{ caseId: "z", commit: "abc" }],
  });
  assert.deepEqual(run.agreed, ["a"]);
  // b and c: the gate fired, the new system judged them and said no.
  assert.deepEqual(run.oldOnly, ["b", "c"]);
  // d: the new system did not disagree, it abstained. Counting an abstention as
  // "looks fine" credits a judgement that was never made.
  assert.deepEqual(run.oldOnlyUnjudged, ["d"]);
  assert.deepEqual(run.newOnly, ["e"]);
  assert.equal(run.counts.confirmed, 1);
}

// The two systems agreeing on everything is a real outcome and must not be
// mistaken for an empty result.
{
  const run = reconcileRun({ oldFlagged: ["a"], newFlagged: ["a"] });
  assert.deepEqual(run.agreed, ["a"]);
  assert.deepEqual(run.oldOnly, []);
  assert.deepEqual(run.newOnly, []);
}

// A quiet run on both sides.
{
  const run = reconcileRun({});
  assert.deepEqual(run.counts, {
    old: 0,
    new: 0,
    agreed: 0,
    oldOnly: 0,
    oldOnlyUnjudged: 0,
    newOnly: 0,
    confirmed: 0,
    unjudged: 0,
  });
}

// Duplicates in either list are the same case, not two.
assert.equal(
  reconcileRun({ oldFlagged: ["a", "a"], newFlagged: [] }).counts.old,
  1,
);

// --- accumulating -----------------------------------------------------------

const runs = Array.from({ length: 10 }, (_, index) =>
  reconcileRun({
    oldFlagged: ["shared", `noise-${index}`, "stale"],
    newFlagged: ["shared", "quiet-regression"],
  }),
);

{
  const total = accumulate(runs);
  assert.equal(total.runs, 10);
  // Two flagged by the new system each run, against three by the old.
  assert.equal(total.newPerRun, 2);
  assert.equal(total.oldPerRun, 3);
  // `stale` recurs every run and is one case; the per-run noise ids are ten.
  assert.equal(total.oldOnlyCases.length, 11);
}

// Section G needs ten runs and a finished review. Ten runs alone is not enough:
// what the new system dropped cannot be settled by counting, only by someone
// looking at it.
{
  const total = accumulate(runs);
  assert.equal(total.complete, false);
  assert.equal(total.review.unreviewed, 11);
}

// Fewer than ten runs is not evidence however complete the review.
{
  const reviewed = Object.fromEntries(
    accumulate(runs).oldOnlyCases.map((caseId) => [caseId, "noise"]),
  );
  assert.equal(accumulate(runs.slice(0, 5), { reviewed }).complete, false);
}

// Ten runs and every dropped case reviewed: now it is evidence.
{
  const reviewed = Object.fromEntries(
    accumulate(runs).oldOnlyCases.map((caseId) => [caseId, "noise"]),
  );
  const total = accumulate(runs, { reviewed });
  assert.equal(total.complete, true);
  assert.equal(total.review.noise, 11);
  assert.equal(total.review.real, 0);
}

// A dropped case reviewed as real is the finding that would stop a switch, and
// it has to survive into the summary rather than being averaged away.
{
  const cases = accumulate(runs).oldOnlyCases;
  const reviewed = Object.fromEntries(cases.map((c) => [c, "noise"]));
  reviewed.stale = "real";
  const total = accumulate(runs, { reviewed });
  assert.equal(total.review.real, 1);
  assert.equal(total.complete, true);
}

// An unrecognised verdict counts as unreviewed. A typo must not be able to
// quietly complete the review.
{
  const reviewed = Object.fromEntries(
    accumulate(runs).oldOnlyCases.map((caseId) => [caseId, "propably noise"]),
  );
  assert.equal(accumulate(runs, { reviewed }).complete, false);
}

console.log("shadow comparison model checks passed");
