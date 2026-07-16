import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedOrderState,
  resolveMutationWindow,
  resolveReadinessPlan,
} from "./link-computed-propagation-workload.ts";

test("default mutation window keeps the existing all-record workload", () => {
  assert.deepEqual(resolveMutationWindow(4_000), {
    startOffset: 0,
    recordCount: 4_000,
    endOffsetExclusive: 4_000,
  });
});

test("single-record mutation selects exactly one deterministic order", () => {
  assert.deepEqual(
    resolveMutationWindow(4_000, { startOffset: 1_999, recordCount: 1 }),
    {
      startOffset: 1_999,
      recordCount: 1,
      endOffsetExclusive: 2_000,
    },
  );
});

test("first-link leaves unmutated rows empty after a partial update", () => {
  const mutation = { startOffset: 0, recordCount: 1 };

  assert.deepEqual(
    expectedOrderState({
      mode: "first-link",
      rowCount: 4_000,
      mutation,
      phase: "updated",
      rowOffset: 0,
    }),
    { linked: true, permutationPhase: "updated" },
  );
  assert.deepEqual(
    expectedOrderState({
      mode: "first-link",
      rowCount: 4_000,
      mutation,
      phase: "updated",
      rowOffset: 1,
    }),
    { linked: false, permutationPhase: "seed" },
  );
});

test("repoint keeps unmutated rows on the seed target", () => {
  const mutation = { startOffset: 10, recordCount: 1 };

  assert.deepEqual(
    expectedOrderState({
      mode: "repoint",
      rowCount: 100,
      mutation,
      phase: "updated",
      rowOffset: 9,
    }),
    { linked: true, permutationPhase: "seed" },
  );
  assert.deepEqual(
    expectedOrderState({
      mode: "repoint",
      rowCount: 100,
      mutation,
      phase: "updated",
      rowOffset: 10,
    }),
    { linked: true, permutationPhase: "updated" },
  );
});

test("mutation window rejects out-of-range selections", () => {
  assert.throws(
    () => resolveMutationWindow(10, { startOffset: 9, recordCount: 2 }),
    /exceeds rowCount 10/,
  );
});

test("single-record read paths keep the full cascade scan outside the primary metric", () => {
  assert.deepEqual(resolveReadinessPlan("get-record"), {
    primaryReadPath: "get-record",
    verifyFullCascadeAfterPrimary: true,
  });
  assert.deepEqual(resolveReadinessPlan("get-records"), {
    primaryReadPath: "get-records",
    verifyFullCascadeAfterPrimary: true,
  });
});

test("existing cases keep full cascade readiness inside the primary metric", () => {
  assert.deepEqual(resolveReadinessPlan(), {
    primaryReadPath: "full-scan",
    verifyFullCascadeAfterPrimary: false,
  });
});
