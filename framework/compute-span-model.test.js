import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPUTE_SPAN_NAMES,
  classifyComputeSpanName,
  emptyComputeWindowSummary,
  summarizeComputeWindow,
  toComputeSpanSample,
} from "./compute-span-model.ts";

const WINDOW = { openedAtMs: 1_000, closedAtMs: 2_000 };

// `phase` is read with `in` rather than a default parameter so a test can
// assert on a span that carries no phase at all.
const execute = (options = {}) => {
  const {
    startedAtMs = 1_100,
    endedAtMs = 1_200,
    runId = "cur_a",
    taskId,
    executedStepCount,
    estimatedComplexity,
  } = options;
  return {
    kind: "execute",
    startedAtMs,
    endedAtMs,
    durationMs: endedAtMs - startedAtMs,
    phase: "phase" in options ? options.phase : "async",
    runId,
    taskId,
    executedStepCount,
    estimatedComplexity,
  };
};

const task = ({
  startedAtMs = 1_050,
  endedAtMs = 1_250,
  taskId = "task_a",
} = {}) => ({
  kind: "task",
  startedAtMs,
  endedAtMs,
  durationMs: endedAtMs - startedAtMs,
  taskId,
});

const summarize = (samples, overrides = {}) =>
  summarizeComputeWindow({ samples, window: WINDOW, ...overrides });

test("classifies only the two spans that carry compute duration", () => {
  assert.equal(classifyComputeSpanName(COMPUTE_SPAN_NAMES.execute), "execute");
  assert.equal(classifyComputeSpanName(COMPUTE_SPAN_NAMES.task), "task");
  assert.equal(
    classifyComputeSpanName("teable.ComputedFieldUpdater.step"),
    undefined,
  );
  assert.equal(classifyComputeSpanName("teable.worker.runOnce"), undefined);
});

test("a nested task span never adds to the compute number", () => {
  // processClaimedTask (200ms) fully contains execute (100ms). Compute is the
  // inner span only; the outer one becomes orchestration overhead.
  const summary = summarize([
    task({ startedAtMs: 1_050, endedAtMs: 1_250 }),
    execute({ startedAtMs: 1_100, endedAtMs: 1_200 }),
  ]);

  assert.equal(summary.computeMs, 100);
  assert.equal(summary.computeAsyncMs, 100);
  assert.equal(summary.computeTaskMs, 200);
  assert.equal(summary.computeTaskOverheadMs, 100);
});

test("splits inline compute from async compute by phase", () => {
  const summary = summarize([
    execute({ phase: "full", startedAtMs: 1_000, endedAtMs: 1_030 }),
    execute({ phase: "sync", startedAtMs: 1_030, endedAtMs: 1_050 }),
    execute({ phase: "async", startedAtMs: 1_100, endedAtMs: 1_180 }),
  ]);

  assert.equal(summary.computeInlineMs, 50);
  assert.equal(summary.computeAsyncMs, 80);
  assert.equal(summary.computeMs, 130);
});

test("a span with no phase counts as inline, not async", () => {
  // Defensive: if the engine ever drops the attribute, unattributed compute
  // must not silently inflate the async leg that the outbox story rests on.
  const summary = summarize([
    execute({ phase: undefined, startedAtMs: 1_100, endedAtMs: 1_140 }),
  ]);

  assert.equal(summary.computeInlineMs, 40);
  assert.equal(summary.computeAsyncMs, 0);
});

test("overhead never reads negative when a task outlives its execute span", () => {
  // The execute span ended after the window closed, so only the task span is
  // in scope. Subtracting would otherwise report negative overhead.
  const summary = summarize([task({ startedAtMs: 1_100, endedAtMs: 1_300 })]);

  assert.equal(summary.computeAsyncMs, 0);
  assert.equal(summary.computeTaskMs, 200);
  assert.equal(summary.computeTaskOverheadMs, 200);
});

test("excludes and counts spans that started before the window opened", () => {
  const summary = summarize([
    execute({ startedAtMs: 900, endedAtMs: 1_100 }),
    execute({ startedAtMs: 1_200, endedAtMs: 1_260 }),
  ]);

  assert.equal(summary.computeMs, 60);
  assert.equal(summary.computeSpillInCount, 1);
  assert.equal(summary.computeSpanCount, 1);
});

test("ignores spans that ended outside the window", () => {
  const summary = summarize([
    execute({ startedAtMs: 1_100, endedAtMs: 2_400 }),
    execute({ startedAtMs: 100, endedAtMs: 400 }),
  ]);

  assert.deepEqual(summary, emptyComputeWindowSummary());
});

test("a continuation chain collapses to one logical run", () => {
  // Three stages of one plan: same runId, different task ids.
  const summary = summarize([
    execute({
      runId: "cur_a",
      taskId: "t1",
      startedAtMs: 1_010,
      endedAtMs: 1_040,
    }),
    execute({
      runId: "cur_a",
      taskId: "t2",
      startedAtMs: 1_050,
      endedAtMs: 1_080,
    }),
    execute({
      runId: "cur_a",
      taskId: "t3",
      startedAtMs: 1_090,
      endedAtMs: 1_120,
    }),
    task({ taskId: "t1", startedAtMs: 1_005, endedAtMs: 1_045 }),
    task({ taskId: "t2", startedAtMs: 1_045, endedAtMs: 1_085 }),
    task({ taskId: "t3", startedAtMs: 1_085, endedAtMs: 1_125 }),
  ]);

  assert.equal(summary.computeRunCount, 1);
  assert.equal(summary.computeTaskCount, 3);
  assert.equal(summary.computeMs, 90);
  // 3 stages x 40ms envelope minus 90ms of real compute.
  assert.equal(summary.computeTaskOverheadMs, 30);
});

test("sums executed steps but takes the max estimated complexity", () => {
  // Each continuation stage carries an estimate for the same originating plan,
  // so summing complexity would multiply one plan's cost by its stage count.
  const summary = summarize([
    execute({
      startedAtMs: 1_010,
      endedAtMs: 1_020,
      executedStepCount: 4,
      estimatedComplexity: 8_000,
    }),
    execute({
      startedAtMs: 1_030,
      endedAtMs: 1_040,
      executedStepCount: 3,
      estimatedComplexity: 8_000,
    }),
  ]);

  assert.equal(summary.computeStepsExecuted, 7);
  assert.equal(summary.computeEstimatedComplexity, 8_000);
});

test("an empty window is all zeros, never NaN or -Infinity", () => {
  const summary = summarize([]);

  assert.deepEqual(summary, emptyComputeWindowSummary());
  for (const [key, value] of Object.entries(summary)) {
    assert.equal(Number.isFinite(value), true, `${key} is not finite`);
  }
});

test("carries sink-side counters into the summary", () => {
  const summary = summarize([], {
    unsettledSpanCount: 2,
    droppedSampleCount: 7,
  });

  assert.equal(summary.computeUnsettledSpans, 2);
  assert.equal(summary.computeSamplesDropped, 7);
});

test("builds a sample from span attributes", () => {
  assert.deepEqual(
    toComputeSpanSample({
      name: COMPUTE_SPAN_NAMES.execute,
      startedAtMs: 1_100,
      endedAtMs: 1_180,
      attributes: {
        "computed.runId": "cur_a",
        "computed.taskId": "task_a",
        "computed.phase": "async",
        "computed.executedStepCount": 5,
        "computed.estimatedComplexity": 1_200,
      },
    }),
    {
      kind: "execute",
      startedAtMs: 1_100,
      endedAtMs: 1_180,
      durationMs: 80,
      runId: "cur_a",
      taskId: "task_a",
      phase: "async",
      executedStepCount: 5,
      estimatedComplexity: 1_200,
    },
  );
});

test("reads the task id a worker span carries under its own key", () => {
  const sample = toComputeSpanSample({
    name: COMPUTE_SPAN_NAMES.task,
    startedAtMs: 1_050,
    endedAtMs: 1_250,
    attributes: { "outbox.taskId": "task_a", "outbox.taskKind": "computed" },
  });

  assert.equal(sample?.kind, "task");
  assert.equal(sample?.taskId, "task_a");
  assert.equal(sample?.phase, undefined);
});

test("drops spans this model does not measure", () => {
  assert.equal(
    toComputeSpanSample({
      name: "teable.ComputedFieldUpdater.step",
      startedAtMs: 1_100,
      endedAtMs: 1_180,
    }),
    undefined,
  );
});

test("drops a span with an unusable clock", () => {
  assert.equal(
    toComputeSpanSample({
      name: COMPUTE_SPAN_NAMES.execute,
      startedAtMs: Number.NaN,
      endedAtMs: 1_180,
    }),
    undefined,
  );
});

test("clamps a backwards clock to zero instead of subtracting", () => {
  const sample = toComputeSpanSample({
    name: COMPUTE_SPAN_NAMES.execute,
    startedAtMs: 1_200,
    endedAtMs: 1_100,
  });

  assert.equal(sample?.durationMs, 0);
});

test("rejects an out-of-contract phase value", () => {
  const sample = toComputeSpanSample({
    name: COMPUTE_SPAN_NAMES.execute,
    startedAtMs: 1_100,
    endedAtMs: 1_180,
    attributes: { "computed.phase": "partial" },
  });

  assert.equal(sample?.phase, undefined);
});
