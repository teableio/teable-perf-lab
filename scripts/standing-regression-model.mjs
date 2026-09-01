// Which cases are slower now than they used to be, whoever did it.
//
// The confirmed layer answers "which commit did this" and answers it well, but
// it only speaks when a boundary crosses its bar, and each answer is about one
// moment. Nobody was answering the other question the owner asked for: *which
// cases are slow right now*. A case that has been 2x slower for two months is
// not news to a change point detector — it announced that once, weeks ago, and
// correctly says nothing since. It is very much news to a person.
//
// So this is a status view rather than an alert. It compares where a case sits
// today against where it started, and it does not care whether a change point
// was ever attributed. Three things follow from that:
//
//   - **It needs no detection.** It is two medians and a division, so the
//     measurability screen that gates detection does not gate this. That is a
//     deliberate bypass and it has already cost something: the screen was also
//     standing in for whether a case's metric means anything, which nobody had
//     written down as one of its jobs, and two cases whose metric is a clamped
//     difference reached the card reading 3.0x and 2.5x slower when neither had
//     got slower at all. `carriesDrift` is that job, written down.
//   - **It needs no seen-set.** "Still slower" is true every day until someone
//     fixes it, and a status list that suppressed repeats would empty itself
//     out while the problem stood.
//   - **It does not itself name a commit.** It says a case is slower than it
//     was; the confirmed layer is what says who did it. But the confirmed layer
//     runs over the same full history in the same pass, so where it has an
//     answer for a standing case, `attributeStanding` below carries it onto the
//     row rather than leaving the reader to match two lists by eye.
//
// Measured on run 31765570337, this reports 15 cases and names a commit for
// every one of them.
//
// `change-point-attribution-model.mjs` is a leaf and imports nothing, so the
// join below can reach for its regression rule rather than restating it. The
// card imports from both; nothing imports the card. `carriesDrift` comes from
// `corpus-metric-model.mjs`, which owns the question of what number is in a
// series and therefore whether a ratio of two of them means anything.
//
// The controlled channel removes a well-supported global run effect from each
// V2 observation. It does not use V1 subtraction: historical V1 and V2 matrix
// jobs ran on separate GitHub-hosted VMs, so their ratio is useful corroborating
// evidence but not a paired control.

import { survivingSteps } from "./change-point-attribution-model.mjs";
import { carriesDrift } from "./corpus-metric-model.mjs";

// Points at each end of the segment that define "then" and "now".
//
// Twenty rather than a handful: the two ends are medians, and a median of five
// noisy points moves enough on its own to invent a drift. Twenty is also what
// the calibration below was measured at.
export const EDGE_WINDOW = 20;

// A segment shorter than this cannot support two non-overlapping windows with
// enough history between them for "drifted" to mean anything. At three times
// the edge window there is a full window's gap in the middle.
export const MIN_SEGMENT = 3 * EDGE_WINDOW;

// How much slower, against the control, before it is worth a row.
//
// The same 1.25x the movement classifier uses, and for the same reason: below
// it nobody opens anything. Applied to the runner-adjusted figure, so a case
// only qualifies if it slowed beyond the broad movement of the run cohort.
export const DRIFT_BAR = 1.25;

// And how many milliseconds slower, at minimum.
//
// A ratio alone put `smoke/auth-user` on the first card this shipped: 5ms to
// 11ms, a genuine 2.13x against its control, and six milliseconds that nobody
// will ever investigate. At a 5ms baseline a millisecond of timer noise is a
// fifth of the value.
//
// This is a magnitude test and deliberately not the measurability screen, which
// judges *noisiness* and is bypassed here on purpose. Bypassing a judgement
// about noise is not a reason to stop making a judgement about size.
//
// Twenty is a floor rather than a threshold anyone should tune: on the
// nineteen cases the first card carried, `smoke/auth-user` gained 6ms and the
// next smallest gained 22ms, so nothing else in the corpus sits near it.
export const MIN_INCREASE_MS = 20;

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const edges = (values, window) => ({
  then: median(values.slice(0, window)),
  now: median(values.slice(-window)),
});

/**
 * How far this case has moved from where it started, on both measurements.
 *
 * `controlled` is the verdict and `v2` is what the row prints. They are reported
 * separately rather than collapsed because they disagree in a way that matters:
 * a changing runner estimate can widen the corrected channel without V2
 * moving at all. Requiring both prevents that estimate from creating a status
 * row by itself.
 *
 * Returns `undefined` when the segment is too short to have two ends.
 */
export const driftOf = ({
  controlled = [],
  v2 = [],
  window = EDGE_WINDOW,
} = {}) => {
  if (controlled.length < MIN_SEGMENT || v2.length < MIN_SEGMENT) {
    return undefined;
  }
  // `controlled` carries runner-adjusted log values; `v2` carries milliseconds.
  const controlledEdges = edges(controlled, window);
  const v2Edges = edges(v2, window);
  if (!(v2Edges.then > 0) || !(v2Edges.now > 0)) {
    return undefined;
  }
  return {
    controlledDrift: Math.exp(controlledEdges.now - controlledEdges.then),
    v2Drift: v2Edges.now / v2Edges.then,
    v2Then: v2Edges.then,
    v2Now: v2Edges.now,
    points: v2.length,
  };
};

/**
 * Does this case belong on the list?
 *
 * All three tests earn their place. The corrected ratio alone admits the cases
 * where only the control moved; V2's ratio alone admits everything the runner
 * did to everybody; and the two ratios together still admit a case that gained
 * six milliseconds.
 */
export const isStanding = (drift) =>
  Boolean(drift) &&
  drift.controlledDrift > DRIFT_BAR &&
  drift.v2Drift > DRIFT_BAR &&
  drift.v2Now - drift.v2Then >= MIN_INCREASE_MS;

/**
 * The standing list for a corpus, worst first.
 *
 * `series` is the corpus as `build-perf-corpus.mjs` writes it, and
 * `controlledFor` hands back the adjusted points for a case — both supplied by the
 * caller so this file holds the rule and not the plumbing.
 */
export const standingRegressions = ({
  series = {},
  controlledFor,
  window = EDGE_WINDOW,
  limit = Infinity,
} = {}) => {
  const rows = [];
  for (const entry of Object.values(series)) {
    if (entry?.engine !== "v2") {
      continue;
    }
    if (!carriesDrift(entry.metric)) {
      continue;
    }
    const controlled = controlledFor(entry);
    if (!controlled) {
      continue;
    }
    const drift = driftOf({
      controlled: controlled.controlled,
      v2: controlled.v2,
      window,
    });
    if (!isStanding(drift)) {
      continue;
    }
    rows.push({ caseId: entry.caseId, ...drift });
  }
  return rows
    .sort((left, right) => right.controlledDrift - left.controlledDrift)
    .slice(0, limit);
};

/**
 * Which commit made each standing case slow.
 *
 * The two lists are produced by the same pass over the same full history: the
 * standing row says a case has not come back, and the confirmed layer has
 * already worked out, for every case it can detect on, which commit pair each
 * step sits at. Joining them costs nothing and answers the question the card
 * was leaving open — "it is 2.5x slower" invites "since when, and by whom", and
 * that answer was being computed and thrown away.
 *
 * Eligibility is `survivingSteps`, not the case's biggest step. A standing row
 * is about where the case sits *today*, and the biggest step in its history may
 * have been taken back — measured on the real corpus, the biggest step on
 * `lookup/customer-update-user-update-order-4k-depth5` runs 1335ms → 10417ms
 * against a case now sitting at 1616ms. Naming that commit would point triage
 * at a problem that is no longer there, which is why the current level is
 * passed down rather than the steps being ranked on size alone.
 *
 * `introducedBy` is the largest surviving step and `otherSteps` counts the
 * rest rather than hiding them: `lookup/foreign-select-flip-1of40-fanout100-4k`
 * did not slow down once, it climbed four consecutive mainline commits, and a
 * row naming one of the four as *the* cause would be wrong in a way the reader
 * cannot see. The drift the row prints is the net of everything between the
 * ends, which is why the commit is offered as where the largest step landed
 * rather than as the whole account.
 *
 * `unattributed` says why a row has no commit, because a silent row reads as a
 * failed lookup:
 *
 *   - `screened` — the measurability screen kept this case out of detection, so
 *     nothing ever had the chance to attribute it. This is the reason the
 *     standing list exists at all: `record-read/10k-50fields-group-three-levels`
 *     is the worst drift in the corpus and no change point will ever name it.
 *   - `no-step` — the case was detected on and nothing confirmed, or everything
 *     that confirmed was later taken back. A slope rather than a staircase;
 *     there is no single commit to name and saying so is the honest answer.
 */
export const attributeStanding = ({
  standing = [],
  confirmed = [],
  unjudged = [],
} = {}) => {
  const byCase = new Map();
  for (const point of confirmed) {
    if (!point?.caseId) {
      continue;
    }
    if (!byCase.has(point.caseId)) {
      byCase.set(point.caseId, []);
    }
    byCase.get(point.caseId).push(point);
  }
  const screened = new Set(unjudged);

  return standing.map((row) => {
    const steps = survivingSteps(byCase.get(row.caseId) ?? [], {
      currentLevel: row.v2Now,
    });
    if (steps.length === 0) {
      return {
        ...row,
        unattributed: screened.has(row.caseId) ? "screened" : "no-step",
      };
    }
    const [largest] = steps;
    return {
      ...row,
      introducedBy: {
        beforeCommit: largest.beforeCommit,
        afterCommit: largest.afterCommit,
        v2Before: largest.v2Level?.before,
        v2After: largest.v2Level?.after,
        alsoPossible: largest.alsoPossible ?? [],
        unmeasuredBetween: largest.unmeasuredBetween,
      },
      otherSteps: steps.length - 1,
    };
  });
};
