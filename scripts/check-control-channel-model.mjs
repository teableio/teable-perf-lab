import assert from "node:assert/strict";
import {
  applyRunEffect,
  controlDisagreements,
  pairedSeries,
  runEffects,
} from "./control-channel-model.mjs";

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `expected ${expected}, got ${actual}`,
  );

// --- pairing ----------------------------------------------------------------

// The whole point: a run where the machine was 50% slower moves both engines,
// and the paired series must read flat through it.
{
  const { points } = pairedSeries({
    v2: [
      [10, 100],
      [11, 150],
      [12, 100],
    ],
    v1: [
      [10, 400],
      [11, 600],
      [12, 400],
    ],
  });
  assert.equal(points.length, 3);
  for (const [, value] of points) {
    close(value, Math.log(0.25));
  }
}

// And a V2-only regression must survive pairing, because V1 did not move.
{
  const { points } = pairedSeries({
    v2: [
      [10, 100],
      [11, 200],
    ],
    v1: [
      [10, 400],
      [11, 400],
    ],
  });
  close(points[1][1] - points[0][1], Math.log(2));
}

// A commit measured for only one engine is dropped, not filled. An imputed
// control reads exactly like a real one and would quietly weaken the commits
// where the control is actually missing.
{
  const { points, unpaired } = pairedSeries({
    v2: [
      [10, 100],
      [11, 100],
      [12, 100],
    ],
    v1: [
      [10, 400],
      [12, 400],
    ],
  });
  assert.deepEqual(
    points.map(([ordinal]) => ordinal),
    [10, 12],
  );
  assert.equal(unpaired, 1);
}

// Non-positive values cannot be logged and are not silently treated as tiny.
assert.equal(pairedSeries({ v2: [[10, 100]], v1: [[10, 0]] }).points.length, 0);

// --- run effect -------------------------------------------------------------

const flat = (ordinals, value) => ordinals.map((ordinal) => [ordinal, value]);

// Twenty cases, all steady, then all 20% slower at one commit. That is the
// machine, and the estimate has to name it.
{
  const seriesByCase = {};
  for (let index = 0; index < 20; index += 1) {
    const base = 100 + index * 10;
    seriesByCase[`case-${index}`] = [
      ...flat([...Array(12).keys()], base),
      [12, base * 1.2],
    ];
  }
  const effects = runEffects({ seriesByCase, window: 12 });
  close(effects[12].effect, Math.log(1.2), 1e-9);
  assert.equal(effects[12].cases, 20);
}

// One case regressing 3x must not move a median over twenty. This is what makes
// the estimate a control rather than an average of regressions.
{
  const seriesByCase = {};
  for (let index = 0; index < 20; index += 1) {
    seriesByCase[`case-${index}`] = [
      ...flat([...Array(12).keys()], 100),
      [12, index === 0 ? 300 : 100],
    ];
  }
  close(runEffects({ seriesByCase, window: 12 })[12].effect, 0, 1e-9);
}

// Support travels with the estimate. A commit measured by a targeted run has a
// median over three cases, which is not an estimate of anything, and the caller
// has to be able to see that.
{
  const seriesByCase = {
    a: [...flat([...Array(12).keys()], 100), [12, 120]],
    b: [...flat([...Array(12).keys()], 100), [12, 120]],
  };
  assert.equal(runEffects({ seriesByCase, window: 12 })[12].cases, 2);
}

// --- applying the effect ----------------------------------------------------

// Thin support leaves the point alone. An unadjusted point is honest noise; one
// adjusted by a number built from three other cases is a fabricated signal.
{
  const effects = {
    10: { effect: Math.log(1.2), cases: 40 },
    11: { effect: Math.log(1.2), cases: 3 },
  };
  const corrected = applyRunEffect({
    points: [
      [10, 120],
      [11, 120],
    ],
    effects,
    minCases: 20,
  });
  close(corrected[0][1], Math.log(100), 1e-9);
  close(corrected[1][1], Math.log(120), 1e-9);
}

// --- disagreement -----------------------------------------------------------

// The two controls estimate the same quantity by independent routes. A gap
// means an assumption broke — V1's own code moved, or the engines stopped
// seeing the same seeded data — and every paired series at that commit is
// suspect because of it.
{
  const found = controlDisagreements({
    v1Effects: {
      10: { effect: Math.log(1.5), cases: 40 },
      11: { effect: Math.log(1.2), cases: 40 },
    },
    globalEffects: {
      10: { effect: Math.log(1.2), cases: 40 },
      11: { effect: Math.log(1.2), cases: 40 },
    },
    tolerance: 0.15,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].ordinal, 10);
  assert.ok(found[0].gap > 0);
}

// Thin support on either side is not evidence of disagreement, it is absence of
// evidence, and reporting it would bury the real ones.
assert.deepEqual(
  controlDisagreements({
    v1Effects: { 10: { effect: Math.log(2), cases: 3 } },
    globalEffects: { 10: { effect: 0, cases: 40 } },
  }),
  [],
);

console.log("control channel model checks passed");
