import assert from "node:assert/strict";
import {
  DRIFT_BAR,
  driftOf,
  EDGE_WINDOW,
  isStanding,
  MIN_INCREASE_MS,
  MIN_SEGMENT,
  standingRegressions,
} from "./standing-regression-model.mjs";

// A V2 series and its control, as the corpus holds them: `v2` in milliseconds,
// `paired` as log(v2) − log(v1) at the same commits.
const seriesOf = ({ from, to, points = 120, controlFrom, controlTo } = {}) => {
  const v1From = controlFrom ?? 1000;
  const v1To = controlTo ?? 1000;
  const at = (start, end, index) =>
    start + ((end - start) * index) / (points - 1);
  const v2 = [];
  const paired = [];
  for (let index = 0; index < points; index += 1) {
    const v2Value = at(from, to, index);
    const v1Value = at(v1From, v1To, index);
    v2.push(v2Value);
    paired.push(Math.log(v2Value) - Math.log(v1Value));
  }
  return { v2, paired };
};

// --- the drift itself ---------------------------------------------------------

{
  const { v2, paired } = seriesOf({ from: 400, to: 1200 });
  const drift = driftOf({ paired, v2 });
  // Ends are medians of 20 points, not the endpoints, so the measured drift is
  // a little short of 3x. That is the estimator being honest about where the
  // level sits rather than what the extremes happen to read.
  assert.ok(drift.v2Drift > 2.3 && drift.v2Drift < 3);
  assert.ok(drift.pairedDrift > 2.3 && drift.pairedDrift < 3);
  assert.equal(drift.points, 120);
  assert.equal(isStanding(drift), true);
}

// Flat is not standing, in either measurement.
assert.equal(isStanding(driftOf(seriesOf({ from: 500, to: 500 }))), false);

// Faster is not standing.
assert.equal(isStanding(driftOf(seriesOf({ from: 900, to: 400 }))), false);

// --- the control is what makes the list worth reading -------------------------

// The runner got slower and took both engines with it. On record this is
// `field-delete/50k-delete-active-field`: V2 drifted 1.70x, V1 drifted 1.54x
// over the same span, and 1.10x of that is the engine. Reading V2 alone puts
// three of these on the card.
{
  const drift = driftOf(
    seriesOf({ from: 550, to: 940, controlFrom: 1000, controlTo: 1540 }),
  );
  assert.ok(drift.v2Drift > DRIFT_BAR, "V2 alone would qualify");
  assert.ok(drift.pairedDrift < DRIFT_BAR, "against the control it does not");
  assert.equal(isStanding(drift), false);
}

// The opposite failure, and the reason `isStanding` tests both figures rather
// than the paired one alone. `field-duplicate/10k-duplicate-start-date-field`
// reads 204ms then 206ms with a control that improved 0.69x — a paired 1.47x
// describing a case that did not move.
{
  const drift = driftOf(
    seriesOf({ from: 204, to: 206, controlFrom: 1000, controlTo: 690 }),
  );
  assert.ok(drift.pairedDrift > DRIFT_BAR, "the pair separated");
  assert.ok(drift.v2Drift < DRIFT_BAR, "but V2 stayed where it was");
  assert.equal(isStanding(drift), false);
}

// The case this list exists to reach. `lookup/dual-link-computed-repoint-2k`
// has a control that moved 96x; V2's own 2.25x reads as a serious regression
// and the pair says it got relatively faster.
{
  const drift = driftOf(
    seriesOf({ from: 7000, to: 15750, controlFrom: 100, controlTo: 9600 }),
  );
  // 1.96x rather than the fixture's 2.25x endpoints: both ends are medians of
  // twenty points, so a ramp reads a little flatter than its extremes. That is
  // the estimator refusing to quote the noisiest point in the series, which is
  // the mistake the retracted "3.59x" headline was made of.
  assert.ok(drift.v2Drift > 1.9);
  assert.ok(drift.pairedDrift < 1);
  assert.equal(isStanding(drift), false);
}

// --- what it refuses to answer ------------------------------------------------

// Too short to have two ends with history between them.
assert.equal(driftOf(seriesOf({ from: 400, to: 1200, points: 40 })), undefined);
assert.equal(MIN_SEGMENT, 3 * EDGE_WINDOW);
assert.equal(driftOf({ paired: [], v2: [] }), undefined);
assert.equal(isStanding(undefined), false);

// A series that starts at zero has no ratio to report.
{
  const { v2, paired } = seriesOf({ from: 400, to: 1200 });
  const zeroed = v2.map((value, index) => (index < EDGE_WINDOW ? 0 : value));
  assert.equal(driftOf({ paired, v2: zeroed }), undefined);
}

// --- the list -----------------------------------------------------------------

{
  const cases = {
    slow: seriesOf({ from: 400, to: 1200 }),
    slower: seriesOf({ from: 400, to: 1600 }),
    flat: seriesOf({ from: 500, to: 500 }),
    runner: seriesOf({
      from: 550,
      to: 940,
      controlFrom: 1000,
      controlTo: 1540,
    }),
  };
  const series = Object.fromEntries(
    Object.keys(cases).map((caseId) => [
      `${caseId}::v2`,
      { caseId, engine: "v2" },
    ]),
  );
  // A V1 entry in the corpus must not produce a row of its own.
  series["slow::v1"] = { caseId: "slow", engine: "v1" };

  const rows = standingRegressions({
    series,
    pairedFor: (entry) => cases[entry.caseId],
  });
  assert.deepEqual(
    rows.map((row) => row.caseId),
    ["slower", "slow"],
  );

  assert.equal(
    standingRegressions({
      series,
      pairedFor: (entry) => cases[entry.caseId],
      limit: 1,
    }).length,
    1,
  );
}

// A case the corpus has no control for contributes nothing rather than being
// judged on V2 alone.
assert.deepEqual(
  standingRegressions({
    series: { "x::v2": { caseId: "x", engine: "v2" } },
    pairedFor: () => undefined,
  }),
  [],
);

// --- small in absolute terms ---------------------------------------------------

// The row that shipped on the first card and should not have: `smoke/auth-user`
// at 5ms → 11ms. A real 2.13x against its control, six milliseconds, and a
// smoke test rather than a perf case.
{
  const drift = driftOf(seriesOf({ from: 5, to: 11, points: 240 }));
  assert.ok(drift.pairedDrift > DRIFT_BAR, "the ratio qualifies");
  assert.ok(drift.v2Drift > DRIFT_BAR);
  assert.equal(isStanding(drift), false, "the magnitude does not");
}

// And the case that would be lost to a floor set on the baseline instead of on
// the increase: `duplicate-view/complex-grid-500fields-p95`, 55ms → 146ms.
// Small in absolute terms at the start, 91ms of increase, and a real find.
{
  const drift = driftOf(seriesOf({ from: 55, to: 146, points: 240 }));
  assert.ok(drift.v2Now - drift.v2Then >= MIN_INCREASE_MS);
  assert.equal(isStanding(drift), true);
}

// Exactly at the floor counts. A step rather than a ramp, so both edge medians
// are the exact values and the increase is exactly the floor — on a ramp they
// are pulled inward and the fixture would not test the boundary it claims to.
{
  const stepAt = (then, now, points = 240) => {
    const v2 = Array.from({ length: points }, (_, index) =>
      index < points / 2 ? then : now,
    );
    return { v2, paired: v2.map((value) => Math.log(value) - Math.log(1000)) };
  };
  const drift = driftOf(stepAt(40, 60));
  assert.equal(drift.v2Then, 40);
  assert.equal(drift.v2Now, 60);
  assert.equal(drift.v2Now - drift.v2Then, MIN_INCREASE_MS);
  assert.equal(isStanding(drift), true);

  // One millisecond under it does not.
  const under = driftOf(stepAt(40, 59));
  assert.ok(under.v2Now - under.v2Then < MIN_INCREASE_MS);
  assert.equal(isStanding(under), false);
}

console.log("standing regression model checks passed");
