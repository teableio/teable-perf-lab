import assert from "node:assert/strict";
import test from "node:test";

import {
  assertConditionalLookupRecordCreateConfig,
  buildConditionalLookupDirtyHostRows,
  lookupTextValues,
} from "./conditional-lookup-record-create-model.ts";

const config = {
  recordCount: 10_000,
  generator: {
    sourceKeyPrefix: "A-Key",
    hostKeyPrefix: "B-Key",
    sourceValuePrefix: "A-Value",
  },
  mutation: {
    recordCount: 100,
    sourceStartOffset: 20,
  },
  verify: {
    dirtySampleRows: [0, 49, 99],
  },
};

test("builds a deterministic dirty host window after the reusable seed rows", () => {
  const rows = buildConditionalLookupDirtyHostRows(config);

  assert.equal(rows.length, 100);
  assert.deepEqual(rows[0], {
    dirtyOffset: 0,
    hostRowNumber: 10_001,
    sourceRowNumber: 21,
    hostKey: "B-Key-10001",
    lookupKey: "A-Key-21",
    expectedValue: "A-Value-21",
  });
  assert.deepEqual(rows[99], {
    dirtyOffset: 99,
    hostRowNumber: 10_100,
    sourceRowNumber: 120,
    hostKey: "B-Key-10100",
    lookupKey: "A-Key-120",
    expectedValue: "A-Value-120",
  });
});

test("rejects dirty source windows and sample offsets outside the fixture", () => {
  assert.throws(
    () =>
      assertConditionalLookupRecordCreateConfig({
        ...config,
        mutation: { recordCount: 100, sourceStartOffset: 9_950 },
      }),
    /source window is out of range/,
  );
  assert.throws(
    () =>
      assertConditionalLookupRecordCreateConfig({
        ...config,
        verify: { dirtySampleRows: [0, 100] },
      }),
    /sample offset 100 is out of range/,
  );
  assert.throws(
    () =>
      assertConditionalLookupRecordCreateConfig({
        ...config,
        verify: { dirtySampleRows: [49, 49] },
      }),
    /sample offset 49 is duplicated/,
  );
});

test("normalizes lookup values from scalar, array, and title objects", () => {
  assert.deepEqual(lookupTextValues("A-Value-1"), ["A-Value-1"]);
  assert.deepEqual(lookupTextValues(["A-Value-1", { title: "A-Value-2" }]), [
    "A-Value-1",
    "A-Value-2",
  ]);
  assert.deepEqual(lookupTextValues([{ title: 42 }, null]), []);
});
