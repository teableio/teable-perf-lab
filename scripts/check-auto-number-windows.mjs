// The window walk is what keeps the change point analysis under Teable's SQL
// statement timeout. These checks pin the three things it must get right:
// full coverage, narrowing on a timeout, and an exact median for a group that
// straddles two windows.
import assert from "node:assert/strict";
import {
  autoNumberRange,
  forEachAutoNumberWindow,
  percentileDisc,
  readMaxAutoNumber,
} from "./auto-number-windows.mjs";

// Covers (0, max] with no gap and no overlap.
{
  const seen = [];
  await forEachAutoNumberWindow({
    max: 120_000,
    windowRows: 50_000,
    visit: async (window) => seen.push([window.from, window.to]),
  });
  assert.deepEqual(seen, [
    [0, 50_000],
    [50_000, 100_000],
    [100_000, 120_000],
  ]);
}

// An empty table issues no window query.
{
  let calls = 0;
  await forEachAutoNumberWindow({ max: 0, visit: async () => (calls += 1) });
  assert.equal(calls, 0);
}

// A statement timeout halves the window and retries the same start.
{
  const seen = [];
  let failed = false;
  await forEachAutoNumberWindow({
    max: 40_000,
    windowRows: 40_000,
    visit: async (window) => {
      if (!failed) {
        failed = true;
        throw new Error(
          "Teable SQL failed: 400 canceling statement due to statement timeout",
        );
      }
      seen.push([window.from, window.to]);
    },
  });
  assert.deepEqual(seen, [
    [0, 20_000],
    [20_000, 40_000],
  ]);
}

// Any other error is not retried.
await assert.rejects(
  forEachAutoNumberWindow({
    max: 10,
    visit: async () => {
      throw new Error("synthetic rejected query");
    },
  }),
  /synthetic rejected query/,
);

// Same answer as PostgreSQL percentile_disc(0.5).
assert.equal(percentileDisc([3, 1, 2], 0.5), 2);
assert.equal(percentileDisc([4, 1, 3, 2], 0.5), 2);
assert.equal(percentileDisc([7], 0.5), 7);
assert.equal(percentileDisc([], 0.5), undefined);
// A group split 2 + 3 across windows: the merged median is the whole-table one,
// not the median of the two window medians.
assert.equal(percentileDisc([...[10, 50], ...[20, 30, 40]], 0.5), 30);

assert.equal(
  autoNumberRange({ from: 0, to: 50_000 }),
  `"__auto_number" > 0 AND "__auto_number" <= 50000`,
);
assert.equal(
  await readMaxAutoNumber({ query: async () => [{ m: "726934" }], table: "t" }),
  726_934,
);
assert.equal(
  await readMaxAutoNumber({ query: async () => [{ m: null }], table: "t" }),
  0,
);

console.log("auto-number window checks passed");
