// The same-run check: "this case looks wrong today".
//
// Change point detection is retrospective by construction — it needs several
// runs behind a regression before it can confirm one. That is the right trade
// for attribution, but it leaves the question everyone actually asks after a
// run ("is anything broken?") to a different mechanism. This is that mechanism.
//
// It replaces the 20% ratio gate, which measurement showed fires on 29.9% of
// cases from noise alone — about 117 of 393 per run, with identical code.
//
// **Thresholds are empirical quantiles of the case's own deviations, not
// multiples of its standard deviation.** Sigma multiples were tried first and
// are the wrong shape: the noise has a heavy tail (p90 1.193 against a 1.101
// median), so a k-sigma threshold either fires constantly or goes numb, with
// nothing useful in between. Measured at matched false-alarm rates:
//
// | threshold      | false alarms/run | 1.5x caught | 1.2x caught |
// | -------------- | ---------------- | ----------- | ----------- |
// | sigma x6       | 2.0              | 10%         | 2%          |
// | quantile 0.995 | 2.0              | 26%         | 7%          |
// | quantile 0.99  | 4.0              | 35%         | 11%         |
// | quantile 0.98  | 6.3              | 46%         | 16%         |
// | quantile 0.95  | 16.3             | 62%         | 29%         |
//
// At a matched two false alarms per run the quantile form catches 2.6x more.
// The 0.99 operating point is the one decided in the acceptance criteria: four
// false alarms a run, and a third of 1.5x regressions caught the day they land.
//
// What this layer is for, and what it is not: it says "look at this", not "this
// is a regression". A third of big regressions caught immediately is worth
// having precisely because the confirmed layer will catch the rest within a
// week or two — the two are the same noise model read at two time scales, not
// competitors.

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const quantile = (values, fraction) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  ];
};

// The decided operating point. See the table above for what the alternatives
// cost; looser settings were available and were not taken, because the
// direction they lead in is what made the current report unreadable.
export const DEFAULT_QUANTILE = 0.99;

// How many earlier points define "the level this case has been running at".
// Long enough that the reference is not itself a single noisy reading, short
// enough to track a case whose level genuinely moved a month ago.
export const DEFAULT_WINDOW = 12;

// Below this many past deviations the quantile is not an estimate. At 0.99 the
// threshold is the largest of every hundred observations, so a history of forty
// is already reading its own maximum — usable, but only just.
export const DEFAULT_MIN_HISTORY = 40;

/**
 * How far a point sits above the level preceding it, in log space.
 *
 * Against the median of the preceding window rather than a fixed baseline, so
 * a case whose level legitimately moved months ago is judged against where it
 * has been running lately, not against where it started.
 */
const deviationAt = (values, index, window) => {
  const recent = values
    .slice(Math.max(0, index - window), index)
    .filter((v) => v > 0);
  if (recent.length < window || !(values[index] > 0)) {
    return undefined;
  }
  return Math.log(values[index]) - Math.log(median(recent));
};

/**
 * Every deviation a case's history contains, which is the distribution its
 * threshold is read off.
 */
export const deviationsOf = (values = [], { window = DEFAULT_WINDOW } = {}) => {
  const found = [];
  for (let index = window; index < values.length; index += 1) {
    const deviation = deviationAt(values, index, window);
    if (deviation !== undefined) {
      found.push(deviation);
    }
  }
  return found;
};

/**
 * Judge the newest measurement against everything before it.
 *
 * `history` must not include the point being judged. Calibrating a threshold on
 * a sample that contains the observation being tested returns the nominal false
 * alarm rate by construction — the measurement flatters itself and the number
 * means nothing. This is the single easiest mistake to make here, which is why
 * the point arrives as a separate argument rather than as the last element.
 *
 * Returns `flagged: false` with a reason when the case has too little history
 * to judge, rather than falling back to a global rule. A case nobody can judge
 * yet is not the same as a case that looks fine, and the report has to be able
 * to tell them apart.
 */
export const checkLatest = (
  history = [],
  latest,
  {
    quantile: fraction = DEFAULT_QUANTILE,
    window = DEFAULT_WINDOW,
    minHistory = DEFAULT_MIN_HISTORY,
  } = {},
) => {
  const past = deviationsOf(history, { window });
  if (past.length < minHistory) {
    return {
      flagged: false,
      reason: "insufficient-history",
      history: past.length,
    };
  }
  if (!(latest > 0)) {
    return { flagged: false, reason: "unusable-value", history: past.length };
  }

  const recent = history.slice(-window).filter((value) => value > 0);
  if (recent.length < window) {
    return {
      flagged: false,
      reason: "insufficient-history",
      history: past.length,
    };
  }

  const level = median(recent);
  const deviation = Math.log(latest) - Math.log(level);
  const threshold = quantile(past, fraction);

  return {
    flagged: deviation > threshold,
    deviation,
    threshold,
    // Reported as ratios because that is how the card reads them: "1.42x its
    // recent level, where this case's own bar is 1.18x".
    ratio: Math.exp(deviation),
    thresholdRatio: Math.exp(threshold),
    level,
    history: past.length,
  };
};

/**
 * Run the check across every case in a run.
 *
 * Cases that cannot be judged are counted, not hidden. A report claiming a
 * clean run over 300 cases while 80 of them were unjudgeable is making a
 * stronger claim than it can support.
 */
export const checkRun = (cases = {}, options = {}) => {
  const flagged = [];
  const skipped = {};
  let judged = 0;

  for (const [key, entry] of Object.entries(cases)) {
    const verdict = checkLatest(entry.history, entry.latest, options);
    if (verdict.reason) {
      skipped[verdict.reason] = (skipped[verdict.reason] ?? 0) + 1;
      continue;
    }
    judged += 1;
    if (verdict.flagged) {
      flagged.push({ key, ...verdict });
    }
  }

  flagged.sort((left, right) => right.deviation - left.deviation);
  return { flagged, judged, skipped };
};
