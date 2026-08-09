import assert from "node:assert/strict";
import { buildEngineComparison } from "./engine-comparison-model.mjs";

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
      : [{ metric, actual, max: actual * 4, passed: result !== "fail" }],
});

// Much narrower than the release comparison's 1.2x: V1 and V2 are two
// implementations measured in the same run, so there is no run-to-run noise to
// clear before "V2 lost" means something. The floor is only the tie the card
// prints — a row counted as 慢 while it rendered 持平 was the mixed-signal the
// split is meant to remove.
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
  ],
});
assert.equal(slower.available, true);
assert.deepEqual(slower.counts, {
  compared: 4,
  slower: 2,
  faster: 2,
  pending: 0,
});
assert.deepEqual(
  slower.regressions.map((row) => row.caseId),
  ["duplicate-table/50k-20f", "lookup/edge"],
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
  ["a/severe", "b/mild"],
);

assert.deepEqual(buildEngineComparison().rows, []);

console.log("engine comparison model checks passed.");
