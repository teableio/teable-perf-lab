// E-Divisive change point detection over a per-case measurement series.
//
// Why this exists: the release comparison in `full-run-comparison-model.mjs`
// compares one run against whichever commit is currently released. That
// reference moves, and a moving reference ratchets — a regression that ships
// becomes the new baseline and reads as normal forever after, and a hotfix
// moves the reference again so the incident leaves no trace at all. No
// threshold on a two-point comparison can see past that, because the thing it
// compares against is part of the problem.
//
// E-Divisive (Matteson & James, JASA 2014) needs no reference. It looks at the
// whole series and finds the positions where the distribution shifts, which
// makes it retrospective and self-correcting: a bad release followed by a
// hotfix is an up change point followed by a down change point, and both stay
// in the history no matter what is deployed today. The change point also lands
// between two adjacent commits, so attribution comes free.
//
// This module is pure and knows nothing about Teable, cases, or engines. It
// takes an array of numbers already in analysis form and returns change points.
// Everything that makes the numbers comparable happens upstream and is not
// optional:
//
//   1. log space — perf ratios are multiplicative, and logs make "2x slower"
//      and "2x faster" equal-sized moves instead of 1.0 and 0.5.
//   2. run effect removed — a runner that is 15% slower shifts every case at
//      once, and raw values would put an identical change point on all 270 of
//      them at the same commit.
//   3. runs of the same commit collapsed to their median — a commit measured
//      ten times otherwise carries ten times the weight and grows a change
//      point out of nothing.
//   4. segmented at case-config digest boundaries — changing a case's rowCount
//      makes the numbers incomparable across the change, and because config
//      changes move the metric by more than any regression does, an unsegmented
//      series reports them as the strongest change points on the board.
//
// Feed it anything that skipped those and it will confidently report garbage.
//
// The `means` variant with alpha=1 is used, not `medians` (Twitter's EDM).
// Robustness is already bought upstream by the log transform and the
// median collapse in (3), and alpha=1 with means admits the O(n log n)
// incremental sweep below — which is what makes an honest permutation test
// affordable at ~270 series. Medians would force an O(n^2) sweep and a
// permutation budget too small to survive the FDR correction. MongoDB's CI
// performance detection (ICPE 2020) uses means in this same application.

// Minimum points on either side of a split.
//
// Set the floor knowing what it costs: a regression introduced by the newest
// commit has one measurement behind it, and no amount of statistics confirms a
// distribution shift from one point. This detector will not see that regression
// until DEFAULT_MIN_SEGMENT more runs have landed. That is the honest bound of
// the method, not a tuning mistake — change point detection trades immediacy
// for correct attribution and no false alarms. Same-run feedback is a different
// job and needs the calibrated pairwise check, not this.
export const DEFAULT_MIN_SEGMENT = 4;

// Two-stage permutation budget. The screening pass is cheap and throws out the
// series that are plainly flat, which is most of them. Only survivors pay for
// the precise pass.
//
// The split is not an optimisation, it is a correctness requirement. A
// permutation p-value cannot be smaller than 1/(B+1), so B=199 bottoms out at
// 0.005 — and Benjamini-Hochberg over ~270 series puts the strictest threshold
// at 0.05/270 = 1.85e-4. Screened p-values alone can never clear that bar, so
// every true regression would be discarded by the correction. The confirm pass
// exists to produce p-values small enough to survive it.
export const DEFAULT_SCREEN_PERMUTATIONS = 199;
export const DEFAULT_CONFIRM_PERMUTATIONS = 9999;

// Screening stops early once this many permutations have beaten the observed
// statistic: at that point the p-value is already far above any threshold the
// confirm pass could rescue, and the remaining permutations only cost time.
export const SCREEN_EXCEEDANCE_CUTOFF = 10;

// A series is promoted to the confirm pass at a looser bar than the final one.
// Screening is noisy by construction (199 draws), so cutting at the final
// significance level here would discard true positives before they are ever
// measured precisely.
export const DEFAULT_SCREEN_ALPHA = 0.1;

export const DEFAULT_SIGNIFICANCE = 0.05;

// Smallest shift worth calling a change point, as a distance between the two
// sides' medians in whatever units the series is in (log space, so 0.1 is about
// 10.5% slower).
//
// This is not a second significance test, it is the answer to a different
// question. The permutation test asks "did the distribution move"; on a long
// enough flat stretch the answer is eventually yes for a move of no consequence.
// Worse, the divisive recursion asks it repeatedly — a series that splits four
// ways runs about seven tests, and seven independent tests at 5% put the odds of
// at least one spurious split near 30%. Observed on synthetic data: the real
// change points scored Q around 10 and 2.3, and the spurious ones around 0.2 —
// an order of magnitude down, and still passing at p=5e-3.
//
// The gate has to sit inside the recursion rather than filter the results,
// because an accepted spurious split cuts the segments that every deeper search
// then runs on.
//
// Zero by default: this module detects, it does not hold opinions about which
// regressions matter. Callers are expected to pass the case's own noise scale
// (roughly 3x its MAD) — a flat case earns a tight gate and a noisy one a loose
// one, which is the whole point of having a per-case noise model. Running with
// the default will over-split, and that is deliberate: the backtest needs to see
// everything the detector can find before deciding where to cut.
export const DEFAULT_MIN_SHIFT = 0;

/**
 * Deterministic PRNG (mulberry32).
 *
 * Seeded on purpose. A detector whose output drives alerts has to give the same
 * answer twice on the same input, or a backtest cannot be reproduced and a
 * disputed alert cannot be re-examined.
 */
export const createRandom = (seed = 0x9e3779b9) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Fenwick trees over value ranks, one pair (count and sum) per side of the
// split. They answer "sum of |v - x| over the points on this side" in O(log n),
// which is the whole reason the sweep below is O(n log n) instead of O(n^2).
const createRankIndex = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const unique = [];
  for (const value of sorted) {
    if (unique.length === 0 || unique[unique.length - 1] !== value) {
      unique.push(value);
    }
  }
  // Binary search rather than a Map: values are floats, and a Map keyed on
  // float bit patterns is both slower and easy to get subtly wrong around -0.
  const rankOf = (value) => {
    let low = 0;
    let high = unique.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (unique[mid] < value) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low + 1; // Fenwick trees are 1-indexed.
  };
  return { unique, size: unique.length, rankOf };
};

const createSide = (size) => ({
  counts: new Float64Array(size + 1),
  sums: new Float64Array(size + 1),
  total: 0,
  totalSum: 0,
  size,
});

const sideAdd = (side, rank, value, sign) => {
  for (let i = rank; i <= side.size; i += i & -i) {
    side.counts[i] += sign;
    side.sums[i] += sign * value;
  }
  side.total += sign;
  side.totalSum += sign * value;
};

// Count and value-sum of the points with rank <= `rank`.
const sidePrefix = (side, rank) => {
  let count = 0;
  let sum = 0;
  for (let i = rank; i > 0; i -= i & -i) {
    count += side.counts[i];
    sum += side.sums[i];
  }
  return { count, sum };
};

/**
 * Sum of |value - x| over every x currently on this side.
 *
 * Splitting at the value's own rank turns the absolute value into two signed
 * halves: everything at or below contributes value*count - sum, everything
 * above contributes sum - value*count.
 */
const distanceTo = (side, rank, value) => {
  const { count, sum } = sidePrefix(side, rank);
  const upperCount = side.total - count;
  const upperSum = side.totalSum - sum;
  return value * count - sum + (upperSum - value * upperCount);
};

/**
 * The scaled E-statistic for a split with the three pairwise-distance sums
 * already accumulated.
 *
 *   E  = 2/(n*m) * SXY  -  2/(n*(n-1)) * SX  -  2/(m*(m-1)) * SY
 *   Q  = n*m/(n+m) * E
 *
 * Q is zero when both sides come from the same distribution and grows with the
 * size of the shift, so the split that maximises it is the most likely change
 * point. Both sides need at least two points for the within-side terms to be
 * defined.
 */
export const eStatistic = ({ crossSum, leftSum, rightSum, left, right }) => {
  if (left < 2 || right < 2) {
    return 0;
  }
  const e =
    (2 * crossSum) / (left * right) -
    (2 * leftSum) / (left * (left - 1)) -
    (2 * rightSum) / (right * (right - 1));
  return ((left * right) / (left + right)) * e;
};

/**
 * Find the split maximising the E-statistic, sweeping every admissible
 * position in one pass.
 *
 * The three distance sums are carried across positions instead of recomputed:
 * moving one point from the right side to the left changes each sum by exactly
 * that point's distance to one side or the other, both O(log n) Fenwick
 * queries. Recomputing from scratch would be O(n^2 log n) per sweep and the
 * permutation tests below run this thousands of times per series.
 *
 * Returns `undefined` when the series is too short to admit any split.
 */
export const bestSplit = (values, minSegment = DEFAULT_MIN_SEGMENT) => {
  const n = values.length;
  const floor = Math.max(2, minSegment);
  if (n < 2 * floor) {
    return undefined;
  }

  const index = createRankIndex(values);
  const ranks = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    ranks[i] = index.rankOf(values[i]);
  }

  const leftSide = createSide(index.size);
  const rightSide = createSide(index.size);

  // Seed the right side with the whole series, accumulating its within-side
  // pairwise sum as each point meets the ones already there.
  let rightSum = 0;
  for (let i = 0; i < n; i += 1) {
    rightSum += distanceTo(rightSide, ranks[i], values[i]);
    sideAdd(rightSide, ranks[i], values[i], 1);
  }

  let leftSum = 0;
  let crossSum = 0;

  // Move `v` from the right side to the left, keeping all three sums exact.
  const shift = (position) => {
    const value = values[position];
    const rank = ranks[position];

    const toLeft = distanceTo(leftSide, rank, value);
    sideAdd(rightSide, rank, value, -1);
    const toRight = distanceTo(rightSide, rank, value);

    leftSum += toLeft;
    rightSum -= toRight;
    // Pairs from `value` to the right side become cross pairs; pairs from the
    // left side to `value` stop being cross pairs and became left-side pairs.
    crossSum += toRight - toLeft;
    sideAdd(leftSide, rank, value, 1);
  };

  for (let i = 0; i < floor; i += 1) {
    shift(i);
  }

  let bestIndex;
  let bestStatistic = -Infinity;
  for (let split = floor; split <= n - floor; split += 1) {
    const statistic = eStatistic({
      crossSum,
      leftSum,
      rightSum,
      left: split,
      right: n - split,
    });
    if (statistic > bestStatistic) {
      bestStatistic = statistic;
      bestIndex = split;
    }
    if (split < n - floor) {
      shift(split);
    }
  }

  return bestIndex === undefined
    ? undefined
    : { index: bestIndex, statistic: bestStatistic };
};

const medianOf = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * How far the series moved at a split, as the distance between the medians of
 * the points on either side.
 *
 * `window` limits how far from the split to look. Unbounded, this measures the
 * two sides in full, which is only meaningful once both are homogeneous — and
 * during the divisive recursion they are not. A regression that was later
 * hotfixed is the case that exposes it: splitting `[30 at 0, 18 at 0.5, 30 at
 * 0]` at its true first change point leaves a right side that is mostly back at
 * 0, so its median reads 0 and the whole shift cancels to nothing. Bounded to a
 * window either side of the split, the same split reads +0.5, which is what
 * actually happened there.
 *
 * So: bounded during the search, unbounded once the segmentation is final.
 *
 * Medians rather than means because one failed run that still produced a number
 * would drag a mean far enough to invent or hide a shift. Computed once for the
 * winning split rather than inside the sweep: a median needs a sort, and paying
 * for one at every candidate position would undo the O(n log n) sweep that makes
 * the permutation tests affordable.
 */
export const splitShift = (values, index, window = Infinity) => {
  const from = Number.isFinite(window) ? Math.max(0, index - window) : 0;
  const to = Number.isFinite(window)
    ? Math.min(values.length, index + window)
    : values.length;
  return (
    medianOf(values.slice(index, to)) - medianOf(values.slice(from, index))
  );
};

const shuffled = (values, random) => {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = copy[i];
    copy[i] = copy[j];
    copy[j] = swap;
  }
  return copy;
};

/**
 * Permutation p-value for an observed split statistic.
 *
 * Under the null the observations are exchangeable, so reshuffling the series
 * and re-running the same sweep draws from the distribution of "largest
 * statistic reachable by chance". The p-value is how often chance matched or
 * beat what was actually observed.
 *
 * `+1` on both sides of the ratio counts the observed arrangement as one of its
 * own draws. Without it a statistic no permutation beat would report p=0, which
 * claims more certainty than the number of permutations can support.
 *
 * `exceedanceCutoff` stops a hopeless test early. Once enough permutations have
 * beaten the observation, the p-value is already well above any threshold, and
 * the estimate it returns is only used to reject.
 */
export const permutationPValue = ({
  values,
  statistic,
  permutations,
  minSegment = DEFAULT_MIN_SEGMENT,
  random = createRandom(),
  exceedanceCutoff = Infinity,
}) => {
  let exceeded = 0;
  let tried = 0;
  for (let i = 0; i < permutations; i += 1) {
    tried += 1;
    const candidate = bestSplit(shuffled(values, random), minSegment);
    if (candidate && candidate.statistic >= statistic) {
      exceeded += 1;
      if (exceeded >= exceedanceCutoff) {
        break;
      }
    }
  }
  return { pValue: (exceeded + 1) / (tried + 1), permutations: tried };
};

/**
 * Every change point in one series, found by recursive division.
 *
 * The series is split at its most significant change point, and each resulting
 * segment is searched again, until no segment yields a split that survives its
 * permutation test. That recursion is what lets one series carry several
 * incidents — the up of a bad release and the down of its hotfix are two change
 * points in the same history, and a single-split method would report only the
 * larger of them and call the other one noise.
 *
 * Screening runs on every segment; only segments that pass it pay for the
 * confirm pass. `pValue` on the result is always the confirmed one, because it
 * is what the FDR correction consumes and mixing the two budgets in one list
 * would compare p-values drawn from different resolutions.
 */
export const detectChangePoints = (
  values,
  {
    minSegment = DEFAULT_MIN_SEGMENT,
    minShift = DEFAULT_MIN_SHIFT,
    // How far either side of a candidate split the effect-size gate looks.
    // Wide enough that the median is not itself noise (the standard error of a
    // median over w points falls as 1/sqrt(w)), narrow enough not to reach into
    // structure the recursion has not resolved yet.
    shiftWindow = 2 * DEFAULT_MIN_SEGMENT,
    screenPermutations = DEFAULT_SCREEN_PERMUTATIONS,
    confirmPermutations = DEFAULT_CONFIRM_PERMUTATIONS,
    screenAlpha = DEFAULT_SCREEN_ALPHA,
    seed,
    random = createRandom(seed),
  } = {},
) => {
  const series = Array.isArray(values) ? values : [];
  if (series.some((value) => !Number.isFinite(value))) {
    throw new Error(
      "detectChangePoints requires a series of finite numbers; filter or impute upstream.",
    );
  }

  const found = [];
  // Every segment that reached a permutation test, including the ones screening
  // threw away. This is the family size the FDR correction has to divide by, and
  // getting it from the survivors instead is the mistake that makes the whole
  // correction ~5x too permissive — see `benjaminiHochberg`.
  let tested = 0;

  const search = (offset, segment) => {
    const candidate = bestSplit(segment, minSegment);
    if (!candidate) {
      return;
    }

    // Checked before the permutation tests, which is both the correct place and
    // the cheap one: a move too small to matter should not be searched further,
    // and skipping it saves thousands of sweeps.
    //
    // Both measures are taken because each is blind where the other sees. The
    // windowed one misses gradual drift — six releases at +6% each is +34% end
    // to end, and no window anywhere along it ever shows more than 6%, which is
    // precisely the regression shape the release comparison already cannot
    // catch. The full-width one misses a change that is undone later in the same
    // segment, because the two levels average back to where they started. A
    // split is worth pursuing if either says something happened; only a split
    // that is small under both is genuinely small.
    const localShift = splitShift(segment, candidate.index, shiftWindow);
    const wideShift = splitShift(segment, candidate.index);
    if (Math.max(Math.abs(localShift), Math.abs(wideShift)) < minShift) {
      return;
    }

    tested += 1;
    const screen = permutationPValue({
      values: segment,
      statistic: candidate.statistic,
      permutations: screenPermutations,
      minSegment,
      random,
      exceedanceCutoff: SCREEN_EXCEEDANCE_CUTOFF,
    });
    if (screen.pValue > screenAlpha) {
      return;
    }

    const confirm = permutationPValue({
      values: segment,
      statistic: candidate.statistic,
      permutations: confirmPermutations,
      minSegment,
      random,
    });

    found.push({
      index: offset + candidate.index,
      statistic: candidate.statistic,
      localShift,
      wideShift,
      pValue: confirm.pValue,
      screenPValue: screen.pValue,
      permutations: confirm.permutations,
    });

    search(offset, segment.slice(0, candidate.index));
    search(offset + candidate.index, segment.slice(candidate.index));
  };

  search(0, series);
  found.sort((left, right) => left.index - right.index);

  // Restate every shift against the segmentation the recursion settled on. Only
  // now is each change point flanked by two stretches with nothing further
  // detected inside them, which is the condition under which a median describes
  // the level rather than an average of two levels. `localShift` gated the
  // search; `shift` is the number to report, and the two disagree exactly where
  // the recursion found more structure nearby.
  const bounds = [0, ...found.map((point) => point.index), series.length];
  return {
    points: found.map((point, order) => ({
      ...point,
      // Signed, and the sign is the whole story: positive is a regression, and
      // the negative that follows it is the fix landing. Pairing the two is how
      // an escaped regression gets recognised as one incident with a duration.
      shift:
        medianOf(series.slice(point.index, bounds[order + 2])) -
        medianOf(series.slice(bounds[order], point.index)),
    })),
    tested,
  };
};

// Window length for the second pass below, and how far each window advances.
// Overlapping by half means an excursion of up to half a window always lands
// whole inside at least one of them.
export const DEFAULT_WINDOW = 20;
export const DEFAULT_STRIDE = 10;

/**
 * Detect over the whole series and again over overlapping windows.
 *
 * The recursive search alone is weak on a regression that was introduced and
 * then reverted, which is exactly the incident this project exists to record.
 * Measured on 277 real series: a 2x regression living about two weeks is fully
 * recorded 87% of the time, but one hotfixed within three or four days only
 * 40% — and a 1.5x hotfixed that fast, 8%. The perverse result is that the
 * faster a team fixes something, the less likely the system remembers it
 * happened.
 *
 * The cause is structural. E-Divisive splits at the single most divergent point
 * and recurses; a short excursion inside a long flat series is never the best
 * split, so the search stops before it can find either of its edges. Restricting
 * the same test to a window where the excursion is a large fraction of the data
 * makes it the best split there.
 *
 * Both passes are kept because they fail in opposite directions: the full pass
 * sees slow drift that no window is long enough to contain, and the windows see
 * short excursions the full pass steps over.
 *
 * The cost is more hypotheses, which the FDR correction charges for — `tested`
 * counts every window. That is the honest price, and it is why the windows do
 * not overlap more than they do.
 *
 * Measured on 277 real series, full record of an introduce-then-revert incident
 * (both edges found, each within one commit):
 *
 * |                | full only | window 40 | window 20 |
 * | -------------- | --------- | --------- | --------- |
 * | 2x, 20 runs    | 87%       | 92%       | 91%       |
 * | 2x, 10 runs    | 75%       | 80%       | 83%       |
 * | 2x, 6 runs     | 40%       | 39%       | 47%       |
 * | 1.5x, 20 runs  | 67%       | 76%       | 73%       |
 * | 1.5x, 10 runs  | 40%       | 43%       | 55%       |
 * | 1.5x, 6 runs   | 8%        | 9%        | 12%       |
 *
 * Window 20 is the setting kept. It is worth having — a 1.5x regression living
 * about a week goes from 40% recorded to 55% — but it does not fix the case it
 * was written for, and tuning stopped here rather than continuing to chase it.
 *
 * The reason is not the window size. A regression hotfixed within six runs has
 * six measurements behind it, and six points cannot carry a distribution test
 * whatever window they sit in. Shrinking further trades the statistic's power
 * for the excursion's prominence and lands in the same place. This is a floor
 * of the method, and it is recorded as a limitation in the acceptance criteria
 * rather than tuned around.
 */
export const detectChangePointsWindowed = (values, options = {}) => {
  const {
    window = DEFAULT_WINDOW,
    stride = DEFAULT_STRIDE,
    ...detectOptions
  } = options;
  const series = Array.isArray(values) ? values : [];

  const full = detectChangePoints(series, detectOptions);
  const found = new Map();
  for (const point of full.points) {
    found.set(point.index, { ...point, source: "full" });
  }
  let tested = full.tested;

  for (let start = 0; start + window <= series.length; start += stride) {
    const slice = series.slice(start, start + window);
    const local = detectChangePoints(slice, detectOptions);
    tested += local.tested;
    for (const point of local.points) {
      const index = start + point.index;
      const existing = found.get(index);
      // A point both passes found keeps the smaller p-value, which is the full
      // pass's when it saw it at all — it had more data to reject with.
      if (!existing || point.pValue < existing.pValue) {
        found.set(index, {
          ...point,
          index,
          source: existing ? "both" : "window",
        });
      }
    }
  }

  return {
    points: [...found.values()].sort((left, right) => left.index - right.index),
    tested,
  };
};

/**
 * Benjamini-Hochberg false discovery rate control across series.
 *
 * Roughly 270 cases are tested every run, so any per-test error rate is
 * multiplied by 270 before it reaches the report: at a raw 5% that is 13 false
 * alarms per run, which is how an alert list becomes something nobody reads.
 * BH picks the largest cutoff whose expected false discovery share stays under
 * `q`, so the list stays honest without an arbitrary absolute floor like
 * ">500ms" doing the filtering.
 *
 * `familySize` is the number of hypotheses TESTED, which is not the number of
 * p-values handed in. The screening pass rejects most segments before they ever
 * get a precise p-value, and passing only the survivors makes the correction
 * about as many times too permissive as the screen was selective. Measured on
 * 270 synthetic series: with the survivor count as the denominator the cutoff
 * landed at 3.5e-2 and let through 9 false discoveries against 23 real ones — a
 * 28% false discovery rate from a procedure asked for 5%.
 *
 * Ranks still come from the survivors alone, which is sound only because
 * anything the screen discarded has a p-value above every threshold BH could
 * choose. Raise `screenAlpha` above the significance level and that stops being
 * true.
 *
 * Returns each input's decision in input order, plus the cutoff used.
 */
export const benjaminiHochberg = (
  pValues,
  q = DEFAULT_SIGNIFICANCE,
  familySize = pValues.length,
) => {
  const entries = pValues.map((pValue, index) => ({ pValue, index }));
  const ordered = [...entries].sort(
    (left, right) => left.pValue - right.pValue,
  );
  const count = Math.max(familySize, ordered.length);

  let cutoffRank = 0;
  for (let rank = 1; rank <= ordered.length; rank += 1) {
    if (ordered[rank - 1].pValue <= (rank / count) * q) {
      cutoffRank = rank;
    }
  }

  const rejected = new Set(
    ordered.slice(0, cutoffRank).map((entry) => entry.index),
  );
  return {
    // The threshold actually applied — the largest p-value that made the cut,
    // which is what to quote when explaining why a case did or did not report.
    threshold: cutoffRank > 0 ? ordered[cutoffRank - 1].pValue : 0,
    significant: entries.map((entry) => rejected.has(entry.index)),
    count: cutoffRank,
  };
};

/**
 * Run detection across many series and apply one FDR correction over all of
 * them.
 *
 * The correction has to span every series tested in a run, not each series on
 * its own — 270 independent 5% tests is not a 5% error rate. `series` is
 * `{ key, values }`, and the result carries every detected change point with
 * the FDR verdict attached, so a caller can report the significant ones and
 * still see what was found and rejected.
 */
export const detectAcrossSeries = (series, options = {}) => {
  const { q = DEFAULT_SIGNIFICANCE, ...detectOptions } = options;

  const points = [];
  let tested = 0;
  for (const entry of series ?? []) {
    const result = detectChangePoints(entry.values, detectOptions);
    tested += result.tested;
    for (const point of result.points) {
      points.push({ ...point, key: entry.key });
    }
  }

  const correction = benjaminiHochberg(
    points.map((point) => point.pValue),
    q,
    tested,
  );

  return {
    points: points.map((point, index) => ({
      ...point,
      significant: correction.significant[index],
    })),
    threshold: correction.threshold,
    // Hypotheses tested, not change points found. The distinction matters when
    // reading the threshold: it is what the correction divided by.
    tested,
    candidates: points.length,
    significant: correction.count,
  };
};
