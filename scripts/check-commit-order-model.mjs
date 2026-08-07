import assert from "node:assert/strict";
import {
  buildOrderedSeries,
  isPinnedCommit,
  positionOf,
  segmentSeries,
} from "./commit-order-model.mjs";

const sha = (n) => String(n).padStart(40, "0");

// --- what counts as a pinned commit -----------------------------------------

// The 13 refs in the real history that pin nothing. `develop` is the dangerous
// one: it resolves today, just not to what was measured.
for (const ref of [
  "develop",
  "perf/v2-conditional-residual-and-array-join",
  "fix/T5338-duplicate-base-copy-batching",
  "",
  undefined,
]) {
  assert.equal(isPinnedCommit(ref), false, `${ref} must not count as a commit`);
}
assert.equal(isPinnedCommit(sha(1)), true);
// An abbreviated SHA is not accepted either — it would have to be resolved
// against a repo to be positioned, and this module never touches one.
assert.equal(isPinnedCommit("ad3b467880"), false);

// --- positioning ------------------------------------------------------------

{
  const ordinals = { [sha(1)]: 0, [sha(2)]: 7 };
  const excluded = { [sha(3)]: "offMainline" };

  assert.deepEqual(positionOf(sha(2), { ordinals, excluded }), {
    positioned: true,
    ordinal: 7,
  });
  // Ordinal 0 is the oldest mainline commit, not a missing value.
  assert.deepEqual(positionOf(sha(1), { ordinals, excluded }), {
    positioned: true,
    ordinal: 0,
  });
  assert.deepEqual(positionOf("develop", { ordinals, excluded }), {
    positioned: false,
    reason: "unpinned",
  });
  // The resolver's verdict is what separates a commit deliberately left off the
  // mainline from one the clone simply could not find.
  assert.deepEqual(positionOf(sha(3), { ordinals, excluded }), {
    positioned: false,
    reason: "offMainline",
  });
  assert.deepEqual(positionOf(sha(9), { ordinals, excluded }), {
    positioned: false,
    reason: "unresolved",
  });
}

// --- ordering and collapsing ------------------------------------------------

const ordinals = { [sha(1)]: 10, [sha(2)]: 20, [sha(3)]: 30 };

const row = (commit, value, extra = {}) => ({
  caseId: "record-read/10k",
  engine: "v2",
  commit,
  result: "pass",
  metric: "duration_ms",
  runId: "r1",
  value,
  ...extra,
});

// Rows arrive in whatever order the pages came back; the series must come out in
// mainline order. Sorting by arrival or by finish time would put a re-run of an
// older commit after a newer one.
{
  const { series } = buildOrderedSeries({
    rows: [row(sha(3), 300), row(sha(1), 100), row(sha(2), 200)],
    ordinals,
  });
  const points = series.get("record-read/10k::v2").points;
  assert.deepEqual(
    points.map((point) => point.ordinal),
    [10, 20, 30],
  );
  assert.deepEqual(
    points.map((point) => point.value),
    [100, 200, 300],
  );
}

// A commit measured several times collapses to one point at the median. Left
// uncollapsed it would sit at one position carrying several times a neighbour's
// weight, and E-Divisive would find a change point on that density alone.
{
  const { series } = buildOrderedSeries({
    rows: [
      row(sha(1), 100, { runId: "r1" }),
      row(sha(1), 900, { runId: "r2" }),
      row(sha(1), 120, { runId: "r3" }),
      row(sha(2), 200),
    ],
    ordinals,
  });
  const points = series.get("record-read/10k::v2").points;
  assert.equal(points.length, 2);
  // 900 is the retry that went wrong. The median keeps it from becoming the
  // point; a mean would have reported 373.
  assert.equal(points[0].value, 120);
  assert.equal(points[0].runs, 3);
  assert.equal(points[0].spread, 9);
  // A commit measured once has nothing to disagree with.
  assert.equal(points[1].spread, 1);
}

// Every excluded row is counted under a reason. A corpus that quietly shrank
// reads exactly like one that was always small.
{
  const { series, dropped } = buildOrderedSeries({
    rows: [
      row(sha(1), 100),
      row("develop", 100),
      row(sha(9), 100),
      row(sha(8), 100),
      row(sha(2), 0),
      row(sha(2), 100, { result: "fail" }),
      row(sha(2), 100, { result: "skipped" }),
    ],
    ordinals,
    excluded: { [sha(8)]: "offMainline" },
  });
  assert.deepEqual(dropped, {
    unpinned: 1,
    unresolved: 1,
    offMainline: 1,
    unusable: 3,
  });
  assert.equal(series.get("record-read/10k::v2").points.length, 1);
}

// Seed rows are bookkeeping, not measurements, and each engine is its own
// series — v1 is the control channel and must never be averaged into v2.
{
  const { series } = buildOrderedSeries({
    rows: [
      row(sha(1), 100, { engine: "v2" }),
      row(sha(1), 400, { engine: "v1" }),
      row(sha(1), 50, { engine: "seed" }),
    ],
    ordinals,
  });
  assert.deepEqual([...series.keys()].sort(), [
    "record-read/10k::v1",
    "record-read/10k::v2",
  ]);
  assert.equal(series.get("record-read/10k::v1").points[0].value, 400);
}

// --- segmentation -----------------------------------------------------------

const point = (ordinal, extra = {}) => ({
  ordinal,
  commit: sha(ordinal),
  value: 100,
  runs: 1,
  spread: 1,
  metric: "duration_ms",
  ...extra,
});

// A series with nothing changing underneath it is one segment.
assert.equal(segmentSeries([point(1), point(2), point(3)]).length, 1);

// A renamed primary metric splits the series: the same case id now carries two
// different measurements, and comparing across the rename invents a change
// point out of a units change.
{
  const segments = segmentSeries([
    point(1),
    point(2),
    point(3, { metric: "p95_ms" }),
    point(4, { metric: "p95_ms" }),
  ]);
  assert.equal(segments.length, 2);
  assert.deepEqual(
    segments.map((segment) => segment.length),
    [2, 2],
  );
}

// A config change splits it for the same reason, and this is the one that
// matters most in practice — changing a case's rowCount moves the metric
// further than any regression does.
{
  const digests = {
    [sha(1)]: "a",
    [sha(2)]: "a",
    [sha(3)]: "b",
    [sha(4)]: "b",
  };
  const segments = segmentSeries([point(1), point(2), point(3), point(4)], {
    digestAt: (commit) => digests[commit],
  });
  assert.equal(segments.length, 2);
}

// An unknown digest ends the segment rather than joining it. It cannot be shown
// to match its neighbour, and assuming it does is the whole failure this guards
// against — so the isolated point becomes its own segment and is too short to
// carry a change point.
{
  const digests = {
    [sha(1)]: "a",
    [sha(2)]: "a",
    [sha(4)]: "a",
    [sha(5)]: "a",
  };
  const segments = segmentSeries(
    [point(1), point(2), point(3), point(4), point(5)],
    { digestAt: (commit) => digests[commit] },
  );
  assert.deepEqual(
    segments.map((segment) => segment.map((p) => p.ordinal)),
    [[1, 2], [3], [4, 5]],
  );
}

// Without a digest lookup the series is only cut on metric renames — the state
// the corpus is in before the digest work lands, and it must not pretend
// otherwise by cutting nothing or everything.
assert.equal(segmentSeries([point(1), point(2), point(3)], {}).length, 1);

console.log("commit order model checks passed");
