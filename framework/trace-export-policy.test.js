import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExportableTraceId,
  buildNonExportableTraceId,
  getTraceCheckpointIndexes,
  isTraceCheckpoint,
  isTraceIdExportable,
  shouldExportTraceStepRequest,
} from "./trace-export-policy.ts";

test("normal repetitions retain only the first, median, and last checkpoints", () => {
  assert.deepEqual(getTraceCheckpointIndexes(1), [0]);
  assert.deepEqual(getTraceCheckpointIndexes(2), [0, 1]);
  assert.deepEqual(getTraceCheckpointIndexes(3), [0, 1, 2]);
  assert.deepEqual(getTraceCheckpointIndexes(50), [0, 24, 49]);

  assert.equal(isTraceCheckpoint(0, 50), true);
  assert.equal(isTraceCheckpoint(24, 50), true);
  assert.equal(isTraceCheckpoint(49, 50), true);
  assert.equal(isTraceCheckpoint(23, 50), false);
  assert.equal(isTraceCheckpoint(25, 50), false);
});

test("selected requests receive a trace id accepted by the configured export ratio", () => {
  const exportRatio = 0.001;
  const traceId = buildExportableTraceId(
    "0123456789abcdef0123456789ab",
    exportRatio,
  );

  assert.match(traceId, /^[0-9a-f]{32}$/);
  assert.equal(isTraceIdExportable(traceId, exportRatio), true);

  const nonExportableTraceId = buildNonExportableTraceId(
    "fedcba9876543210fedcba987654",
    exportRatio,
  );
  assert.equal(isTraceIdExportable(nonExportableTraceId, exportRatio), false);
});

test("trace steps select checkpoints before each request is sent", () => {
  assert.equal(
    shouldExportTraceStepRequest({ requestIndex: 0 }),
    true,
    "a normal one-request measured step is retained",
  );
  assert.equal(
    shouldExportTraceStepRequest({ requestIndex: 1 }),
    false,
    "an undeclared extra request is not silently retained",
  );
  assert.equal(
    shouldExportTraceStepRequest({ requestIndex: 24, requestCount: 50 }),
    true,
  );
  assert.equal(
    shouldExportTraceStepRequest({ requestIndex: 25, requestCount: 50 }),
    false,
  );
  assert.equal(
    shouldExportTraceStepRequest({
      requestIndex: 0,
      checkpoint: { index: 49, total: 50 },
    }),
    true,
  );
  assert.equal(
    shouldExportTraceStepRequest({
      requestIndex: 0,
      checkpoint: { index: 23, total: 50 },
    }),
    false,
  );
});

test("invalid checkpoint and export inputs fail closed", () => {
  assert.throws(() => getTraceCheckpointIndexes(0), /positive integer/);
  assert.throws(() => isTraceCheckpoint(-1, 3), /zero-based index/);
  assert.throws(
    () => buildExportableTraceId("not-a-prefix", 0.001),
    /28 lowercase hexadecimal/,
  );
  assert.equal(isTraceIdExportable("0".repeat(32), 0), false);
  assert.throws(
    () =>
      shouldExportTraceStepRequest({
        requestIndex: 1,
        requestCount: 1,
      }),
    /exceeded its declared request count/,
  );
});
