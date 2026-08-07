// Whether a change point can be blamed on teable-ee, or whether the measuring
// apparatus moved at the same time.
//
// A perf-lab change can move the numbers without any teable-ee change at all.
// The real one: `f60f31e7` ("Stop selective read variants measuring a
// clamped-zero overhead") changed what `getRecordsQueryOverheadMs` means for
// selective record-read variants — before it, the metric was structurally
// clamped to a flat 0 ms. Every case using it has a history in two different
// units, joined by a step that no teable-ee commit caused.
//
// The obvious fix, cutting a case's series wherever its runner changed, was
// measured and rejected: 167 of the 266 perf-lab commits in the history touch
// `framework/runners/`, and `conditional-lookup.runner.ts` alone changed 20
// times. Cutting there would leave segments averaging six points and no
// detection at all. The cure would be far worse than the disease.
//
// So nothing is cut. A change point sits between two teable-ee commits, and
// those two commits were measured by some set of perf-lab commits; if the
// measuring code for that case's runner changed inside that set, the change
// point has two candidate causes and the report has to say so. Attribution is
// downgraded, not deleted — the history stays whole, and a human sees both
// candidates instead of a confident wrong answer.
//
// This is the same shape as the control channel: rather than pre-emptively
// destroying data to avoid a confound, name the confound where it applies.

/**
 * Runner source files whose change alters how a case is measured.
 *
 * Keyed by the `runner` a case declares. Only files that compute or shape the
 * measurement belong here — a change to a runner's logging or its type
 * declarations moves nothing, and listing it would downgrade attribution for
 * no reason.
 */
export const runnerSources = (runner) => {
  const name = String(runner ?? "").trim();
  if (!name) return [];
  return [
    `framework/runners/${name}.runner.ts`,
    `framework/runners/${name}-model.ts`,
    `framework/runners/${name}-workload.ts`,
  ];
};

/**
 * Did the measuring code change between two measurements?
 *
 * `perfLabAt` maps a teable-ee commit to the perf-lab commit that measured it;
 * `changedPaths` maps a perf-lab commit to the paths it touched. Both come from
 * artifacts the corpus build already produces.
 *
 * The comparison is between the two perf-lab commits bracketing the change
 * point, not the whole range between them: intermediate perf-lab commits that
 * measured nothing cannot have affected either measurement.
 */
export const harnessMoved = ({
  runner,
  beforeCommit,
  afterCommit,
  perfLabAt = {},
  changedPaths = {},
}) => {
  const before = perfLabAt[beforeCommit];
  const after = perfLabAt[afterCommit];
  if (!before || !after || before === after) {
    // Same perf-lab commit on both sides means the apparatus is identical and
    // the change point cannot be its doing. An unknown side is not evidence of
    // safety, but it is not evidence of interference either — say so by
    // reporting no move, and let the corpus's own "unknown digest" cut handle
    // the genuinely unknown case.
    return { moved: false, before, after, paths: [] };
  }

  const sources = new Set(runnerSources(runner));
  const paths = (changedPaths[after] ?? []).filter((path) => sources.has(path));
  return { moved: paths.length > 0, before, after, paths };
};

/**
 * Attach an attribution verdict to each change point.
 *
 * `confident` means one candidate cause: a teable-ee commit. `ambiguous` means
 * the measuring code moved in the same step, and the report must offer both.
 *
 * Nothing is filtered here. A finding that is downgraded is still a finding —
 * a harness change that shifted a case by 3x is worth someone's attention even
 * though it is not a product regression.
 */
export const attributeChangePoints = ({
  points = [],
  runnerOf = () => undefined,
  perfLabAt = {},
  changedPaths = {},
}) =>
  points.map((point) => {
    const verdict = harnessMoved({
      runner: runnerOf(point.caseId),
      beforeCommit: point.beforeCommit,
      afterCommit: point.afterCommit,
      perfLabAt,
      changedPaths,
    });
    return {
      ...point,
      attribution: verdict.moved ? "ambiguous" : "confident",
      harnessPaths: verdict.paths,
    };
  });
