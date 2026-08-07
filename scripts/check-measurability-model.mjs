import assert from "node:assert/strict";
import {
  jitterOf,
  measurabilityOf,
  screenSeries,
} from "./measurability-model.mjs";

const steady = (n, value = 100) => Array.from({ length: n }, () => value);
// Alternating values give a jitter of exactly the ratio between them.
const shaky = (n, low = 100, high = 190) =>
  Array.from({ length: n }, (_, index) => (index % 2 ? high : low));

// --- jitter -----------------------------------------------------------------

assert.equal(jitterOf(steady(30)), 1);
assert.ok(Math.abs(jitterOf(shaky(30)) - 1.9) < 1e-9);
// Too little to measure anything from.
assert.equal(jitterOf([100]), undefined);
assert.equal(jitterOf([]), undefined);

// A real level shift is one large difference among many small ones, and the
// median discards it. This is the property the whole screen rests on: a case
// with a genuine regression must not be mistaken for a noisy one and dropped.
{
  const regressed = [...steady(20, 100), ...steady(20, 300)];
  assert.equal(jitterOf(regressed), 1);
}

// --- verdicts ---------------------------------------------------------------

{
  const verdict = measurabilityOf(steady(40));
  assert.equal(verdict.measurable, true);
  assert.equal(verdict.points, 40);
}

// The real offender: `group-three-levels` moves 1.9x between adjacent runs of
// identical code, and any two stretches of it can be shown to differ.
{
  const verdict = measurabilityOf(shaky(40));
  assert.equal(verdict.measurable, false);
  assert.equal(verdict.reason, "too-noisy");
  assert.ok(verdict.jitter > 1.4);
}

// A case that is merely noisy stays in. p95 of the corpus is 1.28, and coverage
// is worth more than a marginally cleaner list.
assert.equal(measurabilityOf(shaky(40, 100, 125)).measurable, true);

// Short series cannot support the estimate or a change point.
{
  const verdict = measurabilityOf(steady(10));
  assert.equal(verdict.measurable, false);
  assert.equal(verdict.reason, "too-short");
}

// Non-positive values cannot be logged; a series that is all zeros has no
// jitter to speak of rather than a jitter of zero.
{
  const verdict = measurabilityOf(Array.from({ length: 30 }, () => 0));
  assert.equal(verdict.measurable, false);
  assert.equal(verdict.reason, "too-short");
}

// The numbers travel with the verdict, so a report can say why a case is absent
// instead of leaving a hole in a list someone trusts to be complete.
{
  const verdict = measurabilityOf(shaky(40));
  assert.ok(Number.isFinite(verdict.jitter));
  assert.ok(Number.isFinite(verdict.points));
}

// --- screening a set --------------------------------------------------------

{
  const { measurable, excluded, counts } = screenSeries({
    quiet: steady(40),
    "record-read/group-three-levels": shaky(40),
    stub: steady(5),
  });
  assert.deepEqual(Object.keys(measurable), ["quiet"]);
  assert.deepEqual(Object.keys(excluded).sort(), [
    "record-read/group-three-levels",
    "stub",
  ]);
  assert.equal(excluded["record-read/group-three-levels"].reason, "too-noisy");
  assert.equal(excluded.stub.reason, "too-short");
  assert.deepEqual(counts, { measurable: 1, excluded: 2 });
}

// The threshold is a policy, not a constant of nature, and has to be movable
// for the backtest to measure what it costs.
assert.equal(measurabilityOf(shaky(40)).measurable, false);
assert.equal(measurabilityOf(shaky(40), { maxJitter: 2.5 }).measurable, true);

console.log("measurability model checks passed");
