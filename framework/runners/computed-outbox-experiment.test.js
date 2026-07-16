import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPausedBacklogEvidence,
  buildObserverAbComparison,
} from "./computed-outbox-experiment.ts";

test("accepts a committed update that is visibly blocked by the paused BullMQ queue", () => {
  assert.doesNotThrow(() =>
    assertPausedBacklogEvidence({
      queuePaused: true,
      queuePausedJobs: 4,
      queueActiveJobs: 0,
      outboxPending: 4,
      outboxProcessing: 0,
      outboxDead: 0,
      oldestTaskAgeMs: 2_500,
      sourceCommitted: true,
      formulaStillStale: true,
    }),
  );
});

test("rejects fault evidence when the durable backlog did not remain pending", () => {
  assert.throws(
    () =>
      assertPausedBacklogEvidence({
        queuePaused: true,
        queuePausedJobs: 0,
        queueActiveJobs: 0,
        outboxPending: 0,
        outboxProcessing: 0,
        outboxDead: 0,
        oldestTaskAgeMs: 0,
        sourceCommitted: true,
        formulaStillStale: false,
      }),
    /paused backlog was not visible/,
  );
});

test("compares 5 ms and 50 ms observer treatments without imposing a winner", () => {
  assert.deepEqual(
    buildObserverAbComparison([
      { pollIntervalMs: 50, propagationReadyMs: 20_000, sampleCount: 400 },
      { pollIntervalMs: 5, propagationReadyMs: 24_000, sampleCount: 4_000 },
    ]),
    {
      order: [50, 5],
      fiveMs: {
        pollIntervalMs: 5,
        propagationReadyMs: 24_000,
        sampleCount: 4_000,
      },
      fiftyMs: {
        pollIntervalMs: 50,
        propagationReadyMs: 20_000,
        sampleCount: 400,
      },
      maxPropagationReadyMs: 24_000,
      propagationDeltaMs: 4_000,
      propagationRatio: 1.2,
      sampleCountDelta: 3_600,
      sampleCountRatio: 10,
    },
  );
});

test("requires exactly one 5 ms and one 50 ms treatment", () => {
  assert.throws(
    () =>
      buildObserverAbComparison([
        { pollIntervalMs: 5, propagationReadyMs: 20_000, sampleCount: 2_000 },
        { pollIntervalMs: 5, propagationReadyMs: 21_000, sampleCount: 2_100 },
      ]),
    /requires exactly one 5 ms and one 50 ms treatment/,
  );
});
