// Release-baseline comparison: this run's measured metric against the run that
// produced the currently released teable-ee commit.
//
// The V1/V2 comparison this repo shipped first cannot see a whole class of
// regression. V2 is routinely several times faster than V1, so a case can lose
// half its speed and still report "V2 faster"; case thresholds are calibrated at
// roughly twice the worst observed value, so they only fire past a ~2.4x
// regression. Measured against release 30520608995, 15 cases were more than 20%
// slower than the released build while still beating V1 — every one of them
// invisible to both existing gates.
//
// Keep this file pure. Teable and GitHub I/O belong in
// `resolve-release-baseline.mjs`; rendering belongs in
// `perf-run-summary-model.mjs`.

import { primaryMetricValue } from "./perf-artifact-read-model.mjs";

// Run-to-run noise on shared CI runners is large: across two consecutive full
// runs the mean absolute per-case change was 17.4%, and V1 — whose code barely
// moves between runs — still drifts past 20% on 42 of 263 cases. A ratio gate
// alone therefore cannot separate signal from drift, which is why the summary
// renders V1 beside V2 as a control column instead of hiding the noise.
export const DEFAULT_REGRESSION_RATIO = 1.2;

// Exclusive bands, widest first. The counts carry the signal that a flat list
// cannot: at >2x the released build V2 had 9 cases and V1 only 2, so that band
// is real; at >20% it was 27 against 36, which is drift.
export const REGRESSION_TIERS = [
  { key: "severe", minRatio: 2, label: ">2x" },
  { key: "major", minRatio: 1.5, label: ">50%" },
  { key: "minor", minRatio: 1.2, label: ">20%" },
];

export const baselineKey = (caseId, engine) => `${caseId}::${engine}`;

const positiveNumber = (value) =>
  Number.isFinite(value) && value > 0 ? value : undefined;

// Only a passing case measured what it set out to measure. A failure timed how
// long the failure took, which is neither a regression nor a baseline — the run
// already reports it as a failure, and comparing it would report it twice under
// the wrong name.
const measuredValue = (payload) => {
  if (payload?.result !== "pass") {
    return undefined;
  }
  return positiveNumber(primaryMetricValue(payload));
};

const measuredMetric = (payload) =>
  Array.isArray(payload?.thresholds)
    ? payload.thresholds[0]?.metric
    : undefined;

// A case whose primary metric was renamed is not comparable across the rename:
// the numbers would be two different measurements sharing a case id. Treat a
// metric mismatch as "no baseline" so the case surfaces in the missing count
// rather than as a fabricated regression.
const baselineEntry = (baseline, caseId, engine, metric) => {
  const entry = baseline?.values?.[baselineKey(caseId, engine)];
  if (!entry) {
    return undefined;
  }
  if (metric && entry.metric && entry.metric !== metric) {
    return undefined;
  }
  return positiveNumber(entry.value) === undefined ? undefined : entry;
};

export const tierForRatio = (
  ratio,
  regressionRatio = DEFAULT_REGRESSION_RATIO,
) => {
  if (!Number.isFinite(ratio)) {
    return undefined;
  }
  for (const tier of REGRESSION_TIERS) {
    if (ratio >= Math.max(tier.minRatio, regressionRatio)) {
      return tier.key;
    }
  }
  return undefined;
};

const emptyTierCounts = () => ({ severe: 0, major: 0, minor: 0 });

const countTier = (counts, tier) => {
  if (tier) {
    counts[tier] += 1;
  }
  return counts;
};

const groupPayloadsByCase = (payloads) => {
  const grouped = new Map();
  for (const payload of payloads ?? []) {
    if (!payload?.caseId || payload.engine === "seed") {
      continue;
    }
    const entry = grouped.get(payload.caseId) ?? {};
    entry[payload.engine] = payload;
    grouped.set(payload.caseId, entry);
  }
  return grouped;
};

const compareRows = (left, right) => {
  const leftRatio = Number.isFinite(left.releaseRatio) ? left.releaseRatio : 0;
  const rightRatio = Number.isFinite(right.releaseRatio)
    ? right.releaseRatio
    : 0;
  if (leftRatio !== rightRatio) {
    return rightRatio - leftRatio;
  }
  return left.caseId.localeCompare(right.caseId);
};

/**
 * Compare a full run's payloads against the released build's stored results.
 *
 * `baseline` is the artifact written by `resolve-release-baseline.mjs`:
 * `{ commit, release, runId, runAttempt, runUrl, values: { "case::engine": { value, metric } } }`.
 * A missing or empty baseline yields `available: false`, which the summary must
 * render as "no baseline" — never as zero regressions, which reads as a pass.
 */
export const buildReleaseComparison = ({
  payloads = [],
  baseline,
  regressionRatio = DEFAULT_REGRESSION_RATIO,
} = {}) => {
  if (!Number.isFinite(regressionRatio) || regressionRatio <= 1) {
    throw new Error(
      `regressionRatio must be greater than 1, received ${regressionRatio}`,
    );
  }

  const grouped = groupPayloadsByCase(payloads);
  const hasBaseline =
    Boolean(baseline?.runId) && Object.keys(baseline?.values ?? {}).length > 0;
  const rows = [];
  const v2Tiers = emptyTierCounts();
  const v1Tiers = emptyTierCounts();
  let missingBaseline = 0;
  let faster = 0;
  let residentSlower = 0;

  for (const [caseId, engines] of grouped) {
    const v1Payload = engines.v1;
    const v2Payload = engines.v2;
    const v1Value = measuredValue(v1Payload);
    const v2Value = measuredValue(v2Payload);
    const v2Baseline = hasBaseline
      ? baselineEntry(baseline, caseId, "v2", measuredMetric(v2Payload))
      : undefined;
    const v1Baseline = hasBaseline
      ? baselineEntry(baseline, caseId, "v1", measuredMetric(v1Payload))
      : undefined;

    const releaseRatio =
      v2Value !== undefined && v2Baseline
        ? v2Value / v2Baseline.value
        : undefined;
    const v1ReleaseRatio =
      v1Value !== undefined && v1Baseline
        ? v1Value / v1Baseline.value
        : undefined;
    // V2 beats V1 whenever it takes less time. Reported as "how many times
    // faster" so the row reads the same way the V1/V2 summary always has.
    const engineRatio =
      v1Value !== undefined && v2Value !== undefined
        ? v1Value / v2Value
        : undefined;
    const tier = tierForRatio(releaseRatio, regressionRatio);
    const v1Tier = tierForRatio(v1ReleaseRatio, regressionRatio);
    const slowerThanV1 = engineRatio !== undefined && engineRatio < 1;

    countTier(v2Tiers, tier);
    countTier(v1Tiers, v1Tier);

    if (v2Value !== undefined && !v2Baseline) {
      missingBaseline += 1;
    }
    if (releaseRatio !== undefined && releaseRatio <= 1 / regressionRatio) {
      faster += 1;
    }
    if (!tier && slowerThanV1) {
      residentSlower += 1;
    }

    rows.push({
      caseId,
      v1Value,
      v2Value,
      v1Skipped: v1Payload?.result === "skipped",
      v2Skipped: v2Payload?.result === "skipped",
      baselineV2: v2Baseline?.value,
      baselineV1: v1Baseline?.value,
      releaseRatio,
      v1ReleaseRatio,
      engineRatio,
      tier,
      v1Tier,
      slowerThanV1,
      // The regression the old report could not see: measurably slower than the
      // released build, yet still ahead of V1, so neither the engine comparison
      // nor the threshold fires.
      onlyReleaseVisible:
        Boolean(tier) && engineRatio !== undefined && !slowerThanV1,
      hasBaseline: Boolean(v2Baseline),
      thresholdFailed: [v1Payload, v2Payload]
        .filter(Boolean)
        .some((payload) =>
          Array.isArray(payload.thresholds) && payload.thresholds.length > 0
            ? payload.thresholds.some((threshold) => threshold.passed === false)
            : payload.result === "fail",
        ),
    });
  }

  rows.sort(compareRows);

  const regressions = rows.filter((row) => row.tier);

  return {
    available: hasBaseline,
    baseline: hasBaseline
      ? {
          commit: baseline.commit,
          release: baseline.release,
          runId: baseline.runId,
          runAttempt: baseline.runAttempt,
          runUrl: baseline.runUrl,
          finishedAt: baseline.finishedAt,
        }
      : undefined,
    regressionRatio,
    rows,
    regressions,
    counts: {
      // Cases that actually produced a ratio. A case with a stored baseline but
      // no usable measurement this run was not compared, and counting it would
      // overstate the coverage the other numbers are read against.
      compared: rows.filter((row) => Number.isFinite(row.releaseRatio)).length,
      slower: regressions.length,
      faster,
      missingBaseline,
      residentSlower,
      onlyReleaseVisible: regressions.filter((row) => row.onlyReleaseVisible)
        .length,
    },
    tiers: { v2: v2Tiers, v1: v1Tiers },
  };
};
