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
// Teable I/O for the recent-pair lookup belongs in
// `resolve-engine-pair-history.mjs`.

import {
  groupPayloadsByCase,
  measuredValue,
} from "./full-run-comparison-model.mjs";

// V1 and V2 are not a same-host A/B. They run as separate matrix jobs, so they
// carry at least the run-to-run noise the release gate already measured (~17%
// mean, 1.2x band). A 1.05x floor on one pairing filed 7ms vs 10ms as 慢1.5x
// and listed every 1.1x scan as a regression.
//
// Three gates, all required:
//   1. ratio at least the release noise band
//   2. an absolute delta, so millisecond cases cannot ratio their way onto
//      the card
//   3. when enough recent pairs exist, this ratio must also sit above that
//      case's own recent median — a case that is always 1.3x slower than V1
//      is not news, a case that is usually 0.9x and printed 2.0x tonight is
export const ENGINE_NOISE_RATIO = 1.2;
export const ENGINE_MIN_DELTA_MS = 50;
export const ENGINE_TREND_RATIO = 1.2;
export const ENGINE_TREND_MIN_PAIRS = 5;
export const ENGINE_HISTORY_LOOKBACK = 12;

export const ENGINE_TREND_NOTE =
  "相对近期同用例 V1/V2 配对。差值不足 50ms、未过 1.2x、或未明显高于近期中位的不列出。";

const positiveNumber = (value) =>
  Number.isFinite(value) && value > 0 ? value : undefined;

export const median = (values) => {
  const sorted = [...values]
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return undefined;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

/**
 * Pair historical V1/V2 rows by run id.
 *
 * `rows` is the flat Performance Track read: one engine per row. A run that
 * only produced one engine cannot form a ratio and is dropped. Newest pairs
 * first, capped at `ENGINE_HISTORY_LOOKBACK` per case.
 */
export const pairEngineHistoryRows = (rows = [], { currentRunId } = {}) => {
  const byCase = new Map();
  for (const row of rows) {
    const caseId = row.caseId;
    const runId = row.runId === undefined ? undefined : String(row.runId);
    const engine = row.engine;
    const value = positiveNumber(row.value);
    if (!caseId || !runId || !engine || value === undefined) {
      continue;
    }
    if (currentRunId && runId === String(currentRunId)) {
      continue;
    }
    const runs = byCase.get(caseId) ?? new Map();
    const pair = runs.get(runId) ?? { runId, startedAt: 0 };
    pair[engine] = value;
    const startedAt = Date.parse(row.startedAt ?? "");
    if (Number.isFinite(startedAt)) {
      pair.startedAt = Math.max(pair.startedAt, startedAt);
    }
    runs.set(runId, pair);
    byCase.set(caseId, runs);
  }

  const ratiosByCase = {};
  for (const [caseId, runs] of byCase) {
    const pairs = [...runs.values()]
      .filter(
        (pair) =>
          positiveNumber(pair.v1) !== undefined &&
          positiveNumber(pair.v2) !== undefined,
      )
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, ENGINE_HISTORY_LOOKBACK)
      .map((pair) => pair.v2 / pair.v1);
    if (pairs.length > 0) {
      ratiosByCase[caseId] = pairs;
    }
  }
  return ratiosByCase;
};

export const engineSlowdown = ({
  v1Value,
  v2Value,
  ratio,
  recentRatios,
} = {}) => {
  if (ratio === undefined) {
    return { slower: false, recentMedianRatio: undefined };
  }
  const recentMedianRatio =
    Array.isArray(recentRatios) && recentRatios.length >= ENGINE_TREND_MIN_PAIRS
      ? median(recentRatios)
      : undefined;
  const delta = v2Value - v1Value;
  const crossesFloor =
    ratio >= ENGINE_NOISE_RATIO && delta >= ENGINE_MIN_DELTA_MS;
  const crossesTrend =
    recentMedianRatio === undefined ||
    ratio >= recentMedianRatio * ENGINE_TREND_RATIO;
  return {
    slower: crossesFloor && crossesTrend,
    recentMedianRatio,
  };
};

const metricFromPayload = (payload) =>
  Array.isArray(payload?.thresholds)
    ? payload.thresholds[0]?.metric
    : undefined;

// Hybrid first-row / read-after-write primaries mix the write with a 100ms
// poll until the customer API exposes the new value. V1 finishes that work
// inside the request, so the same primary on V2 is mostly "did the next poll
// land". Ranking those rows as engine regressions files a scheduling grain as
// a 1.8x loss.
//
// The write itself is still comparable across engines. Prefer it when both
// payloads recorded the same write metric; otherwise keep the primary. The
// customer-visible empty window stays the case primary and the release gate.
export const ENGINE_WRITE_METRICS_BY_PRIMARY = {
  lookupPropagationMs: "linkWriteMs",
  firstOrderReadyTotalMs: "sourceWriteMs",
  customerFlowReadyTotalMs: "orderWriteMs",
};

export const engineComparisonBasis = (payload) => {
  const primaryMetric = metricFromPayload(payload);
  const writeMetric = ENGINE_WRITE_METRICS_BY_PRIMARY[primaryMetric];
  const writeValue = writeMetric
    ? positiveNumber(payload?.metrics?.[writeMetric])
    : undefined;
  if (writeMetric && writeValue !== undefined) {
    return { metric: writeMetric, value: writeValue, kind: "write" };
  }
  const primaryValue = measuredValue(payload);
  return {
    metric: primaryMetric,
    value: primaryValue,
    kind: primaryValue === undefined ? undefined : "primary",
  };
};

const pairedEngineValue = (leftPayload, rightPayload) => {
  const left = engineComparisonBasis(leftPayload);
  const right = engineComparisonBasis(rightPayload);
  if (left.kind === "write" && right.kind === "write") {
    return { left, right, kind: "write" };
  }
  return {
    left: {
      metric: metricFromPayload(leftPayload),
      value: measuredValue(leftPayload),
      kind: measuredValue(leftPayload) === undefined ? undefined : "primary",
    },
    right: {
      metric: metricFromPayload(rightPayload),
      value: measuredValue(rightPayload),
      kind: measuredValue(rightPayload) === undefined ? undefined : "primary",
    },
    kind: "primary",
  };
};

// Worst first, ties by case id, so the preview always carries the widest gaps.
const compareBySlowness = (left, right) => {
  if (left.ratio !== right.ratio) {
    return right.ratio - left.ratio;
  }
  return left.caseId.localeCompare(right.caseId);
};

const recentRatiosFor = (recentRatiosByCase, caseId) => {
  if (!recentRatiosByCase) {
    return undefined;
  }
  if (recentRatiosByCase instanceof Map) {
    return recentRatiosByCase.get(caseId);
  }
  return recentRatiosByCase[caseId];
};

/**
 * Compare each case's V2 measurement against its own V1 measurement.
 *
 * `ratio` is V2 divided by V1, so above 1 is slower — the same direction as
 * every ratio the release comparison prints.
 *
 * `recentRatiosByCase` is optional. When present and a case has at least
 * `ENGINE_TREND_MIN_PAIRS` recent ratios, that case is only 慢 if tonight is
 * also worse than its own recent median. Missing history falls back to the
 * 1.2x / 50ms floors rather than going silent.
 *
 * `available: false` means the run has no V1 leg at all, in which case there is
 * nothing to report and the caller should send nothing rather than a card of
 * "no V1 baseline" rows.
 */
export const buildEngineComparison = ({
  payloads = [],
  recentRatiosByCase,
} = {}) => {
  const rows = [];
  let compared = 0;
  let ranV1 = false;

  for (const [caseId, engines] of groupPayloadsByCase(payloads)) {
    const v1Payload = engines.v1;
    const v2Payload = engines.v2;
    if (v1Payload) {
      ranV1 = true;
    }
    const pair = pairedEngineValue(v1Payload, v2Payload);
    const v1Value = pair.left.value;
    const v2Value = pair.right.value;
    const ratio =
      v1Value !== undefined && v2Value !== undefined
        ? v2Value / v1Value
        : undefined;
    if (ratio !== undefined) {
      compared += 1;
    }

    const verdict =
      ratio === undefined
        ? { slower: false, recentMedianRatio: undefined }
        : engineSlowdown({
            v1Value,
            v2Value,
            ratio,
            recentRatios: recentRatiosFor(recentRatiosByCase, caseId),
          });

    rows.push({
      caseId,
      v1Value,
      v2Value,
      comparedMetric: pair.left.metric ?? pair.right.metric,
      comparisonKind: ratio === undefined ? undefined : pair.kind,
      // The raw results, so the renderer can tell "V1 never ran this case" from
      // "V1 ran it and failed" — both leave `v1Value` undefined, and printing
      // "skip" for a failure was wrong in the report this replaces.
      v1Result: v1Payload?.result,
      v2Result: v2Payload?.result,
      ratio,
      recentMedianRatio: verdict.recentMedianRatio,
      // A case with no ratio is pending, not passing: nothing was compared. A
      // case that failed lands here too — it timed a failure, and the run
      // reports it as a failure in the release panel rather than twice.
      status: verdict.slower
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
