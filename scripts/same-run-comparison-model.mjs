// Same-run layer on the card people actually read.
//
// MongoDB (ICPE 2020) replaced "did this version move more than 10% versus
// that version" with "which software changes altered performance" — change
// point detection on each case's own series. The 1.2x vs-one-release-run
// gate is the 10% comparison: it fires on ~30% of cases from noise. This
// module is the same-day half of that replacement.
//
// E-Divisive cannot confirm the newest commit until several more runs land
// (`DEFAULT_MIN_SEGMENT = 4` in `change-point-model.mjs`). That confirmed
// layer stays on the nightly second card. What this run can say today is
// the calibrated pairwise check in `fast-check-model.mjs`: this measurement
// versus the case's own recent level, against that case's own 0.99 quantile
// of historical deviations. It says "look at this", not "this is a
// regression".
//
// Keep this file pure. Teable I/O belongs in `resolve-same-run-history.mjs`;
// rendering belongs in `perf-run-summary-model.mjs`.

import { carriesDrift } from "./corpus-metric-model.mjs";
import { checkRun } from "./fast-check-model.mjs";
import {
  groupPayloadsByCase,
  measuredValue,
} from "./full-run-comparison-model.mjs";
import { measurabilityOf } from "./measurability-model.mjs";

// Window 12 + minHistory 40 deviations, plus slack so a page of repeats of
// the same run does not starve the quantile.
export const SAME_RUN_HISTORY_POINTS = 60;
export const SAME_RUN_STRICT_MIN_POINTS = 52;

export const SAME_RUN_NOTE =
  "相对该用例自己近 12 次中位，过其历史偏差 0.99 分位才列为候选。不是和某一次线上比，也不是已确认代码回归。不可测或历史不足的不判。";

const measuredMetric = (payload) =>
  Array.isArray(payload?.thresholds)
    ? payload.thresholds[0]?.metric
    : undefined;

const bump = (skipped, reason) => {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
};

/**
 * Turn a flat Performance Track read into chronological per-case series.
 *
 * Newest-first SQL is fine; the check reads oldest-first. Caps at
 * `SAME_RUN_HISTORY_POINTS` most recent values so a case measured many times
 * a day cannot drown the window.
 */
export const historyByCaseFromRows = (
  rows = [],
  { limit = SAME_RUN_HISTORY_POINTS } = {},
) => {
  const grouped = new Map();
  for (const row of rows) {
    const caseId = row.caseId;
    const value = Number(row.value);
    if (!caseId || !(value > 0)) {
      continue;
    }
    const startedAt = Date.parse(row.startedAt ?? "");
    const list = grouped.get(caseId) ?? [];
    list.push({
      value,
      startedAt: Number.isFinite(startedAt) ? startedAt : 0,
    });
    grouped.set(caseId, list);
  }

  const historyByCase = {};
  for (const [caseId, list] of grouped) {
    historyByCase[caseId] = list
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(-limit)
      .map((entry) => entry.value);
  }
  return historyByCase;
};

const parsedMeasurement = (value) => {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/**
 * Prefer rows with the same explicit measurement contract and environment
 * class. During the schema rollout there are not yet 52 strict points (12 for
 * the recent level plus 40 deviations for q99), so the calibrated legacy
 * history remains available and is labelled as a fallback rather than quietly
 * presented as contract-safe.
 */
export const comparableHistoryByCaseFromRows = (
  rows = [],
  {
    identityByCase = {},
    limit = SAME_RUN_HISTORY_POINTS,
    strictMinPoints = SAME_RUN_STRICT_MIN_POINTS,
    strictRows,
  } = {},
) => {
  const legacy = historyByCaseFromRows(rows, { limit });
  const compatibleRows = (strictRows ?? rows).filter((row) => {
    const expected = identityByCase[row.caseId];
    if (!expected?.contractId) return false;
    const measurement = parsedMeasurement(row.measurement);
    if (measurement?.contract?.id !== expected.contractId) return false;
    return (
      !expected.environmentClass ||
      measurement?.environment?.class === expected.environmentClass
    );
  });
  const strict = historyByCaseFromRows(compatibleRows, { limit });
  const valuesByCase = {};
  const compatibilityByCase = {};

  for (const caseId of new Set([
    ...Object.keys(legacy),
    ...Object.keys(strict),
  ])) {
    const values = legacy[caseId] ?? [];
    const strictValues = strict[caseId] ?? [];
    if (strictValues.length >= strictMinPoints) {
      valuesByCase[caseId] = strictValues;
      compatibilityByCase[caseId] = {
        mode: "strict",
        strictPoints: strictValues.length,
        legacyPoints: values.length,
      };
      continue;
    }
    valuesByCase[caseId] = values;
    compatibilityByCase[caseId] = {
      mode: identityByCase[caseId]?.contractId ? "legacy-fallback" : "legacy",
      strictPoints: strictValues.length,
      legacyPoints: values.length,
    };
  }

  return { valuesByCase, compatibilityByCase };
};

/**
 * Judge this run's V2 measurements against each case's own recent history.
 *
 * `historyByCase` omitted (`null` / `undefined`) means the history was not
 * read — not the same as a successful read that found nothing, which is `{}`.
 * A case nobody could judge is counted under `skipped`, never folded into
 * "looked fine".
 */
export const buildSameRunComparison = ({
  payloads = [],
  historyByCase,
  historyCompatibilityByCase = {},
} = {}) => {
  if (historyByCase == null) {
    return {
      available: false,
      flagged: [],
      judged: 0,
      skipped: {},
      counts: { judged: 0, flagged: 0, skipped: 0 },
      compatibility: { strict: 0, legacyFallback: 0, legacy: 0 },
    };
  }

  const grouped = groupPayloadsByCase(payloads);
  const fastCases = {};
  const skipped = {};

  for (const [caseId, engines] of grouped) {
    const latest = measuredValue(engines.v2);
    if (latest === undefined) {
      continue;
    }

    const metric = measuredMetric(engines.v2);
    if (metric && !carriesDrift(metric)) {
      bump(skipped, "differential");
      continue;
    }

    const history = Array.isArray(historyByCase[caseId])
      ? historyByCase[caseId].filter((value) => value > 0)
      : [];
    if (history.length === 0) {
      bump(skipped, "no-history");
      continue;
    }

    const measurable = measurabilityOf(history);
    if (!measurable.measurable) {
      bump(skipped, measurable.reason);
      continue;
    }

    fastCases[caseId] = { history, latest };
  }

  const result = checkRun(fastCases);
  for (const [reason, count] of Object.entries(result.skipped ?? {})) {
    skipped[reason] = (skipped[reason] ?? 0) + count;
  }

  const flagged = result.flagged
    .map((row) => ({
      caseId: row.key,
      evidenceLevel: "anomaly_candidate",
      latest: fastCases[row.key].latest,
      level: row.level,
      ratio: row.ratio,
      thresholdRatio: row.thresholdRatio,
      deviation: row.deviation,
    }))
    .sort((left, right) => right.ratio - left.ratio);

  const skippedCount = Object.values(skipped).reduce(
    (sum, count) => sum + count,
    0,
  );
  const compatibility = { strict: 0, legacyFallback: 0, legacy: 0 };
  for (const caseId of Object.keys(fastCases)) {
    const mode = historyCompatibilityByCase[caseId]?.mode;
    if (mode === "strict") compatibility.strict += 1;
    else if (mode === "legacy-fallback") compatibility.legacyFallback += 1;
    else compatibility.legacy += 1;
  }

  return {
    available: true,
    flagged,
    judged: result.judged,
    skipped,
    compatibility,
    counts: {
      judged: result.judged,
      flagged: flagged.length,
      skipped: skippedCount,
    },
  };
};
