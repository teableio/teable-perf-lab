import assert from "node:assert/strict";
import {
  appendRun,
  assessShadow,
  BACKTEST_NEW_PER_RUN,
  qualifyingRuns,
  renderShadowProgress,
  runRecord,
} from "./shadow-accumulation-model.mjs";

// One run's shadow result, as `run-shadow-analysis.mjs` writes it.
const resultOf = ({
  runId = "1",
  flagged = 4,
  confirmed = 0,
  seenBefore = 5,
  source = "run",
  measured = 283,
  oldGate = { available: true, flagged: 117 },
} = {}) => ({
  runId,
  fast: {
    flagged: Array.from({ length: flagged }, (_, index) => ({
      caseId: `case-${index}`,
    })),
    judged: measured,
    source,
    measured,
  },
  confirmed: Array.from({ length: confirmed }, () => ({})),
  seenBefore,
  oldGate,
  reconciliation: { counts: { old: 117, agreed: 2 }, oldOnly: ["x"] },
});

const fullRun = (options = {}) =>
  runRecord({ result: resultOf(options), fullRun: true, at: "2026-08-10" });

// --- what counts as a run -----------------------------------------------------

// Ten single-case dispatches would re-report the same handful of cases ten
// times. That is what runs 31192079501 and 31193504224 did, and it is why G1
// says full runs.
{
  const ledger = [
    fullRun({ runId: "a" }),
    runRecord({ result: resultOf({ runId: "b" }), fullRun: false, at: "x" }),
  ];
  const { qualifying, rejected } = qualifyingRuns(ledger);
  assert.deepEqual(
    qualifying.map((run) => run.runId),
    ["a"],
  );
  assert.deepEqual(rejected, [{ runId: "b", reason: "not-a-full-run" }]);
}

// A full run whose same-run layer judged the tail of the corpus is a comparison
// of the old gate against days-old data, whatever it says on the tin.
assert.deepEqual(
  qualifyingRuns([fullRun({ runId: "a", source: "corpus-tail" })]).rejected,
  [{ runId: "a", reason: "judged-the-corpus-tail" }],
);

// Attempt 2 of a run measured the same commit and must not count twice toward
// the ten.
{
  let ledger = [];
  ledger = appendRun(ledger, fullRun({ runId: "a", flagged: 4 }));
  ledger = appendRun(ledger, fullRun({ runId: "a", flagged: 9 }));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].flagged, 9);
}

// --- G1 -----------------------------------------------------------------------

{
  const nine = Array.from({ length: 9 }, (_, index) =>
    fullRun({ runId: `r${index}` }),
  );
  assert.equal(assessShadow(nine).g1.met, false);
  assert.equal(assessShadow([...nine, fullRun({ runId: "r9" })]).g1.met, true);
}

// Nine full runs and a pile of single-case dispatches is still nine.
{
  const ledger = [
    ...Array.from({ length: 9 }, (_, index) => fullRun({ runId: `r${index}` })),
    ...Array.from({ length: 5 }, (_, index) =>
      runRecord({
        result: resultOf({ runId: `s${index}` }),
        fullRun: false,
        at: "x",
      }),
    ),
  ];
  const assessment = assessShadow(ledger);
  assert.equal(assessment.g1.runs, 9);
  assert.equal(assessment.g1.met, false);
  // And it says why the others did not count, rather than dropping them — "run
  // six of ten, and five dispatches this week did not count" is the sentence
  // that tells someone to stop dispatching single cases.
  assert.equal(assessment.g1.rejected.length, 5);
}

// --- G2 -----------------------------------------------------------------------

const tenAt = (flagged) =>
  Array.from({ length: 10 }, (_, index) =>
    fullRun({ runId: `r${index}`, flagged }),
  );

// The rate the backtest predicted, met.
{
  const assessment = assessShadow(tenAt(4));
  assert.equal(assessment.g2.met, true);
  assert.equal(assessment.g2.verdict, "within-band");
  assert.ok(assessment.g2.ratio > 1 && assessment.g2.ratio < 1.1);
}

// Well inside a factor of two, either side.
assert.equal(assessShadow(tenAt(7)).g2.verdict, "within-band");
assert.equal(assessShadow(tenAt(2)).g2.verdict, "within-band");

// Above the band the backtest understated the noise — or the shadow period
// genuinely had more going wrong in it, and counting cannot tell those apart.
// So this is not a failure verdict, it is a referral to the hand review.
{
  const assessment = assessShadow(tenAt(20));
  assert.equal(assessment.g2.met, false);
  assert.equal(assessment.g2.verdict, "above-band-needs-triage");
}

// Below the band is not the good news it reads as: a well-formed artifact
// reporting almost nothing is exactly what the shallow clone produced, twice.
{
  const assessment = assessShadow(tenAt(1));
  assert.equal(assessment.g2.met, false);
  assert.equal(assessment.g2.verdict, "below-band-check-inputs");
}

// Before ten runs there is no G2 verdict at all. A rate over three runs that
// happens to land inside the band is not the criterion being met early.
{
  const assessment = assessShadow(
    Array.from({ length: 3 }, (_, index) =>
      fullRun({ runId: `r${index}`, flagged: 4 }),
    ),
  );
  assert.equal(assessment.g2.met, false);
  assert.equal(assessment.g2.verdict, "not-enough-runs");
  // The rate is still reported, so progress is visible while it accumulates.
  assert.ok(assessment.g2.perRun > 0);
}

// The reference number is pinned in the repo, not recalled from a document
// during the comparison. G2 exists to catch a backtest that flattered itself.
assert.equal(BACKTEST_NEW_PER_RUN, 3.8);

// --- the cold start -----------------------------------------------------------

// The first successful run reports its whole recent history as new change
// points, because the seen-set starts empty. Averaging that in would put 75
// first sightings into a rate that is supposed to describe what changed.
{
  const ledger = [
    fullRun({ runId: "r0", confirmed: 75, seenBefore: 0 }),
    fullRun({ runId: "r1", confirmed: 2, seenBefore: 75 }),
  ];
  const assessment = assessShadow(ledger);
  assert.equal(assessment.confirmedRuns, 1);
  assert.equal(assessment.confirmedTotal, 2);
}

// --- what a watcher reads -----------------------------------------------------

{
  const text = renderShadowProgress([
    fullRun({ runId: "r0", seenBefore: 0 }),
    runRecord({ result: resultOf({ runId: "r1" }), fullRun: false, at: "x" }),
  ]);
  assert.match(text, /G1: 1 of 10/);
  assert.match(text, /not counted: 1 not-a-full-run/);
  assert.match(text, /G2: .*not-enough-runs/);
}

// --- the reconciliation has to have happened ---------------------------------

// The fault this guard exists for. `RELEASE_COMPARISON_PATH` pointed at the
// baseline file, which has no `regressions` key, so `old: 0, agreed: 0` came out
// of every run between 2026-08-08 and 2026-08-09 — the shape of perfect
// agreement, produced by never asking. G1 is ten runs *alongside the old
// report*; a run that never read its verdict is not one of them.
{
  const ledger = Array.from({ length: 12 }, (_, index) =>
    fullRun({
      runId: `r${index}`,
      oldGate: { available: false, reason: "not-a-comparison-file" },
    }),
  );
  const assessment = assessShadow(ledger);
  assert.equal(assessment.g1.runs, 0);
  assert.equal(assessment.g1.met, false);
  assert.equal(assessment.g2.met, false);
  assert.match(assessment.g1.rejected[0].reason, /no-old-gate-verdict/);
}

// A result written before the field existed reads as "not recorded", which is
// the correct verdict for those runs rather than a benefit of the doubt.
assert.equal(
  qualifyingRuns([
    runRecord({
      result: { fast: { source: "run" }, reconciliation: {} },
      fullRun: true,
      at: "x",
    }),
  ]).rejected[0].reason,
  "no-old-gate-verdict (not-recorded)",
);

// A run where the old gate genuinely had no baseline is a real state and still
// cannot be reconciled — recorded as unreconcilable, never as agreement.
assert.match(
  qualifyingRuns([
    fullRun({
      runId: "r0",
      oldGate: { available: false, reason: "no-release-baseline" },
    }),
  ]).rejected[0].reason,
  /no-release-baseline/,
);

console.log("shadow accumulation model checks passed");
