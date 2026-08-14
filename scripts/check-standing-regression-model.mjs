import assert from "node:assert/strict";
import {
  attributeStanding,
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

// --- which commit did it --------------------------------------------------------

const changePoint = ({
  caseId,
  before,
  after,
  v2Before,
  v2After,
  mover = "v2",
  ...rest
}) => ({
  caseId,
  beforeCommit: before,
  afterCommit: after,
  ratio: v2After / v2Before,
  mover,
  v2Level: { before: v2Before, after: v2After },
  ...rest,
});

{
  const rows = attributeStanding({
    standing: [{ caseId: "climber" }, { caseId: "quiet" }, { caseId: "noisy" }],
    confirmed: [
      // Two steps on one case, out of order, so the join has to rank rather
      // than take the first. The fanout cases climbed four consecutive
      // mainline commits; naming the smaller of two would name the wrong one.
      changePoint({
        caseId: "climber",
        before: "aaaa1111",
        after: "bbbb2222",
        v2Before: 400,
        v2After: 520,
      }),
      changePoint({
        caseId: "climber",
        before: "cccc3333",
        after: "dddd4444",
        v2Before: 520,
        v2After: 1200,
        alsoPossible: ["eeee5555"],
        unmeasuredBetween: 3,
      }),
      // Another case's change point must not leak onto a row.
      changePoint({
        caseId: "someone-else",
        before: "ffff6666",
        after: "99997777",
        v2Before: 100,
        v2After: 900,
      }),
    ],
    unjudged: ["noisy"],
  });

  assert.equal(rows[0].introducedBy.beforeCommit, "cccc3333");
  assert.equal(rows[0].introducedBy.afterCommit, "dddd4444");
  assert.deepEqual(rows[0].introducedBy.alsoPossible, ["eeee5555"]);
  assert.equal(rows[0].introducedBy.unmeasuredBetween, 3);
  assert.equal(rows[0].otherSteps, 1, "the smaller step is counted, not lost");
  assert.equal(rows[0].unattributed, undefined);

  // Detected on, no boundary confirmed: a slope, and there is no commit to
  // name. Distinguished from the next one because they are different problems.
  assert.equal(rows[1].introducedBy, undefined);
  assert.equal(rows[1].unattributed, "no-step");

  // Never eligible for detection at all. This is the case the standing list was
  // built to reach, so its row has to say why it carries no SHA rather than
  // looking like a lookup that came back empty.
  assert.equal(rows[2].unattributed, "screened");
}

// A speedup is not what made a case standing, and a `v1` mover is the control
// channel moving. Neither may be named as the cause; a row with only these is
// unattributed rather than attributed to the wrong thing.
{
  const [row] = attributeStanding({
    standing: [{ caseId: "x" }],
    confirmed: [
      changePoint({
        caseId: "x",
        before: "1111",
        after: "2222",
        v2Before: 900,
        v2After: 400,
      }),
      changePoint({
        caseId: "x",
        before: "3333",
        after: "4444",
        v2Before: 37,
        v2After: 40,
        mover: "v1",
        ratio: 2.2,
      }),
    ],
  });
  assert.equal(row.introducedBy, undefined);
  assert.equal(row.unattributed, "no-step");
}

// The rows come back in the order they went in, and nothing else on them is
// disturbed — the card sorts on `pairedDrift` and prints `v2Then`/`v2Now`.
{
  const standing = [
    { caseId: "a", pairedDrift: 2.5, v2Then: 100, v2Now: 250, points: 200 },
    { caseId: "b", pairedDrift: 1.4, v2Then: 500, v2Now: 700, points: 200 },
  ];
  const rows = attributeStanding({ standing, confirmed: [] });
  assert.deepEqual(
    rows.map((row) => row.caseId),
    ["a", "b"],
  );
  assert.equal(rows[0].pairedDrift, 2.5);
  assert.equal(rows[0].v2Now, 250);
  assert.equal(rows[1].points, 200);
}

// The row's own current level reaches the step filter, so a step the case has
// since come down from is not named. Without `v2Now` travelling through
// `attributeStanding`, the 10417ms spike is what the card would print.
{
  const [row] = attributeStanding({
    standing: [{ caseId: "spiked", v2Then: 1035, v2Now: 1616 }],
    confirmed: [
      changePoint({
        caseId: "spiked",
        before: "aaaa1111",
        after: "bbbb2222",
        v2Before: 1335,
        v2After: 10417,
      }),
      changePoint({
        caseId: "spiked",
        before: "cccc3333",
        after: "dddd4444",
        v2Before: 1004,
        v2After: 1113,
      }),
    ],
  });
  assert.equal(row.introducedBy.beforeCommit, "cccc3333");
  assert.equal(row.otherSteps, 0);
}

// And when every step is one the case has come down from, the row says there is
// no step rather than naming the least implausible one.
{
  const [row] = attributeStanding({
    standing: [{ caseId: "spiked", v2Then: 1035, v2Now: 1616 }],
    confirmed: [
      changePoint({
        caseId: "spiked",
        before: "aaaa1111",
        after: "bbbb2222",
        v2Before: 1335,
        v2After: 10417,
      }),
    ],
  });
  assert.equal(row.introducedBy, undefined);
  assert.equal(row.unattributed, "no-step");
}

// Nothing to join against is not an error. A run whose detection produced no
// confirmed points still has a standing list, and every row says why.
assert.deepEqual(attributeStanding(), []);
assert.equal(
  attributeStanding({ standing: [{ caseId: "a" }] })[0].unattributed,
  "no-step",
);

console.log("standing regression model checks passed");
