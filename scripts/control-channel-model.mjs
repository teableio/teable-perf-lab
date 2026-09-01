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
// There are two signals, but only one is a control.
//
// **V1, a separate-runner cohort.** Historical V1 and V2 jobs share a commit
// and seed dump, but GitHub schedules the matrix jobs on separate VMs. Their
// values can corroborate a broad movement; subtracting one from the other does
// not create a paired observation and must not be used as the primary detector.
// A real paired experiment lives in `paired-experiment-model.mjs` and executes
// base/candidate observations sequentially on one runner.
//
// **The run effect, global.** The median log deviation across every case
// measured at a commit. Weaker, and it cannot separate a genuine across-the-
// board regression from a slow machine, since both move everything at once. But
// it needs nothing, so it covers the ~5% of case-commit pairs with no V1
// measurement and the v2-only cases.
//
// The V1/V2 cohort difference remains available for historical audit and
// movement attribution. Its name is deliberately explicit: it is useful
// evidence, not causal proof.

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
export const cohortDifferenceSeries = ({ v2 = [], v1 = [] } = {}) => {
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

// Compatibility for offline notebooks written before the execution topology
// was audited. New detection code must use `cohortDifferenceSeries` by name so
// it cannot accidentally claim these observations were made on one runner.
export const pairedSeries = cohortDifferenceSeries;

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
 * Remove the run effect from a V2 series.
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
