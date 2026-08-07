// Ordering Performance Track rows into per-case series along teable-ee's mainline.
//
// A change point is only useful if it lands between two adjacent commits, and
// that requires the series to be in the order the code actually changed. Three
// things make that harder than sorting by date:
//
//   1. `Finished At` is not commit order. Runs are re-dispatched, re-run after a
//      flaky failure, and occasionally backfilled, so a later measurement can
//      belong to an earlier commit.
//   2. Not every `Teable EE Ref` is a commit. 13 of the 571 refs in the history
//      are branch names (`develop`, `perf/...`), which pin nothing — resolving
//      one today gives whatever that branch points at today, not what was
//      measured.
//   3. Not every commit is on the mainline. teable-ee merges by squash, so a
//      commit measured on a PR branch never becomes an ancestor of `develop`;
//      the equivalent code lands later under a different SHA.
//
// The rule here is that a series describes what the mainline did over time, so
// only commits on `develop`'s first-parent chain get a position. That excludes
// pre-merge branch measurements even when the branch was merged afterwards —
// they measured code that was never on the mainline, and a change point
// attributed to the merge point on the strength of them would name the wrong
// change.
//
// Measured against the history as of 2026-08-07: 494 of 571 refs are positioned,
// keeping 132,113 of 143,350 rows (128,521 of them usable), 387 of 393 cases,
// and 165 of 180 full runs. What goes is 5,524 rows on branch names, 5,494 on
// commits that never reached the mainline, and 219 on refs the clone cannot
// resolve at all.
//
// Nothing is dropped silently. Every excluded row is counted under a reason, and
// the caller is expected to report those counts — a corpus that quietly shrank
// is indistinguishable from one that was always small.
//
// Keep this file pure. Git and filesystem work belongs in
// `resolve-commit-order.mjs`.

export const MAINLINE_BRANCH = "develop";

// Exclusion reasons, in the order a row is checked against them.
export const EXCLUSION_REASONS = [
  // `Teable EE Ref` is not a 40-hex SHA — a branch name, which pins nothing.
  "unpinned",
  // A SHA that the local teable-ee clone cannot resolve. Force-pushed or
  // deleted branches; 42 such refs remained after a full fetch, and they are
  // only 219 rows between them.
  "unresolved",
  // A real commit that is not on the mainline first-parent chain.
  "offMainline",
  // Not a passing measurement, or not a usable number.
  "unusable",
];

const SHA_PATTERN = /^[0-9a-f]{40}$/;

export const isPinnedCommit = (ref) =>
  SHA_PATTERN.test(String(ref ?? "").trim());

/**
 * Where a ref sits on the mainline, or why it does not.
 *
 * `ordinals` maps a commit SHA to its index along the first-parent chain,
 * oldest first, so a larger ordinal is a later commit. `excluded` carries the
 * resolver's verdict for the refs it deliberately left out, which is how
 * "unresolved" is told apart from "off mainline" — from inside this module both
 * are just absent from the map.
 */
export const positionOf = (ref, { ordinals = {}, excluded = {} } = {}) => {
  const key = String(ref ?? "").trim();
  if (!key) {
    return { positioned: false, reason: "unpinned" };
  }
  if (!isPinnedCommit(key)) {
    return { positioned: false, reason: "unpinned" };
  }
  const ordinal = ordinals[key];
  if (Number.isInteger(ordinal)) {
    return { positioned: true, ordinal };
  }
  return { positioned: false, reason: excluded[key] ?? "unresolved" };
};

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const usableValue = (row) => {
  if (row?.result !== "pass") {
    return undefined;
  }
  const value = Number(row.value);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

const seriesKey = (caseId, engine) => `${caseId}::${engine}`;

/**
 * Fold every row into one point per case, engine, and mainline commit.
 *
 * A commit measured more than once collapses to the median of its runs, not the
 * latest and not the mean. Median because a commit gets measured twice mostly
 * when the first attempt went wrong — a retry after a flaky failure, a
 * re-dispatch — so the repeat set is enriched for bad draws and a mean would
 * carry them into the series. Not the latest for the same reason, and because
 * the latest is an arbitrary pick among equals when nothing went wrong.
 *
 * Leaving the runs uncollapsed is not an option: a commit measured ten times
 * would sit at one position with ten times the weight of its neighbours, and
 * E-Divisive would find a change point at the edge of that cluster on density
 * alone.
 *
 * `metric` rides along on each point. A case whose primary metric was renamed
 * has two different measurements sharing one id, and the segmentation step needs
 * to see the rename to cut the series there. Only 4 cases have ever done this,
 * but an unsegmented rename is a guaranteed false change point.
 */
export const buildOrderedSeries = ({
  rows = [],
  ordinals = {},
  excluded = {},
} = {}) => {
  const buckets = new Map();
  const dropped = Object.fromEntries(
    EXCLUSION_REASONS.map((reason) => [reason, 0]),
  );

  for (const row of rows) {
    const caseId = String(row?.caseId ?? "").trim();
    const engine = String(row?.engine ?? "").trim();
    if (!caseId || !engine || engine === "seed") {
      continue;
    }

    const position = positionOf(row.commit, { ordinals, excluded });
    if (!position.positioned) {
      dropped[position.reason] = (dropped[position.reason] ?? 0) + 1;
      continue;
    }

    const value = usableValue(row);
    if (value === undefined) {
      dropped.unusable += 1;
      continue;
    }

    const key = seriesKey(caseId, engine);
    let series = buckets.get(key);
    if (!series) {
      series = { caseId, engine, byCommit: new Map() };
      buckets.set(key, series);
    }

    const commit = String(row.commit).trim();
    let point = series.byCommit.get(commit);
    if (!point) {
      point = {
        ordinal: position.ordinal,
        commit,
        values: [],
        runs: new Set(),
        metrics: new Set(),
      };
      series.byCommit.set(commit, point);
    }
    point.values.push(value);
    if (row.runId) {
      point.runs.add(String(row.runId));
    }
    const metric = String(row.metric ?? "").trim();
    if (metric) {
      point.metrics.add(metric);
    }
  }

  const series = new Map();
  for (const [key, bucket] of buckets) {
    const points = [...bucket.byCommit.values()]
      .map((point) => ({
        ordinal: point.ordinal,
        commit: point.commit,
        value: median(point.values),
        runs: point.runs.size || 1,
        // Kept for the noise model and for diagnosing a point that collapsed a
        // wide disagreement: same commit, same case, so the spread is noise.
        spread:
          point.values.length > 1
            ? Math.max(...point.values) / Math.min(...point.values)
            : 1,
        metric: point.metrics.size === 1 ? [...point.metrics][0] : undefined,
      }))
      .sort((left, right) => left.ordinal - right.ordinal);
    series.set(key, { caseId: bucket.caseId, engine: bucket.engine, points });
  }

  return { series, dropped };
};

/**
 * Cut a series wherever its points stop being comparable.
 *
 * Two reasons to cut, and both produce numbers that share a case id while
 * measuring different things:
 *
 *   - the primary metric was renamed, so the values are two different
 *     measurements;
 *   - the case's own config digest changed, so the workload itself is different.
 *
 * A cut is not a gap. Change point detection may not look across one, because a
 * config change moves the metric further than any regression does and would be
 * reported as the strongest change point on the board.
 *
 * `digestAt` is a lookup from commit to that case's config digest, supplied by
 * the segmentation work; without it only metric renames cut. A commit whose
 * digest is unknown ends the current segment rather than joining it — an
 * unknown digest cannot be shown to be the same as its neighbour's, and
 * assuming it is is exactly the mistake this guards against.
 */
export const segmentSeries = (points = [], { digestAt } = {}) => {
  const segments = [];
  let current = [];
  let metric;
  let digest;

  for (const point of points) {
    const pointDigest = digestAt ? digestAt(point.commit) : undefined;
    const metricChanged =
      current.length > 0 &&
      point.metric !== undefined &&
      point.metric !== metric;
    const digestChanged =
      current.length > 0 &&
      digestAt !== undefined &&
      (pointDigest === undefined || pointDigest !== digest);

    if (metricChanged || digestChanged) {
      segments.push(current);
      current = [];
    }

    current.push(point);
    if (point.metric !== undefined) {
      metric = point.metric;
    }
    digest = pointDigest;
  }

  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
};
