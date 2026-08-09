import assert from "node:assert/strict";
import {
  buildComputeComparison,
  computeShape,
  computeValue,
  computeVerdict,
  DEFAULT_COMPUTE_BAND,
  readComputeBaseline,
} from "./compute-comparison-model.mjs";

// --- shape: read from what the engine did, not from the mode flag ------------

assert.equal(
  computeShape({ computeInlineMs: 375.95, computeTaskCount: 0 }),
  "inline",
);
assert.equal(
  computeShape({ computeAsyncMs: 836.29, computeTaskCount: 16 }),
  "outbox",
);
// A task whose execute span ended outside the window still means the outbox ran.
// Shape must not flip to inline because one number rounded to zero.
assert.equal(computeShape({ computeAsyncMs: 0, computeTaskCount: 3 }), "outbox");
assert.equal(computeShape({}), "none");
assert.equal(computeShape(undefined), "none");

// --- value ------------------------------------------------------------------

assert.equal(
  computeValue({ result: "pass", metrics: { computeMs: 836.29 } }),
  836.29,
);
// A failure's compute time is the compute of a failure.
assert.equal(
  computeValue({ result: "fail", metrics: { computeMs: 836.29 } }),
  undefined,
);
// A case that computed nothing has nothing to compare, not a zero to divide by.
assert.equal(
  computeValue({ result: "pass", metrics: { computeMs: 0 } }),
  undefined,
);

// --- baseline entries -------------------------------------------------------

assert.deepEqual(
  readComputeBaseline({ computeMs: 836.29, computeTaskCount: 16 }),
  { value: 836.29, shape: "outbox" },
);
// Every row measured before compute collection shipped.
assert.equal(readComputeBaseline({ opMs: 120 }), undefined);
assert.equal(readComputeBaseline(undefined), undefined);

// --- verdicts: the four stories the pair of ratios can tell ------------------

assert.equal(computeVerdict({ wallRatio: 1.5, computeRatio: 1.5 }), "regression");
assert.equal(computeVerdict({ wallRatio: 1.5, computeRatio: 1.0 }), "scheduling");
assert.equal(computeVerdict({ wallRatio: 0.5, computeRatio: 0.5 }), "optimized");
// The one this model exists for: the wall clock improved and the computing did
// not. Work relocated, not saved.
assert.equal(computeVerdict({ wallRatio: 0.5, computeRatio: 1.0 }), "deferred");
// Faster wall clock while compute got *worse* is still relocation, not a win.
assert.equal(computeVerdict({ wallRatio: 0.5, computeRatio: 1.6 }), "deferred");
assert.equal(computeVerdict({ wallRatio: 1.0, computeRatio: 1.5 }), "hidden-cost");
assert.equal(computeVerdict({ wallRatio: 1.0, computeRatio: 0.5 }), "hidden-gain");
assert.equal(computeVerdict({ wallRatio: 1.0, computeRatio: 1.0 }), "flat");
// An unknown half makes the pair unreadable; guessing is how a report starts
// claiming things it did not measure.
assert.equal(computeVerdict({ wallRatio: undefined, computeRatio: 1.5 }), undefined);
assert.equal(computeVerdict({ wallRatio: 1.5, computeRatio: undefined }), undefined);
assert.equal(computeVerdict({}), undefined);

// Band edges are inclusive on both sides, matching the wall-clock comparison.
assert.equal(computeVerdict({ wallRatio: 1.2, computeRatio: 1.2 }), "regression");
assert.equal(
  computeVerdict({ wallRatio: 1 / 1.2, computeRatio: 1 / 1.2 }),
  "optimized",
);
assert.equal(computeVerdict({ wallRatio: 1.19, computeRatio: 1.19 }), "flat");

// --- comparison -------------------------------------------------------------

const payloadOf = ({
  caseId,
  engine = "v2",
  result = "pass",
  computeMs,
  shapeMetrics = { computeTaskCount: 16 },
}) => ({
  caseId,
  engine,
  result,
  metrics: { computeMs, ...shapeMetrics },
});

const baselineOf = (entries) => ({
  commit: "e0dae6da17f302d3def079b095c5151af3b3581f",
  runId: "30520608995",
  runAttempt: 1,
  values: Object.fromEntries(
    entries.map(([caseId, value, shape = "outbox"]) => [
      `${caseId}::v2`,
      { value: value * 2, metric: "opMs", compute: { value, shape } },
    ]),
  ),
});

const releaseOf = (entries) => ({
  rows: entries.map(([caseId, releaseRatio]) => ({ caseId, releaseRatio })),
});

{
  // The headline case: wall clock halved, compute unchanged.
  const result = buildComputeComparison({
    payloads: [payloadOf({ caseId: "lookup/flip", computeMs: 840 })],
    baseline: baselineOf([["lookup/flip", 836]]),
    releaseComparison: releaseOf([["lookup/flip", 0.35]]),
  });

  assert.equal(result.available, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].verdict, "deferred");
  assert.equal(result.counts.deferred, 1);
  assert.equal(result.counts.compared, 1);
  assert.equal(result.deferred.length, 1);
}

{
  // A mode switch is not a regression. The same work costs 2.2x through the
  // outbox, so the comparison must refuse rather than report that as a number.
  const result = buildComputeComparison({
    payloads: [
      payloadOf({
        caseId: "lookup/flip",
        computeMs: 836,
        shapeMetrics: { computeTaskCount: 16 },
      }),
    ],
    baseline: baselineOf([["lookup/flip", 376, "inline"]]),
    releaseComparison: releaseOf([["lookup/flip", 0.35]]),
  });

  assert.equal(result.rows[0].shapeChanged, true);
  assert.equal(result.rows[0].computeRatio, undefined);
  assert.equal(result.rows[0].verdict, undefined);
  assert.equal(result.counts.shapeChanged, 1);
  assert.equal(result.counts.compared, 0);
  assert.equal(result.counts.regression, 0);
}

{
  // V1 emits none of these spans. A V1 row would report zero compute for a case
  // that computes plenty, which is a limit of the instrument, not a measurement.
  const result = buildComputeComparison({
    payloads: [
      payloadOf({ caseId: "lookup/flip", engine: "v1", computeMs: 0 }),
      payloadOf({ caseId: "lookup/flip", computeMs: 840 }),
    ],
    baseline: baselineOf([["lookup/flip", 836]]),
    releaseComparison: releaseOf([["lookup/flip", 0.35]]),
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].computeMs, 840);
}

{
  // A read-only case is counted, not compared: lumping it into "missing
  // baseline" would make the corpus look less covered than it is.
  const result = buildComputeComparison({
    payloads: [
      payloadOf({ caseId: "read/records", computeMs: 0, shapeMetrics: {} }),
    ],
    baseline: baselineOf([["lookup/flip", 836]]),
    releaseComparison: releaseOf([["read/records", 1.0]]),
  });

  assert.equal(result.counts.noCompute, 1);
  assert.equal(result.counts.missingBaseline, 0);
  assert.equal(result.rows.length, 0);
}

{
  // Every baseline commit measured before this shipped has no compute number,
  // and those cases must read as "no baseline" rather than as zero.
  const result = buildComputeComparison({
    payloads: [payloadOf({ caseId: "lookup/flip", computeMs: 840 })],
    baseline: {
      runId: "30520608995",
      values: { "lookup/flip::v2": { value: 1200, metric: "opMs" } },
    },
    releaseComparison: releaseOf([["lookup/flip", 0.35]]),
  });

  assert.equal(result.counts.missingBaseline, 1);
  assert.equal(result.rows[0].computeRatio, undefined);
  assert.equal(result.rows[0].verdict, undefined);
}

{
  // No baseline at all is "no comparison", never "nothing regressed".
  const result = buildComputeComparison({
    payloads: [payloadOf({ caseId: "lookup/flip", computeMs: 840 })],
    baseline: undefined,
    releaseComparison: releaseOf([["lookup/flip", 0.35]]),
  });

  assert.equal(result.available, false);
  assert.equal(result.counts.compared, 0);
  assert.equal(result.deferred.length, 0);
}

{
  // Deferred leads, and inside a verdict the most expensive case is on top.
  const result = buildComputeComparison({
    payloads: [
      payloadOf({ caseId: "b/slow", computeMs: 2000 }),
      payloadOf({ caseId: "a/moved", computeMs: 840 }),
      payloadOf({ caseId: "c/moved-more", computeMs: 1000 }),
    ],
    baseline: baselineOf([
      ["b/slow", 1000],
      ["a/moved", 836],
      ["c/moved-more", 830],
    ]),
    releaseComparison: releaseOf([
      ["b/slow", 1.6],
      ["a/moved", 0.35],
      ["c/moved-more", 0.35],
    ]),
  });

  assert.deepEqual(
    result.rows.map((row) => row.caseId),
    ["c/moved-more", "a/moved", "b/slow"],
  );
  assert.equal(result.rows[2].verdict, "regression");
  assert.equal(result.counts.regression, 1);
  assert.equal(result.counts.deferred, 2);
}

{
  // Compute got 1.7x worse while the wall clock stayed flat. A count built from
  // verdicts alone reports this as "0 slower"; `computeSlower` is what makes the
  // case a wall-clock-only report loses show up in the header line, and
  // `hiddenCost` is what puts it in the listed rows.
  const result = buildComputeComparison({
    payloads: [payloadOf({ caseId: "record-update/single", computeMs: 1186.62 })],
    baseline: baselineOf([["record-update/single", 700]]),
    releaseComparison: releaseOf([["record-update/single", 0.93]]),
  });

  assert.equal(result.rows[0].verdict, "hidden-cost");
  assert.equal(result.counts.computeSlower, 1);
  assert.equal(result.counts.regression, 0);
  assert.equal(result.hiddenCost.length, 1);
}

{
  // Compute got 1.5x worse and the wall half has no comparable baseline — the
  // shape a renamed primary metric produces, since the wall comparison rejects
  // the rename and this one does not. No verdict can be formed, and before
  // `unpaired` existed the row reached `computeSlower` and no list, so the
  // header counted a case the reader could never see.
  const result = buildComputeComparison({
    payloads: [payloadOf({ caseId: "lookup/renamed", computeMs: 1_500 })],
    baseline: baselineOf([["lookup/renamed", 1_000]]),
    releaseComparison: releaseOf([["lookup/renamed", undefined]]),
  });

  assert.equal(result.rows[0].verdict, undefined);
  assert.equal(result.counts.computeSlower, 1);
  assert.equal(result.counts.unpaired, 1);
  assert.equal(result.unpaired.length, 1);
  assert.equal(result.unpaired[0].caseId, "lookup/renamed");
  // Every compute-slower row now reaches one of the four lists, so the header
  // count and the rows under it can be reconciled.
  assert.equal(
    result.counts.computeSlower <=
      result.deferred.length +
        result.regressions.length +
        result.hiddenCost.length +
        result.unpaired.length,
    true,
  );
}

{
  // Compute got *faster* with no wall half. Nothing to act on and nothing a
  // wall-clock-only report loses, so it stays out of the lists.
  const result = buildComputeComparison({
    payloads: [payloadOf({ caseId: "lookup/renamed-fast", computeMs: 500 })],
    baseline: baselineOf([["lookup/renamed-fast", 1_000]]),
    releaseComparison: releaseOf([["lookup/renamed-fast", undefined]]),
  });

  assert.equal(result.counts.unpaired, 0);
  assert.equal(result.unpaired.length, 0);
}

{
  // A shape change contributes to no direction count: there is no ratio to have
  // a direction, and counting it as either invents a measurement.
  const result = buildComputeComparison({
    payloads: [payloadOf({ caseId: "lookup/flip", computeMs: 836 })],
    baseline: baselineOf([["lookup/flip", 376, "inline"]]),
    releaseComparison: releaseOf([["lookup/flip", 0.35]]),
  });

  assert.equal(result.counts.computeSlower, 0);
  assert.equal(result.counts.computeFaster, 0);
}

assert.equal(DEFAULT_COMPUTE_BAND, 1.2);
assert.throws(
  () => buildComputeComparison({ payloads: [], band: 1 }),
  /band must be greater than 1/,
);

console.log("compute comparison model checks passed.");
