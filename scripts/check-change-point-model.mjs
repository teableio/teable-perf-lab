import assert from "node:assert/strict";
import {
  benjaminiHochberg,
  bestSplit,
  createRandom,
  detectAcrossSeries,
  detectChangePoints,
  eStatistic,
} from "./change-point-model.mjs";

// A textbook O(n^2) sweep, kept only to check the incremental one.
//
// The Fenwick sweep in `bestSplit` carries three pairwise-distance sums across
// split positions instead of recomputing them, and a sign error there would not
// throw — it would quietly move every change point somewhere plausible. This
// reference recomputes each split from its definition, so agreeing with it on
// random series is the evidence that the fast path is the same function.
const naiveBestSplit = (values, minSegment) => {
  const n = values.length;
  const floor = Math.max(2, minSegment);
  if (n < 2 * floor) {
    return undefined;
  }
  const pairSum = (points) => {
    let total = 0;
    for (let i = 0; i < points.length; i += 1) {
      for (let k = i + 1; k < points.length; k += 1) {
        total += Math.abs(points[i] - points[k]);
      }
    }
    return total;
  };
  const crossPairSum = (left, right) => {
    let total = 0;
    for (const x of left) {
      for (const y of right) {
        total += Math.abs(x - y);
      }
    }
    return total;
  };

  let bestIndex;
  let bestStatistic = -Infinity;
  for (let split = floor; split <= n - floor; split += 1) {
    const left = values.slice(0, split);
    const right = values.slice(split);
    const statistic = eStatistic({
      crossSum: crossPairSum(left, right),
      leftSum: pairSum(left),
      rightSum: pairSum(right),
      left: left.length,
      right: right.length,
    });
    if (statistic > bestStatistic) {
      bestStatistic = statistic;
      bestIndex = split;
    }
  }
  return { index: bestIndex, statistic: bestStatistic };
};

// Deterministic gaussian noise, so a failure is always reproducible.
const noisy = (random, mean, sigma) => {
  const u = Math.max(random(), Number.EPSILON);
  const v = random();
  return mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const series = (random, segments) =>
  segments.flatMap(({ count, mean, sigma = 0.05 }) =>
    Array.from({ length: count }, () => noisy(random, mean, sigma)),
  );

// --- the statistic itself ---------------------------------------------------

// Two halves drawn from one distribution leave nothing to find; a clean step
// has to score above it. Absolute values are not meaningful, the ordering is.
{
  const flat = [1, 1.02, 0.98, 1.01, 0.99, 1.0, 1.03, 0.97];
  const step = [1, 1.02, 0.98, 1.01, 3.0, 2.98, 3.02, 2.99];
  const flatBest = bestSplit(flat, 2);
  const stepBest = bestSplit(step, 2);
  assert.ok(stepBest.statistic > flatBest.statistic * 5);
  assert.equal(stepBest.index, 4);
}

// A side with fewer than two points has no within-side pairwise term, so the
// statistic is undefined rather than merely small.
assert.equal(
  eStatistic({ crossSum: 10, leftSum: 0, rightSum: 5, left: 1, right: 4 }),
  0,
);

// --- incremental sweep vs the reference -------------------------------------

{
  const random = createRandom(20260807);
  for (let trial = 0; trial < 40; trial += 1) {
    const length = 9 + Math.floor(random() * 40);
    const values = Array.from({ length }, () => noisy(random, 0, 1));
    const fast = bestSplit(values, 3);
    const slow = naiveBestSplit(values, 3);
    assert.equal(
      fast.index,
      slow.index,
      `split index differs on trial ${trial}`,
    );
    assert.ok(
      Math.abs(fast.statistic - slow.statistic) < 1e-9,
      `statistic differs on trial ${trial}: ${fast.statistic} vs ${slow.statistic}`,
    );
  }
}

// Duplicate values share a Fenwick rank, and a point's distance to its own copy
// must count as zero on exactly one side of the move.
{
  const values = [2, 2, 2, 2, 5, 5, 5, 5];
  const fast = bestSplit(values, 2);
  const slow = naiveBestSplit(values, 2);
  assert.equal(fast.index, 4);
  assert.equal(fast.index, slow.index);
  assert.ok(Math.abs(fast.statistic - slow.statistic) < 1e-9);
}

// A series shorter than two minimum segments admits no split at all.
assert.equal(bestSplit([1, 2, 3, 4, 5], 3), undefined);

// --- detection on known ground truth ----------------------------------------

// Series below are built with sigma=0.05, so the gate is set at 3 sigma — the
// same rule a real case gets from its own MAD.
const TEST_BUDGET = {
  minSegment: 4,
  minShift: 0.15,
  screenPermutations: 199,
  confirmPermutations: 999,
  seed: 424242,
};

// Flat series: nothing happened, and the detector must say so. This is the case
// that decides whether anyone trusts the alerts.
{
  const random = createRandom(11);
  const flat = series(random, [{ count: 60, mean: 0 }]);
  assert.deepEqual(detectChangePoints(flat, TEST_BUDGET).points, []);
}

// One step, the ordinary regression: 40 runs at baseline, then 25 runs 40%
// slower (0.34 in log space).
{
  const random = createRandom(12);
  const stepped = series(random, [
    { count: 40, mean: 0 },
    { count: 25, mean: 0.34 },
  ]);
  const points = detectChangePoints(stepped, TEST_BUDGET).points;
  assert.equal(points.length, 1);
  assert.ok(
    Math.abs(points[0].index - 40) <= 1,
    `expected the change point at 40, got ${points[0].index}`,
  );
}

// The scenario this whole module exists for: a regression ships, runs in
// production for a while, and is hotfixed. Under a moving baseline the incident
// vanishes — the fixed build becomes the reference and the history reads clean.
// Change point detection has to report both edges of it.
{
  const random = createRandom(13);
  const hotfixed = series(random, [
    { count: 30, mean: 0 },
    { count: 18, mean: 0.5 },
    { count: 30, mean: 0 },
  ]);
  const points = detectChangePoints(hotfixed, TEST_BUDGET).points;
  assert.equal(
    points.length,
    2,
    `expected the regression and its hotfix, got ${points.length}`,
  );
  assert.ok(
    Math.abs(points[0].index - 30) <= 1,
    `bad entry at ${points[0].index}`,
  );
  assert.ok(
    Math.abs(points[1].index - 48) <= 1,
    `bad exit at ${points[1].index}`,
  );

  // The signs are what pair the two into one incident: something got slower,
  // then got faster again. A report that only carried magnitudes could not tell
  // an escaped regression from its fix.
  assert.ok(points[0].shift > 0.4, `entry shift was ${points[0].shift}`);
  assert.ok(points[1].shift < -0.4, `exit shift was ${points[1].shift}`);
}

// Without the effect-size gate the same series over-splits, because the
// divisive recursion runs about seven permutation tests and each one carries
// its own error rate. The extra splits are an order of magnitude smaller than
// the real ones and still pass at p < 0.05, which is exactly why significance
// alone cannot be the only gate.
{
  const random = createRandom(13);
  const hotfixed = series(random, [
    { count: 30, mean: 0 },
    { count: 18, mean: 0.5 },
    { count: 30, mean: 0 },
  ]);
  const ungated = detectChangePoints(hotfixed, {
    ...TEST_BUDGET,
    minShift: 0,
  }).points;
  assert.ok(
    ungated.length > 2,
    "the ungated detector should over-split; if it no longer does, the gate's justification needs rechecking",
  );
  const spurious = ungated.filter((point) => Math.abs(point.shift) < 0.15);
  assert.ok(spurious.length > 0);
  assert.ok(
    spurious.every((point) => point.pValue < 0.05),
    "spurious splits pass the significance test — that is the point being made",
  );
}

// Slow accumulated drift: five releases at +6% each, no single step anywhere
// near the 20% gate the release comparison uses. The gate never fires on this
// and the end state is 34% slower than the start.
{
  const random = createRandom(14);
  const drifting = series(
    random,
    [0, 0.06, 0.12, 0.18, 0.24, 0.3].map((mean) => ({
      count: 14,
      mean,
      sigma: 0.03,
    })),
  );
  const points = detectChangePoints(drifting, {
    ...TEST_BUDGET,
    minShift: 0.09,
  }).points;
  assert.ok(
    points.length >= 2,
    `accumulated drift should surface, found ${points.length} change points`,
  );
  // No single step here comes near the 20% release gate, but the ends of the
  // series are 34% apart. Detection has to work on the shape, not on any one
  // step's size.
  assert.ok(points.every((point) => point.shift > 0));
}

// Same seed, same answer. A detector that drives alerts has to be reproducible
// or a disputed alert cannot be re-examined.
{
  const random = createRandom(15);
  const values = series(random, [
    { count: 30, mean: 0 },
    { count: 30, mean: 0.4 },
  ]);
  assert.deepEqual(
    detectChangePoints(values, TEST_BUDGET),
    detectChangePoints(values, TEST_BUDGET),
  );
}

// A series carrying a non-finite value is a bug upstream, not something to
// silently skip: dropping it would shorten the series and shift every index
// after it, moving the commit a change point is attributed to.
assert.throws(
  () => detectChangePoints([1, 2, Number.NaN, 4, 5, 6, 7, 8, 9, 10]),
  /finite numbers/,
);

// --- FDR correction ---------------------------------------------------------

// Textbook walk-through: with q=0.05 over 5 tests the cutoffs are 0.01, 0.02,
// 0.03, 0.04, 0.05. The largest rank that clears its own cutoff is 3
// (0.025 <= 0.03), and BH then accepts everything at or below it — including
// 0.019, which sits under rank 2's cutoff only because rank 3 passed.
{
  const result = benjaminiHochberg([0.9, 0.025, 0.001, 0.019, 0.6], 0.05);
  assert.equal(result.count, 3);
  assert.deepEqual(result.significant, [false, true, true, true, false]);
  assert.equal(result.threshold, 0.025);
}

// Nothing survives when every p-value is large, and the threshold reads 0
// rather than the smallest p-value — quoting the latter would suggest a cutoff
// that nothing actually met.
{
  const result = benjaminiHochberg([0.4, 0.6, 0.8], 0.05);
  assert.equal(result.count, 0);
  assert.equal(result.threshold, 0);
  assert.deepEqual(result.significant, [false, false, false]);
}

// The family size is how many hypotheses were tested, not how many p-values
// survived screening to be handed in. These nine are the false discoveries a
// 270-series synthetic run actually produced: counted against themselves the
// correction accepts every one of them, and counted against the 270 tests they
// were drawn from it accepts one. Same p-values, same q, and the difference
// between a 5% false discovery rate and most of the list being wrong.
{
  const survivors = [
    1e-4, 2.2e-3, 6.5e-3, 7.1e-3, 7.3e-3, 1.1e-2, 1.2e-2, 1.3e-2, 1.7e-2,
  ];
  assert.equal(benjaminiHochberg(survivors, 0.05).count, survivors.length);
  assert.equal(benjaminiHochberg(survivors, 0.05, 270).count, 1);
}

// A family size below the number of p-values handed in is a caller error that
// would silently loosen the correction, so the larger of the two wins.
assert.equal(
  benjaminiHochberg([0.001, 0.002], 0.05, 1).count,
  benjaminiHochberg([0.001, 0.002], 0.05, 2).count,
);

// The correction spans every series tested in a run, not each series alone.
// This is the arithmetic that keeps ~270 cases from producing ~13 false alarms
// a run at a raw 5%.
{
  const random = createRandom(16);
  const flat = () => series(random, [{ count: 40, mean: 0 }]);
  const stepped = () =>
    series(random, [
      { count: 24, mean: 0 },
      { count: 24, mean: 0.45 },
    ]);

  const result = detectAcrossSeries(
    [
      { key: "quiet-a", values: flat() },
      { key: "quiet-b", values: flat() },
      { key: "regressed", values: stepped() },
      { key: "quiet-c", values: flat() },
    ],
    TEST_BUDGET,
  );

  const significant = result.points.filter((point) => point.significant);
  assert.equal(significant.length, 1);
  assert.equal(significant[0].key, "regressed");
}

console.log("change-point model checks passed");
