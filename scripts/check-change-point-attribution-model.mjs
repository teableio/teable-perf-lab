import assert from "node:assert/strict";
import {
  attributeMovement,
  attributionCandidates,
  isRegression,
  levelsAcross,
  MOVEMENT_BAR,
  rankRegressions,
  RECOVERY_BAR,
  reportedFactor,
  survivingSteps,
} from "./change-point-attribution-model.mjs";

const sha = (char) => char.repeat(40);

// A series that steps from `before` to `after` at `boundary`.
const stepped = ({ from = 0, to = 40, boundary = 20, before, after }) =>
  Array.from({ length: to - from }, (_, index) => [
    from + index,
    from + index < boundary ? before : after,
  ]);

// --- levels either side -----------------------------------------------------

{
  const levels = levelsAcross(stepped({ before: 100, after: 200 }), 20);
  assert.equal(levels.before, 100);
  assert.equal(levels.after, 200);
  assert.equal(levels.ratio, 2);
  // Bounded by the window on both sides, so a case that moved twice is not
  // judged against a level from before the earlier move.
  assert.deepEqual(levels.points, { before: 8, after: 8 });
}

// The boundary ordinal is the first point *after* the change, matching the
// detector. Off by one here would attribute the moving point to the old level
// and halve every measured shift.
{
  const points = [
    [1, 100],
    [2, 100],
    [3, 300],
    [4, 300],
  ];
  assert.equal(levelsAcross(points, 3).before, 100);
  assert.equal(levelsAcross(points, 3).after, 300);
}

// Nothing on one side is not a small sample; it is not a measurement.
assert.equal(levelsAcross(stepped({ before: 1, after: 2 }), 0), undefined);
assert.equal(levelsAcross([], 5), undefined);

// --- which engine moved -----------------------------------------------------

// The reading everyone assumes, and the one that has to be said out loud
// because it is not the only one.
{
  const attribution = attributeMovement({
    v2: stepped({ before: 100, after: 200 }),
    v1: stepped({ before: 50, after: 50 }),
    boundaryOrdinal: 20,
  });
  assert.equal(attribution.mover, "v2");
  assert.equal(attribution.v2.ratio, 2);
  assert.equal(attribution.v1.ratio, 1);
}

// The control moving produces a change point on `log(v2) - log(v1)` that reads
// exactly like a V2 regression. This is the real
// `record-read/50k-50fields-sort-text-ascending` shape at `1dd78a15`: V2 flat
// at ~1800ms while V1 went 3683ms to 7316ms, reported as 0.51x. Four of the
// seventy-five change points on the 2026-08-07 run were this, and each one
// chased into V2 finds nothing there.
{
  const attribution = attributeMovement({
    v2: stepped({ before: 1814, after: 1629 }),
    v1: stepped({ before: 3683, after: 7316 }),
    boundaryOrdinal: 20,
  });
  assert.equal(attribution.mover, "v1");
}

// Both engines moving together is usually infrastructure, and is worth knowing
// before anyone opens the commit.
assert.equal(
  attributeMovement({
    v2: stepped({ before: 100, after: 200 }),
    v1: stepped({ before: 100, after: 200 }),
    boundaryOrdinal: 20,
  }).mover,
  "both",
);

// A third of change points land under the classifier bar. Attributing those to
// whichever engine drifted further would be an invented answer at exactly the
// point where the data has none.
{
  const small = MOVEMENT_BAR - 0.1;
  assert.equal(
    attributeMovement({
      v2: stepped({ before: 100, after: 100 * small }),
      v1: stepped({ before: 100, after: 100 }),
      boundaryOrdinal: 20,
    }).mover,
    "below-bar",
  );
}

// A faster V2 counts as movement. Direction is the reader's question, not the
// classifier's — a change point that reports 0.51x still has an engine behind
// it, and calling that "below-bar" would hide the clearest case of all.
assert.equal(
  attributeMovement({
    v2: stepped({ before: 6301, after: 1593 }),
    v1: stepped({ before: 3000, after: 3000 }),
    boundaryOrdinal: 20,
  }).mover,
  "v2",
);

// No control series is a different state from a control that did not move, and
// collapsing the two would claim V2 moved alone on evidence that cannot say so.
assert.equal(
  attributeMovement({
    v2: stepped({ before: 100, after: 200 }),
    v1: [],
    boundaryOrdinal: 20,
  }).mover,
  "no-control",
);

// Too few points to take a median on one side. Reported, not guessed.
assert.equal(
  attributeMovement({
    v2: stepped({ before: 100, after: 200 }),
    v1: stepped({ before: 50, after: 50 }),
    boundaryOrdinal: 0,
  }).mover,
  "unknown",
);

// --- which commits are candidates -------------------------------------------

// The split can land one mainline position off, so the neighbours are named.
// This is the `record-read/50k-50fields-group-number-low-cardinality` shape:
// culprit at 2600, change point reports 2601 and names its innocent neighbour.
{
  const candidates = attributionCandidates({
    beforeOrdinal: 2600,
    afterOrdinal: 2601,
    previous: [2600, sha("a")],
    next: [2602, sha("b")],
  });
  assert.deepEqual(candidates.alsoPossible, [sha("a"), sha("b")]);
  // Adjacent measurements, so nothing unmeasured hides between them.
  assert.equal(candidates.unmeasuredBetween, 0);
}

// A neighbour more than one position away is not covered by the ±1 tolerance
// and is not listed as if it were.
assert.deepEqual(
  attributionCandidates({
    beforeOrdinal: 2500,
    afterOrdinal: 2601,
    previous: [2500, sha("a")],
    next: [2700, sha("b")],
  }).alsoPossible,
  [],
);

// And the gap it leaves is counted. A hundred unmeasured commits between the
// two points means the named commit ends a range rather than answering the
// question, which no ±1 phrasing covers.
assert.equal(
  attributionCandidates({ beforeOrdinal: 2500, afterOrdinal: 2601 })
    .unmeasuredBetween,
  100,
);

// An ordinal with no commit behind it names nothing anyone can open, so it is
// dropped rather than listed as a candidate.
assert.deepEqual(
  attributionCandidates({
    beforeOrdinal: 10,
    afterOrdinal: 11,
    previous: [10, undefined],
    next: [12, "#12"],
  }).alsoPossible,
  [],
);

// --- what the change point is reported as ---------------------------------------

const step = ({ v2Before, v2After, ratio, mover = "v2", ...rest }) => ({
  ratio: ratio ?? v2After / v2Before,
  mover,
  v2Level:
    v2Before === undefined ? undefined : { before: v2Before, after: v2After },
  ...rest,
});

// Judged on the pair, reported on V2.
assert.equal(reportedFactor(step({ v2Before: 613, v2After: 1216 })), 1216 / 613);
// No levels: the paired ratio is all there is, and it is used rather than the
// record being dropped.
assert.equal(reportedFactor({ ratio: 1.4 }), 1.4);

// A widening pair is not a regression when V2 is the half that got faster.
assert.equal(isRegression(step({ ratio: 1.28, v2Before: 1231, v2After: 627 })), false);
assert.equal(isRegression(step({ v2Before: 400, v2After: 600 })), true);
assert.equal(isRegression(undefined), false);

// Speedups and control-side movements are excluded rather than ranked last.
{
  const slower = step({ id: "slower", v2Before: 400, v2After: 1200 });
  const faster = step({ id: "faster", v2Before: 900, v2After: 400 });
  const control = step({
    id: "control",
    v2Before: 37,
    v2After: 40,
    ratio: 2.2,
    mover: "v1",
  });
  const small = step({ id: "small", v2Before: 400, v2After: 500 });
  assert.deepEqual(
    rankRegressions([small, faster, control, slower]).map((point) => point.id),
    ["slower", "small"],
  );
}

// --- steps that are still standing ------------------------------------------------

// The measured case this exists for. The biggest step in the history ran
// 1335ms → 10417ms and the case sits at 1616ms today; naming that commit sends
// triage at a problem that is no longer there.
{
  const spike = step({ id: "spike", v2Before: 1335, v2After: 10417 });
  const stuck = step({ id: "stuck", v2Before: 1004, v2After: 1113 });
  assert.deepEqual(
    rankRegressions([spike, stuck]).map((point) => point.id),
    ["spike", "stuck"],
    "on size alone the spike wins",
  );
  assert.deepEqual(
    survivingSteps([spike, stuck], { currentLevel: 1616 }).map(
      (point) => point.id,
    ),
    ["stuck"],
    "against where the case sits today it is gone",
  );
}

// The bar has to clear the gap between an 8-point boundary median and a
// 20-point end median. On `lookup/foreign-select-flip-1of40-fanout100-4k` the
// step that genuinely explains the case reads 1395ms against a current 1001ms —
// 1.39x apart with nothing wrong.
{
  const real = step({ id: "real", v2Before: 634, v2After: 1395 });
  assert.ok(1395 / 1001 < RECOVERY_BAR);
  assert.deepEqual(
    survivingSteps([real], { currentLevel: 1001 }).map((point) => point.id),
    ["real"],
  );
}

// Exactly at the bar is kept; past it is not.
{
  const atBar = step({ id: "at", v2Before: 100, v2After: 100 * RECOVERY_BAR });
  const past = step({
    id: "past",
    v2Before: 100,
    v2After: 100 * RECOVERY_BAR + 1,
  });
  assert.deepEqual(
    survivingSteps([atBar, past], { currentLevel: 100 }).map(
      (point) => point.id,
    ),
    ["at"],
  );
}

// No current level to test against, and nothing is dropped. A caller that did
// not supply one is asking a different question, and filtering on a level it
// never gave would be worse than ranking on size.
{
  const spike = step({ id: "spike", v2Before: 1335, v2After: 10417 });
  assert.equal(survivingSteps([spike]).length, 1);
  assert.equal(survivingSteps([spike], { currentLevel: 0 }).length, 1);
}

// A record with no levels cannot be tested, so it is kept rather than dropped
// on a test that could not run.
assert.equal(
  survivingSteps([step({ id: "old", ratio: 1.6 })], { currentLevel: 100 })
    .length,
  1,
);

console.log("change point attribution model checks passed");
