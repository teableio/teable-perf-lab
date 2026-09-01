import assert from "node:assert/strict";
import test from "node:test";
import { thresholdDisposition } from "./threshold-disposition.ts";

const failed = {
  metric: "durationMs",
  actual: 1_200,
  max: 1_000,
  unit: "ms",
  passed: false,
};

test("historical static thresholds still fail closed", () => {
  const result = thresholdDisposition({
    skipped: false,
    thresholds: [failed],
    observeOnly: false,
  });
  assert.equal(result.passed, false);
  assert.equal(result.failedThreshold, failed);
});

test("paired observation mode records a threshold breach without aborting", () => {
  const result = thresholdDisposition({
    skipped: false,
    thresholds: [failed],
    observeOnly: true,
  });
  assert.equal(result.passed, true);
  assert.equal(result.failedThreshold, undefined);
});

test("a declared skip remains non-failing", () => {
  const result = thresholdDisposition({
    skipped: true,
    thresholds: [failed],
    observeOnly: false,
  });
  assert.equal(result.passed, true);
  assert.equal(result.failedThreshold, undefined);
});
