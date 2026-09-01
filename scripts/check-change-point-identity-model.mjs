import assert from "node:assert/strict";
import {
  changePointKey,
  describeIncidents,
  openDaysFor,
  pairIncidents,
  separateFresh,
} from "./change-point-identity-model.mjs";

const point = (caseId, before, after, ratio = 2) => ({
  caseId,
  beforeCommit: before,
  afterCommit: after,
  ratio,
});

// --- identity ---------------------------------------------------------------

// The same regression re-detected next run is the same regression.
assert.equal(
  changePointKey(point("read/a", "c1", "c2")),
  changePointKey(point("read/a", "c1", "c2")),
);

// Magnitude and p-value are deliberately not part of it. Both firm up as more
// measurements land behind a change point, and an identity that moved with them
// would re-announce the same incident every run under a new number.
assert.equal(
  changePointKey({ ...point("read/a", "c1", "c2", 2.0), pValue: 1e-4 }),
  changePointKey({ ...point("read/a", "c1", "c2", 2.4), pValue: 1e-2 }),
);

// Different case, or different boundary, is a different change point.
assert.notEqual(
  changePointKey(point("read/a", "c1", "c2")),
  changePointKey(point("read/b", "c1", "c2")),
);
assert.notEqual(
  changePointKey(point("read/a", "c1", "c2")),
  changePointKey(point("read/a", "c2", "c3")),
);

// A change point at the very start of the analysed window has no point before
// it. That is a real state on a bounded window and is keyed explicitly, so the
// identity does not change the moment the window slides past its left edge.
assert.equal(
  changePointKey({ caseId: "read/a", afterCommit: "c2" }),
  "read/a@?..c2",
);

// --- fresh versus already reported ------------------------------------------

{
  const first = separateFresh([
    point("read/a", "c1", "c2"),
    point("read/b", "c4", "c5"),
  ]);
  assert.equal(first.counts.fresh, 2);
  assert.equal(first.counts.repeated, 0);

  // Next run re-derives both and finds one more. Only the new one is news.
  const second = separateFresh(
    [
      point("read/a", "c1", "c2"),
      point("read/b", "c4", "c5"),
      point("read/c", "c7", "c8"),
    ],
    first.known,
  );
  assert.deepEqual(
    second.fresh.map((entry) => entry.caseId),
    ["read/c"],
  );
  assert.equal(second.counts.repeated, 2);
  assert.equal(second.counts.known, 3);
}

// Duplicates inside one run collapse; the second sighting is not news either.
{
  const result = separateFresh([
    point("read/a", "c1", "c2"),
    point("read/a", "c1", "c2"),
  ]);
  assert.equal(result.counts.fresh, 1);
  assert.equal(result.counts.repeated, 1);
}

// A change point that stops being detected is not removed from `known`. A fix
// landing does not un-detect the regression — the fix is its own change point,
// and the original stays on the record. This is the entire point of the
// project: a hotfix must not erase the incident.
{
  const first = separateFresh([point("read/a", "c1", "c2")]);
  const later = separateFresh([], first.known);
  assert.deepEqual(later.known, first.known);
  assert.equal(later.counts.fresh, 0);
}

// --- pairing a regression with its fix --------------------------------------

const positions = { c2: 10, c5: 20, c8: 30 };
const positionOf = (commit) => positions[commit];

// Slower, then faster by a comparable amount: one incident, closed.
{
  const [incident] = pairIncidents(
    [point("read/a", "c1", "c2", 2.0), point("read/a", "c4", "c5", 0.5)],
    { positionOf },
  );
  assert.equal(incident.open, false);
  assert.equal(incident.introducedAt, "c2");
  assert.equal(incident.fixedAt, "c5");
}

// A later speedup too small to undo the slowdown is an unrelated improvement,
// not the fix, and the incident stays open.
{
  const [incident] = pairIncidents(
    [point("read/a", "c1", "c2", 2.0), point("read/a", "c4", "c5", 0.95)],
    { positionOf },
  );
  assert.equal(incident.open, true);
  assert.equal(incident.fixedAt, undefined);
}

// A speedup that came *before* the slowdown cannot be its fix.
{
  const [incident] = pairIncidents(
    [point("read/a", "c1", "c2", 0.5), point("read/a", "c4", "c5", 2.0)],
    { positionOf },
  );
  assert.equal(incident.introducedAt, "c5");
  assert.equal(incident.open, true);
}

// One speedup closes one slowdown. Two separate regressions both claiming the
// same fix would report one incident as closed that never was.
{
  const incidents = pairIncidents(
    [
      point("read/a", "c1", "c2", 2.0),
      point("read/a", "c4", "c5", 2.0),
      point("read/a", "c7", "c8", 0.5),
    ],
    { positionOf },
  );
  assert.equal(incidents.filter((entry) => !entry.open).length, 1);
  assert.equal(incidents.filter((entry) => entry.open).length, 1);
}

// A change point whose boundary cannot be placed on the mainline is left out
// rather than ordered on a guess — pairing the wrong two would report a fix
// that did not happen.
{
  const incidents = pairIncidents(
    [point("read/a", "c1", "unknown", 2.0), point("read/a", "c1", "c2", 3.0)],
    { positionOf },
  );
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].introducedAt, "c2");
}

// Worst first, so a reader who stops after two lines saw the two that matter.
{
  const incidents = pairIncidents(
    [point("read/a", "c1", "c2", 1.5), point("read/b", "c4", "c5", 3.0)],
    { positionOf },
  );
  assert.deepEqual(
    incidents.map((entry) => entry.caseId),
    ["read/b", "read/a"],
  );
}

// --- how long it stood ---------------------------------------------------------

// The number the ledger exists to produce. A fixed incident is measured to its
// fix; an open one to the newest mainline commit, never to the wall clock —
// otherwise the same history answers differently depending on when it is read.
{
  const dates = {
    c2: "2026-08-01T00:00:00Z",
    c5: "2026-08-08T12:00:00Z",
  };
  const [fixed] = describeIncidents(
    [point("read/a", "c1", "c2", 2.0), point("read/a", "c4", "c5", 0.5)],
    {
      positionOf,
      dateOf: (commit) => dates[commit],
      asOf: "2026-08-20T00:00:00Z",
    },
  );
  assert.equal(fixed.open, false);
  assert.equal(fixed.days, 7.5, "a closed incident is measured to its fix");

  const [open] = describeIncidents([point("read/a", "c1", "c2", 2.0)], {
    positionOf,
    dateOf: (commit) => dates[commit],
    asOf: "2026-08-20T00:00:00Z",
  });
  assert.equal(open.open, true);
  assert.equal(
    open.days,
    19,
    "an open incident is measured to the newest commit",
  );

  // Same inputs, same answer, whenever it is read. The guard is against
  // reaching for `Date.now()` here, which would make every run disagree with
  // the one before it about how old the same incident is.
  assert.equal(
    describeIncidents([point("read/a", "c1", "c2", 2.0)], {
      positionOf,
      dateOf: (commit) => dates[commit],
      asOf: "2026-08-20T00:00:00Z",
    })[0].days,
    19,
  );
}

// A commit the clone could not date is reported without a duration rather than
// with a wrong one. Ordering resolves ~86% of the refs a corpus mentions, so
// this is the normal state of some rows, not an edge case.
{
  const [incident] = describeIncidents([point("read/a", "c1", "c2", 2.0)], {
    positionOf,
    dateOf: () => undefined,
    asOf: "2026-08-20T00:00:00Z",
  });
  assert.equal(incident.days, undefined);
  assert.equal(incident.open, true);
}

// Attribution travels with the incident, so a reader can tell a V2 regression
// from a control channel that moved without joining back to the change points.
{
  const withMover = {
    ...point("read/a", "c1", "c2", 2.0),
    mover: "v1",
    v2Level: { before: 100, after: 101 },
    historyCompatibility: "legacy-fallback",
  };
  const [incident] = describeIncidents([withMover], { positionOf });
  assert.equal(incident.mover, "v1");
  assert.deepEqual(incident.v2Level, { before: 100, after: 101 });
  assert.equal(incident.historyCompatibility, "legacy-fallback");
}

// --- the duration a standing row is allowed to print ---------------------------

// Only from an open incident V2 itself moved on. Measured on the real change
// points: `lookup/conditional-10k` pairs into a 1.42x incident whose entire
// movement is the control channel speeding up, and a standing row citing its
// age would be quoting the wrong series at a reader who cannot see the join.
{
  const incidents = [
    { caseId: "read/a", open: true, days: 4, mover: "v2" },
    { caseId: "read/a", open: true, days: 11, mover: "v2" },
    { caseId: "read/a", open: false, days: 30, mover: "v2" },
    { caseId: "read/b", open: true, days: 9, mover: "v1" },
    { caseId: "read/c", open: true, days: undefined, mover: "v2" },
  ];
  assert.equal(openDaysFor(incidents, "read/a"), 11, "the longest open one");
  assert.equal(
    openDaysFor(incidents, "read/b"),
    undefined,
    "a control-channel mover is not this case getting slower",
  );
  assert.equal(openDaysFor(incidents, "read/c"), undefined);
  assert.equal(openDaysFor(incidents, "read/absent"), undefined);
  assert.equal(openDaysFor([], "read/a"), undefined);
}

console.log("change point identity model checks passed");
