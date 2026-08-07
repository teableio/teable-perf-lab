// Which cases can carry an alert at all.
//
// Some cases measure their own noise. `record-read/10k-50fields-group-three-
// levels` has a median of 0.47s and typically differs by 1.90x between adjacent
// runs of identical code; `record-read/10k-50fields-sort-text-ascending` differs
// by 2.94x. On a series like that any two stretches can be shown to differ, and
// a detector will happily report a "3.59x regression" that is nothing but the
// case shaking. That exact thing happened during development and reached a
// filed bug report before it was caught.
//
// So this screen runs before detection, not after. A case that cannot support a
// conclusion should never produce one — filtering the conclusions afterwards
// means the arithmetic has already been done on sand, and the reasons for
// dropping a finding are easy to forget once a number exists.
//
// The measure is the typical absolute change between adjacent points in log
// space. Adjacent differences are used because a real level shift contributes
// exactly one large difference, which the median discards — so a case with a
// genuine regression is not mistaken for a noisy one. That is the same estimator
// the noise model uses, on purpose: a case is unmeasurable when its own noise
// scale is so wide that nothing smaller than a catastrophe clears it.
//
// Measured across the 360 v2 series in the corpus: p50 1.10, p90 1.21,
// p95 1.28, p99 1.87, max 2.94.
//
// This is a statement about the case, not about the run. A case failing the
// screen is a perf-lab problem to fix — usually a sub-second measurement where
// fixed overhead swamps the signal — and it should be visible as such rather
// than quietly absent.

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Above this, a case is not measurable. Set at roughly 4x the typical case's
// noise and well clear of p95, which excludes 11 of 360 series — a 3% cost for
// removing the only source of findings that were pure artefact.
//
// Deliberately not tighter. p95 is 1.28, so a threshold near there would start
// excluding cases that are merely noisy rather than useless, and coverage is
// worth more than a marginally cleaner list.
export const DEFAULT_MAX_JITTER = 1.4;

// Fewer points than this and neither the jitter estimate nor a change point
// means anything. Detection needs two segments either side of a split, so the
// floor is well above twice the minimum segment.
export const DEFAULT_MIN_POINTS = 20;

/**
 * Typical multiplicative change between adjacent measurements.
 *
 * Returned as a ratio, so 1.10 reads as "usually differs by 10%".
 */
export const jitterOf = (values) => {
  const usable = values.filter((value) => value > 0).map(Math.log);
  if (usable.length < 2) {
    return undefined;
  }
  const steps = [];
  for (let index = 1; index < usable.length; index += 1) {
    steps.push(Math.abs(usable[index] - usable[index - 1]));
  }
  return Math.exp(median(steps));
};

/**
 * Whether a series can support an alert, and why not when it cannot.
 *
 * The verdict travels with the numbers that produced it so a report can say
 * "excluded, this case typically moves 1.9x between runs" rather than leaving a
 * case silently missing from a list someone is trusting to be complete.
 */
export const measurabilityOf = (
  values = [],
  { maxJitter = DEFAULT_MAX_JITTER, minPoints = DEFAULT_MIN_POINTS } = {},
) => {
  const usable = values.filter((value) => value > 0);
  const jitter = jitterOf(usable);

  if (usable.length < minPoints) {
    return {
      measurable: false,
      reason: "too-short",
      points: usable.length,
      jitter,
    };
  }
  if (jitter === undefined || !Number.isFinite(jitter)) {
    return {
      measurable: false,
      reason: "no-jitter",
      points: usable.length,
      jitter,
    };
  }
  if (jitter > maxJitter) {
    return {
      measurable: false,
      reason: "too-noisy",
      points: usable.length,
      jitter,
    };
  }
  return { measurable: true, points: usable.length, jitter };
};

/**
 * Split a set of series into those that can carry an alert and those that
 * cannot.
 *
 * Both halves are returned. The excluded half is not a leftover — it is the
 * list of cases the perf lab should fix, and a run that quietly detects on 349
 * of 360 series while reporting as though it covered all of them is making a
 * claim it cannot support.
 */
export const screenSeries = (seriesByKey = {}, options = {}) => {
  const measurable = {};
  const excluded = {};
  for (const [key, values] of Object.entries(seriesByKey)) {
    const verdict = measurabilityOf(values, options);
    if (verdict.measurable) {
      measurable[key] = values;
    } else {
      excluded[key] = verdict;
    }
  }
  return {
    measurable,
    excluded,
    counts: {
      measurable: Object.keys(measurable).length,
      excluded: Object.keys(excluded).length,
    },
  };
};
