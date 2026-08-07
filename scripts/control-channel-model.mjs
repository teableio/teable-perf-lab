// Separating "the code got slower" from "the runner got slower".
//
// Runs share CI machines, so a bad afternoon shifts every case at once. Raw
// series would put an identical change point on all 380 of them at the same
// commit — 380 false attributions in one report, which is enough to end the
// system's credibility on its first bad day. This is not hypothetical: scanning
// the real corpus around mainline #2601 found twelve unrelated cases moving
// together by a median of 1.16x, across form-submit, record-duplicate,
// record-undo and record-delete.
//
// Two controls, because each is blind where the other sees.
//
// **V1, paired.** V1 and V2 run in the same job, on the same machine, against
// the same seeded data, and V1's code barely moves between runs. So V1's
// movement is the environment's movement, measured for that exact case. Working
// on log(v2) - log(v1) removes it. This is a paired design, which is the
// strongest form of control available here and something no single canary case
// can match: cases differ in how sensitive they are to a busy machine — an
// IO-bound case and a CPU-bound one react differently to the same noisy
// neighbour — and one global scalar cannot hold that.
//
// **The run effect, global.** The median log deviation across every case
// measured at a commit. Weaker, and it cannot separate a genuine across-the-
// board regression from a slow machine, since both move everything at once. But
// it needs nothing, so it covers the ~5% of case-commit pairs with no V1
// measurement and the v2-only cases.
//
// The two are also each other's alarm. They estimate the same quantity by
// different routes, so when they disagree the assumption underneath one of them
// has broken — V1's code moved, or the seeded data diverged between engines.
// That disagreement is itself worth reporting, and is why the global estimate is
// computed even where V1 is available.
//
// What this costs: a change point on a paired series means "V2 moved relative to
// V1", so a regression that hit both engines equally is invisible here. That is
// the right trade — a change in shared infrastructure is not a V2 regression —
// but it means the unpaired v2 series stays worth detecting on as a second
// opinion, not thrown away.

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Align a case's two engines by commit and return the log difference.
 *
 * Commits measured for only one engine are dropped rather than filled: an
 * imputed control value would be indistinguishable from a real one and would
 * quietly weaken exactly the commits where the control is missing. Coverage is
 * 94.8% of case-commit pairs, so the loss is small and the honesty is cheap.
 *
 * Points are `[ordinal, value]`. The result carries the same ordinals so a
 * change point maps back to the same commit boundary.
 */
export const pairedSeries = ({ v2 = [], v1 = [] } = {}) => {
  const control = new Map(v1.map(([ordinal, value]) => [ordinal, value]));
  const paired = [];
  let unpaired = 0;
  for (const [ordinal, value] of v2) {
    const reference = control.get(ordinal);
    if (reference === undefined || !(reference > 0) || !(value > 0)) {
      unpaired += 1;
      continue;
    }
    paired.push([ordinal, Math.log(value) - Math.log(reference)]);
  }
  return { points: paired, unpaired };
};

/**
 * How much slower everything was at each commit, as a median over cases.
 *
 * Each case contributes its own deviation from its own recent level, so a case
 * that is simply slow in absolute terms does not dominate. The median over
 * cases is what makes this a control rather than an average of regressions: one
 * case regressing 3x moves the median of 380 by nothing.
 *
 * `window` is how many earlier points define "recent level". Long enough that
 * the reference is not itself noise, short enough that it tracks a slow drift
 * instead of averaging it away.
 */
export const runEffects = ({ seriesByCase = {}, window = 12 } = {}) => {
  const deviations = new Map();
  for (const points of Object.values(seriesByCase)) {
    for (let index = window; index < points.length; index += 1) {
      const [ordinal, value] = points[index];
      if (!(value > 0)) continue;
      const recent = points
        .slice(index - window, index)
        .map(([, earlier]) => earlier)
        .filter((earlier) => earlier > 0);
      if (recent.length < window) continue;
      const deviation = Math.log(value) - Math.log(median(recent));
      if (!deviations.has(ordinal)) deviations.set(ordinal, []);
      deviations.get(ordinal).push(deviation);
    }
  }

  const effects = {};
  for (const [ordinal, values] of deviations) {
    // A commit measured for a handful of cases is a targeted run, and a median
    // over three cases is not an estimate of anything. Reported with its
    // support so the caller can decide, rather than silently trusted.
    effects[ordinal] = { effect: median(values), cases: values.length };
  }
  return effects;
};

/**
 * Remove the run effect from a series that has no paired control.
 *
 * Only commits with enough supporting cases are corrected. Where support is
 * thin the point is left alone rather than adjusted by a number built from
 * three other cases — an unadjusted point is honest noise, a badly adjusted one
 * is a fabricated signal.
 */
export const applyRunEffect = ({ points = [], effects = {}, minCases = 20 }) =>
  points.map(([ordinal, value]) => {
    const entry = effects[ordinal];
    const usable = entry && entry.cases >= minCases;
    return [ordinal, usable ? Math.log(value) - entry.effect : Math.log(value)];
  });

/**
 * Where the two controls disagree about the same commit.
 *
 * They estimate the same thing by independent routes, so a gap means an
 * assumption has broken rather than that one of them is noisy: V1's own code
 * moved, or the two engines stopped seeing the same seeded data. Either makes
 * every paired series at that commit untrustworthy, which is worth knowing
 * before a regression is attributed to it.
 *
 * `tolerance` is in log space; 0.15 is about 16%.
 */
export const controlDisagreements = ({
  v1Effects = {},
  globalEffects = {},
  tolerance = 0.15,
  minCases = 20,
} = {}) => {
  const found = [];
  for (const [ordinal, entry] of Object.entries(globalEffects)) {
    const control = v1Effects[ordinal];
    if (!control || entry.cases < minCases || control.cases < minCases)
      continue;
    const gap = control.effect - entry.effect;
    if (Math.abs(gap) > tolerance) {
      found.push({
        ordinal: Number(ordinal),
        v1Effect: control.effect,
        globalEffect: entry.effect,
        gap,
      });
    }
  }
  return found.sort((left, right) => left.ordinal - right.ordinal);
};
