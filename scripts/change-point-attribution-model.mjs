// What a confirmed change point is actually saying, spelled out.
//
// The confirmed layer detects on the paired series, `log(v2) - log(v1)`, and
// reports one commit and one ratio. Both of those are read by whoever triages
// as more than they are, and measurement says the misreading is common enough
// to matter. Two things get attached here so nobody has to work them out by
// hand.
//
// **Which engine moved.** A change in V1 alone produces a change point that
// reads exactly like a V2 regression, because the reported ratio is the ratio
// of the paired quantity. Measured over the 75 change points from the
// 2026-08-07 local run, comparing eight points either side of each boundary:
// 34 were V2 moving with V1 flat, 4 were the control moving with V2 flat, 2
// were both, 33 sat below the 1.25x bar this classifier uses, and 2 had no V1
// series. So roughly one in ten of the ones large enough to classify is the
// control channel, not V2 — `record-read/50k-50fields-sort-text-ascending` at
// `1dd78a15` reported 0.51x while V2 went 1814ms to 1629ms and V1 went 3683ms
// to 7316ms. Four items chased into V2 where nothing is wrong is four wasted
// triages and a reason to stop trusting the list.
//
// **Which commits are actually candidates.** Acceptance section B counts a
// detection as correct if it names the commit within ±1, and that tolerance is
// real: on `record-read/50k-50fields-group-number-low-cardinality` the culprit
// sits at mainline position 2600 and the change point reports 2601, naming an
// innocent neighbour. One noisy control point is enough to move where the split
// lands. A SHA in an alert does not read as "this or its neighbour", so the
// neighbours are named too.
//
// Both are computed from what the detector already has. Nothing here changes a
// verdict; it only says what the verdict covers.

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

// How many points either side of the boundary the engine medians are taken
// over. The same eight used for the measurement quoted above. Long enough that
// one noisy reading does not decide which engine moved, short enough to stay
// inside the level the change point is about — a wider window on a case that
// moved twice reaches back past the earlier move.
export const MOVEMENT_WINDOW = 8;

// Below this, a shift is not called for either engine. It is the classifier's
// bar, not the detector's: the detector already decided something changed, and
// this only answers where. A third of change points land under it, and those
// are reported as `below-bar` rather than being attributed to whichever engine
// happened to move further — attributing a 1.05x drift would be an invented
// answer at exactly the point where the data has none.
export const MOVEMENT_BAR = 1.25;

/**
 * Median level either side of a boundary, on one engine's raw values.
 *
 * Points are `[ordinal, value]`, and the boundary is the ordinal of the first
 * point after the change — the same convention the detector uses, so `after`
 * starts at the boundary rather than one past it.
 *
 * Returns `undefined` when either side is empty. A ratio against no
 * observations is not a small sample, it is not a measurement.
 */
export const levelsAcross = (
  points = [],
  boundaryOrdinal,
  { window = MOVEMENT_WINDOW } = {},
) => {
  const usable = points.filter(
    ([ordinal, value]) => Number.isFinite(ordinal) && value > 0,
  );
  const before = usable
    .filter(([ordinal]) => ordinal < boundaryOrdinal)
    .slice(-window)
    .map(([, value]) => value);
  const after = usable
    .filter(([ordinal]) => ordinal >= boundaryOrdinal)
    .slice(0, window)
    .map(([, value]) => value);
  if (before.length === 0 || after.length === 0) {
    return undefined;
  }
  const beforeLevel = median(before);
  const afterLevel = median(after);
  return {
    before: beforeLevel,
    after: afterLevel,
    ratio: afterLevel / beforeLevel,
    points: { before: before.length, after: after.length },
  };
};

/**
 * Which engine moved at this boundary.
 *
 * `mover` is one of:
 *
 *   - `v2` — the engine under test moved and the control did not. The reading
 *     everyone assumes; this is the one that says so.
 *   - `v1` — the control moved and V2 did not. The paired ratio still reports a
 *     change, and chasing it into V2 finds nothing.
 *   - `both` — the two moved together. Usually infrastructure, and worth
 *     knowing before anyone opens the commit.
 *   - `below-bar` — the detector is confident something changed, but neither
 *     engine's level moved past the classifier's bar. Real and small.
 *   - `no-control` — no V1 series to compare against, so the question cannot be
 *     answered here. Detection ran unpaired on V2 alone.
 *   - `unknown` — not enough points on one side of the boundary to take a
 *     median. Rare, and reported rather than guessed.
 */
export const attributeMovement = ({
  v2 = [],
  v1 = [],
  boundaryOrdinal,
  window = MOVEMENT_WINDOW,
  bar = MOVEMENT_BAR,
} = {}) => {
  const v2Levels = levelsAcross(v2, boundaryOrdinal, { window });
  const v1Levels =
    v1.length > 0 ? levelsAcross(v1, boundaryOrdinal, { window }) : undefined;

  const moved = (levels) =>
    Boolean(levels) && Math.abs(Math.log(levels.ratio)) >= Math.log(bar);

  let mover;
  if (!v2Levels) {
    mover = "unknown";
  } else if (v1.length === 0) {
    mover = "no-control";
  } else if (!v1Levels) {
    mover = "unknown";
  } else if (moved(v2Levels) && moved(v1Levels)) {
    mover = "both";
  } else if (moved(v2Levels)) {
    mover = "v2";
  } else if (moved(v1Levels)) {
    mover = "v1";
  } else {
    mover = "below-bar";
  }

  return { mover, bar, window, v2: v2Levels, v1: v1Levels };
};

/**
 * The commits a change point could be about, beyond the one it names.
 *
 * Two separate sources of doubt, kept apart because they mean different things:
 *
 *   - **The split can land one position off.** So a measured commit sitting one
 *     mainline position either side of the named one is a candidate, and is
 *     listed. This is the ±1 acceptance section B signs off on.
 *   - **Not every commit is measured.** The change happened somewhere after the
 *     last measured commit before the boundary, and the mainline commits in
 *     between carry no measurement at all. `unmeasuredBetween` counts them; a
 *     large number means the named commit is the end of a range rather than an
 *     answer, and no ±1 phrasing covers that.
 *
 * `previous` and `next` are the neighbouring points in the analysed series as
 * `[ordinal, commit]`, which is what the caller already has. Only real SHAs are
 * listed — a synthetic `#ordinal` placeholder names nothing anyone can open.
 */
export const attributionCandidates = ({
  afterOrdinal,
  beforeOrdinal,
  previous,
  next,
} = {}) => {
  const alsoPossible = [];
  const add = (entry) => {
    if (!entry) return;
    const [ordinal, commit] = entry;
    if (!Number.isInteger(ordinal) || !Number.isInteger(afterOrdinal)) return;
    if (Math.abs(ordinal - afterOrdinal) !== 1) return;
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/i.test(commit)) return;
    alsoPossible.push(commit);
  };
  add(previous);
  add(next);

  const unmeasuredBetween =
    Number.isInteger(afterOrdinal) && Number.isInteger(beforeOrdinal)
      ? Math.max(0, afterOrdinal - beforeOrdinal - 1)
      : undefined;

  return { alsoPossible, unmeasuredBetween };
};
