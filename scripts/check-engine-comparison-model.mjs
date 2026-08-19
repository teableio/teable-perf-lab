import assert from "node:assert/strict";
import {
  ENGINE_MIN_DELTA_MS,
  ENGINE_NOISE_RATIO,
  buildEngineComparison,
  engineComparisonBasis,
  engineSlowdown,
  median,
  pairEngineHistoryRows,
} from "./engine-comparison-model.mjs";
import { buildEnginePairHistorySql } from "./resolve-engine-pair-history.mjs";

const payload = ({
  caseId,
  engine,
  metric = "opMs",
  actual,
  result = "pass",
  metrics,
}) => ({
  caseId,
  engine,
  result,
  metrics,
  thresholds:
    actual === undefined
      ? []
      : [{ metric, actual, max: actual * 4, passed: result !== "fail" }],
});

// Same 1.2x band as the release gate: V1 and V2 are different hosts, not a
// same-machine A/B, so a 5% gap is runner noise. The 50ms floor is the other
// half — smoke/auth-user at 7ms vs 10ms is 1.4x and still not a finding.
assert.equal(ENGINE_NOISE_RATIO, 1.2);
assert.equal(ENGINE_MIN_DELTA_MS, 50);
const slower = buildEngineComparison({
  payloads: [
    payload({
      caseId: "duplicate-table/50k-20f",
      engine: "v1",
      actual: 20_700,
    }),
    payload({
      caseId: "duplicate-table/50k-20f",
      engine: "v2",
      actual: 27_722,
    }),
    payload({ caseId: "formula/fast", engine: "v1", actual: 1_000 }),
    payload({ caseId: "formula/fast", engine: "v2", actual: 500 }),
    payload({ caseId: "lookup/tie", engine: "v1", actual: 1_000 }),
    payload({ caseId: "lookup/tie", engine: "v2", actual: 1_010 }),
    payload({ caseId: "lookup/edge", engine: "v1", actual: 1_000 }),
    payload({ caseId: "lookup/edge", engine: "v2", actual: 1_050 }),
    payload({ caseId: "smoke/auth-user", engine: "v1", actual: 7 }),
    payload({ caseId: "smoke/auth-user", engine: "v2", actual: 10 }),
    payload({ caseId: "lookup/band", engine: "v1", actual: 1_000 }),
    payload({ caseId: "lookup/band", engine: "v2", actual: 1_200 }),
  ],
});
assert.equal(slower.available, true);
assert.deepEqual(slower.counts, {
  compared: 6,
  slower: 2,
  faster: 4,
  pending: 0,
});
assert.deepEqual(
  slower.regressions.map((row) => row.caseId),
  ["duplicate-table/50k-20f", "lookup/band"],
);
assert.equal(
  slower.rows.find((row) => row.caseId === "smoke/auth-user").status,
  "ok",
);
// V2 divided by V1, so above 1 is slower — the same direction the release
// comparison prints, which the old V1/V2 ratio inverted.
assert.ok(Math.abs(slower.regressions[0].ratio - 1.339) < 0.01);

// A case V1 never ran cannot be compared. It is pending, not passing.
const skipped = buildEngineComparison({
  payloads: [
    payload({ caseId: "import-base/v2-only", engine: "v1", result: "skipped" }),
    payload({ caseId: "import-base/v2-only", engine: "v2", actual: 12_660 }),
  ],
});
assert.deepEqual(skipped.counts, {
  compared: 0,
  slower: 0,
  faster: 0,
  pending: 1,
});
assert.equal(skipped.pending[0].v1Result, "skipped");
assert.equal(skipped.pending[0].v1Value, undefined);

// A failure timed a failure, not the operation. The run reports it as a failure
// in the release panel; here it is simply not comparable.
const failed = buildEngineComparison({
  payloads: [
    payload({ caseId: "field/fail", engine: "v1", actual: 100 }),
    payload({
      caseId: "field/fail",
      engine: "v2",
      actual: 200,
      result: "fail",
    }),
  ],
});
assert.equal(failed.counts.slower, 0);
assert.equal(failed.counts.pending, 1);
// "skip" and "fail" are different things to the reader, so the raw result
// travels with the row.
assert.equal(failed.pending[0].v2Result, "fail");

// No V1 leg at all means there is nothing to report. The card and the summary
// section both drop out on this flag, which is how the V1 report stops on its
// own once the V1 leg is retired.
const v2Only = buildEngineComparison({
  payloads: [payload({ caseId: "smoke/auth-user", engine: "v2", actual: 8 })],
});
assert.equal(v2Only.available, false);
assert.equal(v2Only.counts.pending, 1);

// Seed payloads are bookkeeping, not measurements.
assert.equal(
  buildEngineComparison({
    payloads: [payload({ caseId: "seed/shard-1", engine: "seed", actual: 10 })],
  }).rows.length,
  0,
);

// Worst first, ties by case id, so the ten-row preview carries the widest gaps.
const ordered = buildEngineComparison({
  payloads: [
    payload({ caseId: "b/mild", engine: "v1", actual: 1_000 }),
    payload({ caseId: "b/mild", engine: "v2", actual: 1_100 }),
    payload({ caseId: "a/severe", engine: "v1", actual: 1_000 }),
    payload({ caseId: "a/severe", engine: "v2", actual: 3_000 }),
  ],
});
assert.deepEqual(
  ordered.regressions.map((row) => row.caseId),
  ["a/severe"],
);

assert.deepEqual(buildEngineComparison().rows, []);

// Hybrid first-row primaries mix a write with a 100ms poll. Ranking that poll
// as an engine loss files scheduling grain as a 1.8x regression. The write is
// still comparable, so both payloads carrying `linkWriteMs` are judged there.
assert.deepEqual(
  engineComparisonBasis(
    payload({
      caseId: "lookup/dual-link",
      engine: "v2",
      metric: "lookupPropagationMs",
      actual: 107,
      metrics: { linkWriteMs: 324, lookupPropagationMs: 107 },
    }),
  ),
  { metric: "linkWriteMs", value: 324, kind: "write" },
);

const hybrid = buildEngineComparison({
  payloads: [
    payload({
      caseId: "lookup/dual-link-computed-first-link-1of4k-get-records",
      engine: "v1",
      metric: "lookupPropagationMs",
      actual: 60,
      metrics: { linkWriteMs: 465, lookupPropagationMs: 60 },
    }),
    payload({
      caseId: "lookup/dual-link-computed-first-link-1of4k-get-records",
      engine: "v2",
      metric: "lookupPropagationMs",
      actual: 107,
      metrics: { linkWriteMs: 324, lookupPropagationMs: 107 },
    }),
    payload({
      caseId: "lookup/foreign-select-flip-1of40-fanout100-4k",
      engine: "v1",
      metric: "firstOrderReadyTotalMs",
      actual: 402,
      metrics: { sourceWriteMs: 365, firstOrderReadyTotalMs: 402 },
    }),
    payload({
      caseId: "lookup/foreign-select-flip-1of40-fanout100-4k",
      engine: "v2",
      metric: "firstOrderReadyTotalMs",
      actual: 517,
      metrics: { sourceWriteMs: 156, firstOrderReadyTotalMs: 517 },
    }),
    payload({
      caseId: "lookup/customer-update-user-create-order-4k-depth5",
      engine: "v1",
      metric: "customerFlowReadyTotalMs",
      actual: 876,
      metrics: { orderWriteMs: 421, customerFlowReadyTotalMs: 876 },
    }),
    payload({
      caseId: "lookup/customer-update-user-create-order-4k-depth5",
      engine: "v2",
      metric: "customerFlowReadyTotalMs",
      actual: 1161,
      metrics: { orderWriteMs: 280, customerFlowReadyTotalMs: 1161 },
    }),
  ],
});
assert.equal(hybrid.counts.slower, 0);
assert.equal(hybrid.counts.faster, 3);
assert.equal(hybrid.rows[0].comparisonKind, "write");
assert.equal(hybrid.rows[0].comparedMetric, "linkWriteMs");

// A payload that never recorded the write metric still compares the primary.
const missingWrite = buildEngineComparison({
  payloads: [
    payload({
      caseId: "lookup/dual-link-computed-first-link-1of4k-get-record",
      engine: "v1",
      metric: "lookupPropagationMs",
      actual: 550,
    }),
    payload({
      caseId: "lookup/dual-link-computed-first-link-1of4k-get-record",
      engine: "v2",
      metric: "lookupPropagationMs",
      actual: 910,
    }),
  ],
});
assert.equal(missingWrite.counts.slower, 1);
assert.equal(missingWrite.regressions[0].comparisonKind, "primary");
assert.ok(Math.abs(missingWrite.regressions[0].ratio - 910 / 550) < 0.01);

assert.equal(median([0.9, 0.92, 0.71, 1.96, 0.68]), 0.9);

assert.deepEqual(
  engineSlowdown({
    v1Value: 7,
    v2Value: 10,
    ratio: 10 / 7,
  }),
  { slower: false, recentMedianRatio: undefined },
);

assert.equal(
  engineSlowdown({
    v1Value: 7_394,
    v2Value: 14_464,
    ratio: 14_464 / 7_394,
    recentRatios: [0.92, 0.71, 0.68, 0.87, 0.86],
  }).slower,
  true,
);

assert.equal(
  engineSlowdown({
    v1Value: 20_700,
    v2Value: 27_722,
    ratio: 27_722 / 20_700,
    recentRatios: [1.3, 1.32, 1.28, 1.35, 1.31],
  }).slower,
  false,
);

const paired = pairEngineHistoryRows(
  [
    {
      caseId: "record-read/range",
      engine: "v1",
      runId: "1",
      value: 9_000,
      startedAt: "2026-08-18T14:00:00.000Z",
    },
    {
      caseId: "record-read/range",
      engine: "v2",
      runId: "1",
      value: 6_700,
      startedAt: "2026-08-18T14:00:01.000Z",
    },
    {
      caseId: "record-read/range",
      engine: "v1",
      runId: "2",
      value: 7_400,
      startedAt: "2026-08-18T18:00:00.000Z",
    },
    {
      caseId: "record-read/range",
      engine: "v2",
      runId: "now",
      value: 14_000,
      startedAt: "2026-08-18T18:00:01.000Z",
    },
  ],
  { currentRunId: "now" },
);
assert.equal(paired["record-read/range"].length, 1);
assert.ok(Math.abs(paired["record-read/range"][0] - 6_700 / 9_000) < 0.01);

const typical = buildEngineComparison({
  payloads: [
    payload({
      caseId: "duplicate-table/50k-20f",
      engine: "v1",
      actual: 20_700,
    }),
    payload({
      caseId: "duplicate-table/50k-20f",
      engine: "v2",
      actual: 27_722,
    }),
  ],
  recentRatiosByCase: {
    "duplicate-table/50k-20f": [1.3, 1.32, 1.28, 1.35, 1.31],
  },
});
assert.equal(typical.counts.slower, 0);
assert.ok(
  Math.abs(typical.rows[0].recentMedianRatio - 1.31) < 0.01,
);

assert.equal(buildEnginePairHistorySql({ caseIds: [] }), undefined);
const historySql = buildEnginePairHistorySql({
  caseIds: ["smoke/auth-user", "record-read/range"],
  currentRunId: "32169630715",
});
assert.match(historySql, /"Case_ID" IN \('smoke\/auth-user', 'record-read\/range'\)/);
assert.match(historySql, /"Run_ID" <> '32169630715'/);
assert.match(historySql, /"Status" = 'pass'/);
assert.equal(
  buildEnginePairHistorySql({ caseIds: ["o'reilly"] }).includes("'o''reilly'"),
  true,
);

console.log("engine comparison model checks passed.");
