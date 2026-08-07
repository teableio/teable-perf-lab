import assert from "node:assert/strict";
import { checkLatest, checkRun, deviationsOf } from "./fast-check-model.mjs";
import { createRandom } from "./change-point-model.mjs";

// A case that has been running flat forever, long enough to have a threshold.
const steady = (n = 80, value = 100) => Array.from({ length: n }, () => value);
// A case with real spread rather than a clean alternation. An alternating
// series has only two possible deviations, so its 0.99 quantile sits exactly on
// the larger of them and anything at all above it fires — which tests the
// arithmetic but not the behaviour.
const shaky = (n = 200, sigma = 0.25, seed = 7) => {
  const random = createRandom(seed);
  return Array.from({ length: n }, () => {
    const u = Math.max(random(), Number.EPSILON);
    const v = random();
    return (
      100 *
      Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v))
    );
  });
};

// --- deviations -------------------------------------------------------------

// A flat history deviates from itself by nothing.
assert.deepEqual(new Set(deviationsOf(steady()).map(Math.round)), new Set([0]));
// The first `window` points have nothing behind them to be judged against.
assert.equal(deviationsOf(steady(50), { window: 12 }).length, 38);

// --- judging the newest point -----------------------------------------------

// A quiet case gets a tight bar, which is the entire point of a per-case
// threshold: on this case a 20% jump is enormous.
{
  const verdict = checkLatest(steady(), 120);
  assert.equal(verdict.flagged, true);
  assert.ok(verdict.ratio > 1.19 && verdict.ratio < 1.21);
}

// The same 20% jump on a case that swings wildly on its own is not news. The
// old global gate called both of these regressions, which is how a report ends
// up with a hundred rows nobody reads.
{
  const noisy = shaky();
  const level = checkLatest(noisy, 100).level;
  assert.equal(checkLatest(noisy, level * 1.2).flagged, false);
  // And the same case does still have a bar — it is just a wide one.
  assert.equal(checkLatest(noisy, level * 4).flagged, true);
}

// The bar travels with the verdict so a card can say "1.42x its recent level,
// where this case's own bar is 1.18x" rather than just asserting a problem.
{
  const verdict = checkLatest(shaky(), 500);
  assert.ok(verdict.thresholdRatio > 1);
  assert.ok(verdict.ratio > verdict.thresholdRatio);
  assert.equal(verdict.flagged, true);
  // The quiet case's bar is far tighter than the noisy one's. That difference
  // is the whole reason for a per-case threshold.
  assert.ok(checkLatest(steady(), 100).thresholdRatio < verdict.thresholdRatio);
}

// Only slower is flagged. A case that suddenly halves is interesting, but it is
// not what this layer is for, and mixing the two doubles the list.
assert.equal(checkLatest(steady(), 50).flagged, false);

// --- refusing to judge ------------------------------------------------------

// A new case has no threshold. Falling back to a global rule here is how the
// old gate behaved and is exactly the thing being replaced.
{
  const verdict = checkLatest(steady(20), 500);
  assert.equal(verdict.flagged, false);
  assert.equal(verdict.reason, "insufficient-history");
}

// A failed measurement has a number, and it is not a duration.
assert.equal(checkLatest(steady(), 0).reason, "unusable-value");
assert.equal(checkLatest(steady(), -1).reason, "unusable-value");

// --- the circularity guard --------------------------------------------------

// Calibrating on a sample containing the point under test returns the nominal
// rate by construction. The point arrives as a separate argument so this cannot
// happen by accident — passing it inside the history instead must change the
// answer, and here it hides the very spike being tested.
{
  const history = steady();
  const spike = 400;
  assert.equal(checkLatest(history, spike).flagged, true);
  assert.equal(checkLatest([...history, spike], spike).flagged, false);
}

// --- a whole run ------------------------------------------------------------

{
  const { flagged, judged, skipped } = checkRun({
    quiet: { history: steady(), latest: 100 },
    regressed: { history: steady(), latest: 150 },
    noisy: { history: shaky(), latest: 130 },
    brandNew: { history: steady(15), latest: 900 },
  });
  assert.deepEqual(
    flagged.map((entry) => entry.key),
    ["regressed"],
  );
  // Unjudgeable cases are counted, never silently folded into "clean". A report
  // claiming a quiet run over 300 cases while 80 were unjudgeable is claiming
  // more than it knows.
  assert.equal(judged, 3);
  assert.deepEqual(skipped, { "insufficient-history": 1 });
}

// Worst first — a reader who stops after two lines should have seen the two
// that matter most.
{
  const { flagged } = checkRun({
    small: { history: steady(), latest: 130 },
    large: { history: steady(), latest: 400 },
    medium: { history: steady(), latest: 200 },
  });
  assert.deepEqual(
    flagged.map((entry) => entry.key),
    ["large", "medium", "small"],
  );
}

console.log("fast check model checks passed");
