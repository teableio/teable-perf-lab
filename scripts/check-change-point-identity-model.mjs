import assert from "node:assert/strict";
import {
  changePointKey,
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

console.log("change point identity model checks passed");
