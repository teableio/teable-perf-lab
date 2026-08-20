// What makes two change points the same change point.
//
// The shadow entry point re-derives every change point in the recent history of
// every series on each run, and reports 101 of them. Almost all were reported
// last run and the run before. Without a way to say "this is the one you have
// already seen", the output is a standing inventory rather than an alert, and
// nobody reads an alert that repeats itself.
//
// The identity is the case and the commit boundary it sits on: the same
// regression, re-detected, is the same regression. Deliberately not the
// magnitude or the p-value — both drift as more measurements land behind a
// change point, and an identity that moves when the evidence firms up would
// re-announce the same incident every run under a slightly different number.
//
// This is also the ledger's identity scheme, and it is built here rather than
// with the ledger because the shadow run needs it first. A ledger row is one
// change point; if two runs disagree about whether they saw the same one, the
// ledger cannot accumulate.
//
// Boundaries are named by commit rather than by position in the series. An
// ordinal is an index into a corpus that grows and gets re-segmented; a commit
// pair is a fact about the code.

/**
 * Stable key for a change point.
 *
 * `beforeCommit` may be absent when a change point sits at the very start of
 * the analysed window — the point before it fell outside. That is a real state
 * on a bounded window and is keyed explicitly rather than collapsed with a
 * genuine boundary, so a change point does not change identity the moment the
 * window slides past its left edge.
 */
export const changePointKey = ({ caseId, beforeCommit, afterCommit }) =>
  `${String(caseId ?? "").trim()}@${String(beforeCommit ?? "?").trim()}..${String(afterCommit ?? "?").trim()}`;

/**
 * Split this run's change points into the ones already reported and the rest.
 *
 * `known` is the set of keys from previous runs. The result carries both, plus
 * the updated set to persist — a caller that reports only `fresh` still has to
 * write back `known` or every run re-announces everything.
 *
 * Change points are never removed from `known`. A regression that was detected
 * and later stops being detected — because a fix landed and the level moved
 * back — has not become un-detected; the fix is its own change point, and the
 * original one stays in the record. This is the whole reason the project exists:
 * a hotfix must not erase the incident.
 */
export const separateFresh = (points = [], known = []) => {
  const seen = new Set(known);
  const fresh = [];
  const repeated = [];

  for (const point of points) {
    const key = changePointKey(point);
    if (seen.has(key)) {
      repeated.push({ ...point, key });
    } else {
      fresh.push({ ...point, key });
      seen.add(key);
    }
  }

  return {
    fresh,
    repeated,
    known: [...seen].sort(),
    counts: {
      fresh: fresh.length,
      repeated: repeated.length,
      known: seen.size,
    },
  };
};

/**
 * Pair a slowdown with the speedup that undid it, on the same case.
 *
 * An up change point followed later by a down one of comparable size is one
 * incident that was introduced and then fixed. `closingRatio` is how much of
 * the original slowdown a later speedup has to recover to count as its fix —
 * below that it is an unrelated improvement that happens to point the same way.
 *
 * Ordering is by the commit boundary's position, which the caller supplies
 * through `positionOf`, because this module does not know the mainline. A
 * change point whose position is unknown cannot be ordered against another and
 * is left open rather than paired on a guess.
 */
export const pairIncidents = (
  points = [],
  { positionOf = () => undefined, closingRatio = 0.6 } = {},
) => {
  const byCase = new Map();
  for (const point of points) {
    if (!byCase.has(point.caseId)) {
      byCase.set(point.caseId, []);
    }
    byCase.get(point.caseId).push(point);
  }

  const incidents = [];
  for (const [caseId, entries] of byCase) {
    const ordered = entries
      .map((point) => ({ point, at: positionOf(point.afterCommit) }))
      .filter((entry) => Number.isFinite(entry.at))
      .sort((left, right) => left.at - right.at);

    const openFixes = new Set();
    for (let index = 0; index < ordered.length; index += 1) {
      const { point } = ordered[index];
      if (!(point.ratio > 1)) continue;

      const slowdown = point.ratio;
      const fix = ordered
        .slice(index + 1)
        .find(
          (candidate) =>
            !openFixes.has(candidate.point) &&
            candidate.point.ratio < 1 &&
            1 / candidate.point.ratio >= slowdown * closingRatio,
        );
      if (fix) {
        openFixes.add(fix.point);
      }

      incidents.push({
        caseId,
        key: changePointKey(point),
        introducedAt: point.afterCommit,
        ratio: slowdown,
        fixedAt: fix?.point.afterCommit,
        // Open means still in production as far as the measurements show. That
        // is the number worth reporting, and the one the old comparison could
        // never produce.
        open: !fix,
      });
    }
  }

  return incidents.sort((left, right) => right.ratio - left.ratio);
};

const DAY_MS = 24 * 60 * 60 * 1000;

const daysBetween = (from, to) => {
  const start = Date.parse(from ?? "");
  const end = Date.parse(to ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }
  return Math.round(((end - start) / DAY_MS) * 10) / 10;
};

/**
 * Incidents with the two things a reader asks next: when, and for how long.
 *
 * `pairIncidents` answers "was this fixed" and stops there, which leaves the
 * question the ledger exists for — how long a regression stood — to whoever is
 * reading. This joins the mainline's own commit dates onto the pairing so the
 * answer is in the record.
 *
 * `asOf` is the newest mainline commit's date, not the wall clock. An open
 * incident's age has to be a fact about the history: reading the same corpus
 * twice must not produce two different numbers, and a run that happens at
 * 02:00 must not report an incident as older than the same run at 01:00 would.
 * It also means the age stops advancing when measurement stops, which is the
 * honest reading — nothing is known about a stretch nobody measured.
 *
 * `days` is the span from the introducing commit to the fixing one, or to
 * `asOf` while the incident is open. It is a lower bound in both directions and
 * the reason is in the acceptance criteria under B4: a regression fixed within
 * a few days is often never paired at all, so no count drawn from these records
 * is a complete incident history.
 */
export const describeIncidents = (
  points = [],
  { positionOf = () => undefined, dateOf = () => undefined, asOf, closingRatio } = {},
) => {
  const paired = pairIncidents(points, { positionOf, closingRatio });
  const byKey = new Map(points.map((point) => [changePointKey(point), point]));

  return paired.map((incident) => {
    const source = byKey.get(incident.key);
    const introducedOn = dateOf(incident.introducedAt);
    const fixedOn = incident.fixedAt ? dateOf(incident.fixedAt) : undefined;
    return {
      ...incident,
      introducedOn,
      fixedOn,
      days: daysBetween(introducedOn, fixedOn ?? asOf),
      // Carried so a reader can tell a V2 regression from a control channel
      // that moved, without joining back to the change point list.
      mover: source?.mover,
      v2Level: source?.v2Level,
    };
  });
};

/**
 * Days the longest open incident on this case has stood, if there is one.
 *
 * The longest rather than the newest: a case that stepped up twice and had
 * neither step undone has been slow since the first one.
 */
export const openDaysFor = (incidents = [], caseId) => {
  const days = incidents
    .filter(
      (incident) =>
        incident.caseId === caseId &&
        incident.open &&
        // A control-channel mover is not this case getting slower. Measured on
        // the real change points: `lookup/conditional-10k` pairs into a 1.42x
        // incident whose whole movement is V1 speeding up, and a standing row
        // saying it has been slow for N days would be citing the wrong series.
        incident.mover !== "v1" &&
        Number.isFinite(incident.days),
    )
    .map((incident) => incident.days);
  return days.length > 0 ? Math.max(...days) : undefined;
};
