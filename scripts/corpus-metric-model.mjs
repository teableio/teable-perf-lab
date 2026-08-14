// Which number the corpus records for a case, when the case's own primary
// metric is not one a history can be read from.
//
// The `record-read` overhead cases report `max(query − baseline, 0)`: the price
// of a filter/sort/group clause, measured by scanning the same rows twice. That
// is the right number for the case's threshold — the clause is what the case is
// about — and the wrong number for every question this system asks of a series.
//
// It shipped once, which is why this exists. Run 31765570337 pushed a card
// whose top two rows were `record-read/10k-50fields-group-three-levels` at 3.0x
// and `record-read/10k-50fields-filter-sort-groupby-overhead` at 2.5x, and
// neither case had got slower. Decomposed over the segment the card reported:
//
//   | | reported | baseline | query |
//   | --- | --- | --- | --- |
//   | group-three-levels | 2.0x slower | 1662→1167ms, 0.70x | 1947→2058ms, 1.06x |
//   | filter-sort-groupby-overhead | 2.9x slower | 1580→1106ms, 0.70x | 1866→1844ms, 0.99x |
//
// The baseline scan got about 30% faster and the query did not follow, so the
// gap widened — and the gap is what was reported. The V1 control channel cannot
// catch it, because the runner is not what moved: V1's own baseline went the
// other way over the same span, so the paired figure widens too.
//
// The same subtraction is why these cases fail the measurability screen. Both
// components are steady — V2's baseline jitters 1.17x and its query 1.14x
// against a corpus median of 1.09 — and their difference jitters 1.86x, because
// subtracting two numbers of similar size keeps the noise and discards the
// signal. V2 suffers more than V1 arithmetically rather than for a performance
// reason: V2 is faster at the clause, so its difference is 494ms where V1's is
// 1077ms, against the same ~250ms of component noise.
//
// So the corpus records the query's own duration for these cases instead. Three
// consequences, all deliberate:
//
//   - **Detection stops measuring what the case's threshold measures.** The
//     threshold still guards the clause overhead and should; a series is a
//     different instrument and needs a number that can carry a level.
//   - **The cases become detectable.** On the difference they are screened
//     `too-noisy` and no change point can ever name a commit for them. On the
//     query component they go through detection like any other case.
//   - **More points.** `Primary_Metric_Value > 0` drops every reading the clamp
//     floored at zero — 971 of 4860 rows across the twenty cases. The query
//     component is present and positive on all 4860.
//
// Substituting changes every value in those series, so their change point
// boundaries move and their keys are keys the seen-set has never seen. The
// revision below travels with the seen-set for exactly that reason; see
// `reseedDecision` in `run-shadow-analysis.mjs`.

/**
 * Primary metric → the `Metrics_JSON` key the corpus records in its place.
 *
 * Kept in step with `isClampedOverheadMetric` in
 * `framework/runners/record-read-model.ts` by `check-corpus-metric-model.mjs`:
 * a clamped metric declared there and missing here would silently go back to
 * being a difference.
 */
export const SUBSTITUTED_METRICS = new Map([
  ["getRecordsQueryOverheadMs", "getRecordsQueryPagedScanMs"],
  ["getRecordsFilterSortGroupByOverheadMs", "getRecordsQueryPagedScanMs"],
]);

/**
 * Metrics that are a clamped difference of two measurements.
 *
 * Every one of them is substituted above, so in a corpus built by the current
 * code no series carries one. It stays as the check of last resort: a metric
 * that reaches a series without being substituted — a row missing the component
 * key, a metric added on one side only — must not be read as a duration, and
 * `carriesDrift` is what refuses it.
 */
export const DIFFERENTIAL_METRICS = new Set(SUBSTITUTED_METRICS.keys());

/**
 * What the corpus calls this series' metric.
 *
 * The substituted name is recorded rather than the case's own, so a reader of
 * the corpus or the artifact can tell which number is in there without knowing
 * this table.
 */
export const corpusMetricName = (metric) =>
  SUBSTITUTED_METRICS.get(metric) ?? metric;

/**
 * Can a drift on this metric be read as the case getting slower?
 *
 * Applies to the standing list. Detection is not gated on it: a change point
 * says a level moved at a commit, which is true of a difference as much as of a
 * duration. This list is the one that turns a level into "the case is slower
 * now", and a widening gap is not that.
 */
export const carriesDrift = (metric) => !DIFFERENTIAL_METRICS.has(metric);

/**
 * A short string that changes whenever the substitution table does.
 *
 * Carried in the seen-set beside the analysis window, and compared for the same
 * reason: change what a series holds and every boundary in it moves, so the
 * first run under a new table would announce those cases' whole histories as
 * new findings. Derived from the table rather than bumped by hand, because a
 * revision someone has to remember to bump is a revision that will be wrong.
 */
export const corpusMetricRevision = () =>
  [...SUBSTITUTED_METRICS]
    .map(([from, to]) => `${from}>${to}`)
    .sort()
    .join(",") || "none";

/**
 * The value the corpus would record for one measurement.
 *
 * Used by the artifact reader so the same-run layer judges the same quantity
 * the history holds. Judging this run on the clause overhead against a history
 * of query durations would compare two different instruments and call the
 * difference a regression.
 *
 * Returns `undefined` when the component is missing, so the caller drops the
 * measurement rather than falling back to the difference. One point of a
 * different quantity in a series is worse than one point fewer.
 */
export const corpusMetricValue = ({ metric, primaryValue, metrics } = {}) => {
  const component = SUBSTITUTED_METRICS.get(metric);
  if (component === undefined) {
    return primaryValue;
  }
  const substituted = Number(metrics?.[component]);
  return Number.isFinite(substituted) ? substituted : undefined;
};
