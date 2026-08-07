// Compute-time comparison: how much computing this run did for a case, against
// how much the released build did for the same case.
//
// The release comparison next door answers "did the user wait longer". That
// question is not the same as "did the work get cheaper", and the two come apart
// exactly when the engine changes how computed work is scheduled. Measured on
// `lookup/foreign-select-flip-1of40-fanout100-4k` against `develop`, moving the
// computed update off the request path took the write from 448.86ms to 125.85ms
// — a 3.6x "win" in which 836.29ms of computing simply relocated to a background
// worker. A wall-clock number alone reports that as an optimization forever.
//
// Pairing the two ratios is what makes the four possible stories separable:
//
//   wall slower + compute slower  -> the work really did get more expensive
//   wall slower + compute flat    -> scheduling got worse, the work did not
//   wall faster + compute faster  -> a real optimization
//   wall faster + compute flat    -> the work moved, nothing got cheaper
//
// Keep this file pure. Teable and filesystem work belongs in
// `resolve-release-baseline.mjs`; rendering belongs in
// `perf-run-summary-model.mjs`. See docs/compute-time-observation-spec.md.
//
// Nothing here gates a run, and that is deliberate rather than unfinished. The
// band below is inherited from the wall-clock comparison, not calibrated: the
// run-to-run noise of compute time has never been measured, and the 1.2x gate it
// borrows already fires on 42 of 263 V1 cases whose code did not change between
// runs. A verdict here is a label on a report. Once the noise floor is known — it
// should be well under the wall-clock floor, since compute time excludes queueing
// and runner contention — a gate can be added, and only then.

export const COMPUTE_METRIC = "computeMs";

// Borrowed from `full-run-comparison-model.mjs` rather than imported: these two
// bands are the same number today by coincidence of ignorance, not by design, and
// they will diverge the moment compute noise is measured. Importing would make a
// later change to one silently change the other.
export const DEFAULT_COMPUTE_BAND = 1.2;

const positiveNumber = (value) =>
  Number.isFinite(value) && value > 0 ? value : undefined;

const numberOrZero = (value) => (Number.isFinite(value) ? value : 0);

/**
 * The shape of the computed work, read from the measurement rather than from the
 * config flag that requested it.
 *
 * `V2_COMPUTED_UPDATE_MODE` records what was asked for; these counters record
 * what the engine actually did, and only the second one makes two numbers
 * comparable. A hybrid run whose steps all fit the inline policy did inline work,
 * whatever the flag said.
 *
 * Shape has to travel with the value because compute time is invariant to
 * *rescheduling* the same units of work, not to *re-cutting* the work into
 * different units. Splitting one run into N outbox tasks makes each task repeat
 * its own setup — load tables, seed dirty records, propagate — so the same
 * logical change genuinely burns more machine: 375.95ms inline versus 836.29ms
 * through the outbox on `lookup/foreign-select-flip-1of40-fanout100-4k`, with
 * `computeStepsExecuted` flat at 18 against 16. Comparing across that boundary
 * would report a 2.2x regression that nobody caused.
 */
export const computeShape = (metrics) => {
  if (
    numberOrZero(metrics?.computeTaskCount) > 0 ||
    numberOrZero(metrics?.computeAsyncMs) > 0
  ) {
    return "outbox";
  }
  if (numberOrZero(metrics?.computeInlineMs) > 0) {
    return "inline";
  }
  return "none";
};

/**
 * This run's compute time for a payload, or undefined when there is nothing to
 * compare.
 *
 * Only a passing case measured what it set out to measure, matching
 * `measuredValue` next door: a failure's compute time is the compute of a
 * failure. Zero is undefined rather than zero because a case that does no
 * computed work — a pure read — has no compute to compare, and a ratio built on
 * it would be a division by zero dressed up as a measurement.
 */
export const computeValue = (payload) => {
  if (payload?.result !== "pass") {
    return undefined;
  }
  return positiveNumber(payload?.metrics?.[COMPUTE_METRIC]);
};

/**
 * The compute half of a stored baseline entry, built from a Performance Track
 * row's `Metrics JSON`.
 *
 * Returns undefined when the row predates compute collection, which is the
 * common case for a while: every baseline commit measured before this shipped
 * has no compute number, and those cases must read as "no baseline" rather than
 * as zero.
 */
export const readComputeBaseline = (metrics) => {
  const value = positiveNumber(metrics?.[COMPUTE_METRIC]);
  if (value === undefined) {
    return undefined;
  }
  return { value, shape: computeShape(metrics) };
};

const direction = (ratio, band) => {
  if (!Number.isFinite(ratio)) {
    return undefined;
  }
  if (ratio >= band) {
    return "slower";
  }
  if (ratio <= 1 / band) {
    return "faster";
  }
  return "flat";
};

// Keys are stable and machine-read; the report supplies the wording. `deferred`
// is the one this whole model exists to name: the wall clock improved and the
// computing did not, which is work relocated rather than work saved.
export const COMPUTE_VERDICTS = [
  "regression",
  "scheduling",
  "optimized",
  "deferred",
  "hidden-cost",
  "hidden-gain",
  "flat",
];

/**
 * Which of the four stories the two ratios tell.
 *
 * Returns undefined when either ratio is missing — an unknown half makes the
 * pair unreadable, and guessing the missing direction is how a report starts
 * claiming things it did not measure.
 */
export const computeVerdict = ({
  wallRatio,
  computeRatio,
  band = DEFAULT_COMPUTE_BAND,
} = {}) => {
  const wall = direction(wallRatio, band);
  const compute = direction(computeRatio, band);
  if (!wall || !compute) {
    return undefined;
  }

  if (wall === "slower") {
    return compute === "slower" ? "regression" : "scheduling";
  }
  if (wall === "faster") {
    return compute === "faster" ? "optimized" : "deferred";
  }
  if (compute === "slower") {
    return "hidden-cost";
  }
  if (compute === "faster") {
    return "hidden-gain";
  }
  return "flat";
};

const emptyCounts = () => ({
  compared: 0,
  // Counted by what compute did, independent of the wall clock. A verdict count
  // cannot answer "how many cases burned more machine": `regression` and
  // `hidden-cost` are both compute-slower and differ only in whether the wall
  // clock happened to show it, so a line built from verdicts alone reports "0
  // slower" for a case that got 1.7x more expensive.
  computeSlower: 0,
  computeFaster: 0,
  regression: 0,
  scheduling: 0,
  optimized: 0,
  deferred: 0,
  hiddenCost: 0,
  hiddenGain: 0,
  flat: 0,
  noCompute: 0,
  shapeChanged: 0,
  missingBaseline: 0,
});

const VERDICT_COUNT_KEY = {
  regression: "regression",
  scheduling: "scheduling",
  optimized: "optimized",
  deferred: "deferred",
  "hidden-cost": "hiddenCost",
  "hidden-gain": "hiddenGain",
  flat: "flat",
};

// Deferred and regression first: those are the two a reader has to act on. Within
// a verdict, the largest compute ratio leads, so the most expensive case is the
// one at the top of its group.
const VERDICT_ORDER = [
  "deferred",
  "regression",
  "hidden-cost",
  "scheduling",
  "hidden-gain",
  "optimized",
  "flat",
];

const compareRows = (left, right) => {
  const leftRank = VERDICT_ORDER.indexOf(left.verdict);
  const rightRank = VERDICT_ORDER.indexOf(right.verdict);
  const leftOrder = leftRank === -1 ? VERDICT_ORDER.length : leftRank;
  const rightOrder = rightRank === -1 ? VERDICT_ORDER.length : rightRank;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  const leftRatio = Number.isFinite(left.computeRatio) ? left.computeRatio : 0;
  const rightRatio = Number.isFinite(right.computeRatio)
    ? right.computeRatio
    : 0;
  if (leftRatio !== rightRatio) {
    return rightRatio - leftRatio;
  }
  return left.caseId.localeCompare(right.caseId);
};

/**
 * Pair this run's compute time with the released build's, one row per case.
 *
 * `releaseComparison` is the output of `buildReleaseComparison` — the wall-clock
 * ratio is taken from there rather than recomputed so the two halves of every
 * verdict can never disagree about what the wall clock did.
 *
 * V2 only. V1 does not use the V2 computed updater and emits none of the spans
 * this metric sums, so a V1 row would report zero compute for a case that
 * computes plenty. That is a limit of the instrument, not a measurement, and
 * printing it as one would be worse than omitting it.
 */
export const buildComputeComparison = ({
  payloads = [],
  baseline,
  releaseComparison,
  band = DEFAULT_COMPUTE_BAND,
} = {}) => {
  if (!Number.isFinite(band) || band <= 1) {
    throw new Error(`band must be greater than 1, received ${band}`);
  }

  const hasBaseline =
    Boolean(baseline?.runId) && Object.keys(baseline?.values ?? {}).length > 0;
  const wallRatios = new Map(
    (releaseComparison?.rows ?? []).map((row) => [row.caseId, row.releaseRatio]),
  );

  const counts = emptyCounts();
  const rows = [];

  for (const payload of payloads) {
    if (!payload?.caseId || payload.engine !== "v2") {
      continue;
    }

    const caseId = payload.caseId;
    const computeMs = computeValue(payload);
    const shape = computeShape(payload.metrics);

    if (payload.result === "pass" && computeMs === undefined) {
      // A passing case that computed nothing. Counted, not compared: it is a
      // real state for read-only cases, and lumping it into "missing baseline"
      // would make the corpus look less covered than it is.
      counts.noCompute += 1;
      continue;
    }
    if (computeMs === undefined) {
      continue;
    }

    const stored = hasBaseline
      ? baseline.values[`${caseId}::v2`]?.compute
      : undefined;

    if (!stored) {
      counts.missingBaseline += 1;
      rows.push({
        caseId,
        computeMs,
        shape,
        baselineComputeMs: undefined,
        baselineShape: undefined,
        computeRatio: undefined,
        wallRatio: wallRatios.get(caseId),
        shapeChanged: false,
        verdict: undefined,
      });
      continue;
    }

    // A shape change is not a regression and must never be rendered as a ratio;
    // the same work costs 2.2x through the outbox. Surfaced as its own state so
    // a mode switch shows up as the deliberate change it is.
    const shapeChanged = stored.shape !== shape;
    if (shapeChanged) {
      counts.shapeChanged += 1;
    }

    const computeRatio = shapeChanged ? undefined : computeMs / stored.value;
    const wallRatio = wallRatios.get(caseId);
    const verdict = computeVerdict({ wallRatio, computeRatio, band });

    if (Number.isFinite(computeRatio)) {
      counts.compared += 1;
      const computeDirection = direction(computeRatio, band);
      if (computeDirection === "slower") {
        counts.computeSlower += 1;
      } else if (computeDirection === "faster") {
        counts.computeFaster += 1;
      }
    }
    if (verdict) {
      counts[VERDICT_COUNT_KEY[verdict]] += 1;
    }

    rows.push({
      caseId,
      computeMs,
      shape,
      baselineComputeMs: stored.value,
      baselineShape: stored.shape,
      computeRatio,
      wallRatio,
      shapeChanged,
      verdict,
    });
  }

  rows.sort(compareRows);

  return {
    available: hasBaseline,
    band,
    rows,
    // Pre-filtered so the renderer does not reimplement the definition of
    // "interesting". `hidden-cost` belongs here with the other two: compute got
    // worse and the wall clock did not show it, which is precisely the case a
    // wall-clock-only report loses.
    deferred: rows.filter((row) => row.verdict === "deferred"),
    regressions: rows.filter((row) => row.verdict === "regression"),
    hiddenCost: rows.filter((row) => row.verdict === "hidden-cost"),
    counts,
  };
};
