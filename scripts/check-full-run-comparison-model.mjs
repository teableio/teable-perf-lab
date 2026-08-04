import assert from "node:assert/strict";
import {
  baselineKey,
  buildReleaseComparison,
  DEFAULT_REGRESSION_RATIO,
  tierForRatio,
} from "./full-run-comparison-model.mjs";

const payload = ({
  caseId,
  engine,
  metric = "opMs",
  actual,
  result = "pass",
}) => ({
  caseId,
  engine,
  result,
  thresholds:
    actual === undefined
      ? []
      : [{ metric, actual, max: actual * 4, passed: true }],
});

const baselineOf = (entries) => ({
  commit: "e0dae6da17f302d3def079b095c5151af3b3581f",
  release: "release.2026-07-30T06-45-38Z.2429",
  runId: "30520608995",
  runAttempt: 1,
  runUrl:
    "https://github.com/teableio/teable-perf-lab/actions/runs/30520608995",
  values: Object.fromEntries(
    entries.map(([caseId, engine, value, metric = "opMs"]) => [
      baselineKey(caseId, engine),
      { value, metric },
    ]),
  ),
});

assert.equal(tierForRatio(2.4), "severe");
assert.equal(tierForRatio(1.6), "major");
assert.equal(tierForRatio(1.25), "minor");
assert.equal(tierForRatio(1.1), undefined);
assert.equal(tierForRatio(Number.NaN), undefined);
// A caller that widens the gate must not resurrect the narrower bands: at a 1.5
// gate a 1.25x case is not a regression at all.
assert.equal(tierForRatio(1.25, 1.5), undefined);

// The regression this whole comparison exists for: V2 lost more than half its
// speed against the released build yet still finishes ahead of V1, so neither
// the engine comparison nor the case threshold says anything.
const hidden = buildReleaseComparison({
  payloads: [
    payload({ caseId: "lookup/depth5", engine: "v1", actual: 2100 }),
    payload({ caseId: "lookup/depth5", engine: "v2", actual: 1544 }),
  ],
  baseline: baselineOf([
    ["lookup/depth5", "v1", 2000],
    ["lookup/depth5", "v2", 321],
  ]),
});
const [hiddenRow] = hidden.rows;
assert.equal(hidden.available, true);
assert.equal(hiddenRow.tier, "severe");
assert.equal(hiddenRow.slowerThanV1, false);
assert.equal(hiddenRow.onlyReleaseVisible, true);
assert.ok(Math.abs(hiddenRow.releaseRatio - 4.81) < 0.01);
assert.ok(Math.abs(hiddenRow.engineRatio - 1.36) < 0.01);
assert.equal(hidden.counts.onlyReleaseVisible, 1);
assert.equal(hidden.counts.slower, 1);
assert.equal(hidden.tiers.v2.severe, 1);
// V1 moved 2000 → 2100, inside the gate, so the control column stays empty and
// the regression reads as engine-side rather than environmental.
assert.equal(hidden.tiers.v1.severe, 0);
assert.equal(hidden.tiers.v1.minor, 0);

// V1 drifting by the same amount is the environment, not the engine. Both
// columns must count it so the reader can tell the two apart.
const drift = buildReleaseComparison({
  payloads: [
    payload({ caseId: "record-read/pages", engine: "v1", actual: 1300 }),
    payload({ caseId: "record-read/pages", engine: "v2", actual: 1300 }),
  ],
  baseline: baselineOf([
    ["record-read/pages", "v1", 1000],
    ["record-read/pages", "v2", 1000],
  ]),
});
assert.equal(drift.tiers.v2.minor, 1);
assert.equal(drift.tiers.v1.minor, 1);

// A case V2 has always lost is not news. It must stay out of the regression
// count and land in the resident bucket instead.
const resident = buildReleaseComparison({
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
  baseline: baselineOf([
    ["duplicate-table/50k-20f", "v1", 20_000],
    ["duplicate-table/50k-20f", "v2", 27_000],
  ]),
});
assert.equal(resident.counts.slower, 0);
assert.equal(resident.counts.residentSlower, 1);
assert.equal(resident.rows[0].slowerThanV1, true);
assert.equal(resident.rows[0].onlyReleaseVisible, false);

// Renaming a case's primary metric makes the two numbers different
// measurements. Comparing them would invent a regression, so the case must fall
// through to "no baseline" instead.
const renamed = buildReleaseComparison({
  payloads: [
    payload({
      caseId: "field-convert/text",
      engine: "v2",
      metric: "convertRequestMs",
      actual: 5000,
    }),
  ],
  baseline: baselineOf([["field-convert/text", "v2", 1000, "convertMs"]]),
});
assert.equal(renamed.counts.slower, 0);
assert.equal(renamed.counts.missingBaseline, 1);
assert.equal(renamed.counts.compared, 0);
assert.equal(renamed.rows[0].hasBaseline, false);

// A skipped engine has no measurement, so it is neither a regression nor a
// missing baseline — it simply did not run.
const skipped = buildReleaseComparison({
  payloads: [
    payload({ caseId: "import-base/v2-only", engine: "v1", result: "skipped" }),
    payload({ caseId: "import-base/v2-only", engine: "v2", actual: 12_660 }),
  ],
  baseline: baselineOf([["import-base/v2-only", "v2", 6235]]),
});
assert.equal(skipped.counts.slower, 1);
assert.equal(skipped.counts.missingBaseline, 0);
assert.equal(skipped.rows[0].v1Skipped, true);
assert.equal(skipped.rows[0].engineRatio, undefined);
// With no V1 number there is nothing to claim about V1, so the row cannot be
// filed as "invisible to the V1/V2 comparison".
assert.equal(skipped.rows[0].onlyReleaseVisible, false);

// A failed case timed a failure, not the operation. It is already reported as a
// failure; counting it as a regression too would double-report it under the
// wrong name.
const failed = buildReleaseComparison({
  payloads: [
    payload({
      caseId: "field/fail",
      engine: "v2",
      actual: 200,
      result: "fail",
    }),
  ],
  baseline: baselineOf([["field/fail", "v2", 100]]),
});
assert.equal(failed.counts.slower, 0);
assert.equal(failed.counts.missingBaseline, 0);
assert.equal(failed.rows[0].v2Value, undefined);

// Faster than the released build by more than the gate.
const faster = buildReleaseComparison({
  payloads: [
    payload({ caseId: "record-create/bulk", engine: "v2", actual: 500 }),
  ],
  baseline: baselineOf([["record-create/bulk", "v2", 1000]]),
});
assert.equal(faster.counts.faster, 1);
assert.equal(faster.counts.slower, 0);

// No baseline at all must report `available: false`. Rendering zero
// regressions here would read as a clean run.
const noBaseline = buildReleaseComparison({
  payloads: [payload({ caseId: "smoke/auth-user", engine: "v2", actual: 8 })],
  baseline: undefined,
});
assert.equal(noBaseline.available, false);
assert.equal(noBaseline.counts.slower, 0);
assert.equal(noBaseline.counts.compared, 0);
assert.equal(noBaseline.baseline, undefined);
assert.deepEqual(
  buildReleaseComparison({ payloads: [], baseline: baselineOf([]) }).available,
  false,
);

// Worst first, ties by case id, so the ten-row preview always carries the
// largest regressions.
const ordered = buildReleaseComparison({
  payloads: [
    payload({ caseId: "b/mild", engine: "v2", actual: 1300 }),
    payload({ caseId: "a/severe", engine: "v2", actual: 3000 }),
    payload({ caseId: "c/none", engine: "v2", actual: 1000 }),
  ],
  baseline: baselineOf([
    ["b/mild", "v2", 1000],
    ["a/severe", "v2", 1000],
    ["c/none", "v2", 1000],
  ]),
});
assert.deepEqual(
  ordered.rows.map((row) => row.caseId),
  ["a/severe", "b/mild", "c/none"],
);
assert.deepEqual(
  ordered.regressions.map((row) => row.caseId),
  ["a/severe", "b/mild"],
);

// Seed payloads are bookkeeping, not measurements.
assert.equal(
  buildReleaseComparison({
    payloads: [payload({ caseId: "seed/shard-1", engine: "seed", actual: 10 })],
    baseline: baselineOf([["seed/shard-1", "seed", 5]]),
  }).rows.length,
  0,
);

assert.equal(DEFAULT_REGRESSION_RATIO, 1.2);
assert.throws(
  () =>
    buildReleaseComparison({
      payloads: [],
      baseline: undefined,
      regressionRatio: 1,
    }),
  /regressionRatio must be greater than 1/,
);

console.log("full-run comparison model checks passed.");
