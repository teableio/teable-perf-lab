// V2 against V1, inside one run. This is the comparison the lab shipped first,
// back on its own report instead of riding along as two extra numbers on every
// release-comparison row.
//
// Temporary by design. Once V2 is uniformly faster than V1 the V1 leg of the run
// is retired and this comparison goes with it; `full-run-comparison-model.mjs`
// is what survives. Deleting it is this file, the marked engine section of
// `perf-run-summary-model.mjs`, and one call in each of the two report scripts —
// so keep it self-contained and keep the release comparison free of V1.
//
// Keep this file pure. Rendering belongs in `perf-run-summary-model.mjs`.

import {
  groupPayloadsByCase,
  measuredValue,
} from "./full-run-comparison-model.mjs";

// Any slowdown the report can state, not the 1.2x release gate. The two
// comparisons answer different questions: the release gate has to clear
// run-to-run noise on the same code, while V1 and V2 are two implementations
// measured in the same run, so a small margin is still a real difference.
//
// The floor is the one the renderer's rounding already imposes — below 1.05 a
// row prints 持平, and counting it as a slowdown would file a row as 慢 while it
// printed a tie.
const TIE_RATIO = 1.05;

const isSlower = (ratio) => ratio !== undefined && ratio >= TIE_RATIO;

// Worst first, ties by case id, so the preview always carries the widest gaps.
const compareBySlowness = (left, right) => {
  if (left.ratio !== right.ratio) {
    return right.ratio - left.ratio;
  }
  return left.caseId.localeCompare(right.caseId);
};

/**
 * Compare each case's V2 measurement against its own V1 measurement.
 *
 * `ratio` is V2 divided by V1, so above 1 is slower — the same direction as
 * every ratio the release comparison prints.
 *
 * `available: false` means the run has no V1 leg at all, in which case there is
 * nothing to report and the caller should send nothing rather than a card of
 * "no V1 baseline" rows.
 */
export const buildEngineComparison = ({ payloads = [] } = {}) => {
  const rows = [];
  let compared = 0;
  let ranV1 = false;

  for (const [caseId, engines] of groupPayloadsByCase(payloads)) {
    const v1Payload = engines.v1;
    const v2Payload = engines.v2;
    if (v1Payload) {
      ranV1 = true;
    }
    const v1Value = measuredValue(v1Payload);
    const v2Value = measuredValue(v2Payload);
    const ratio =
      v1Value !== undefined && v2Value !== undefined
        ? v2Value / v1Value
        : undefined;
    if (ratio !== undefined) {
      compared += 1;
    }

    rows.push({
      caseId,
      v1Value,
      v2Value,
      // The raw results, so the renderer can tell "V1 never ran this case" from
      // "V1 ran it and failed" — both leave `v1Value` undefined, and printing
      // "skip" for a failure was wrong in the report this replaces.
      v1Result: v1Payload?.result,
      v2Result: v2Payload?.result,
      ratio,
      // A case with no ratio is pending, not passing: nothing was compared. A
      // case that failed lands here too — it timed a failure, and the run
      // reports it as a failure in the release panel rather than twice.
      status: isSlower(ratio)
        ? "attention"
        : ratio === undefined
          ? "pending"
          : "ok",
    });
  }

  const regressions = rows
    .filter((row) => row.status === "attention")
    .sort(compareBySlowness);
  const pending = rows
    .filter((row) => row.status === "pending")
    .sort((left, right) => left.caseId.localeCompare(right.caseId));

  return {
    available: ranV1,
    rows,
    regressions,
    pending,
    counts: {
      compared,
      slower: regressions.length,
      // Every remaining compared case: V2 matched or beat V1 and nothing failed.
      // The card prints the count and no rows — there is nothing to act on.
      faster: rows.filter((row) => row.status === "ok").length,
      pending: pending.length,
    },
  };
};
