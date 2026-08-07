// Compute-time model: turns engine computed-execution spans into a
// scheduling-invariant occupancy summary for one measured window.
//
// See docs/compute-time-observation-spec.md for why this exists. The short
// version: a case's wall clock answers "how long did the user wait", which
// moves when the engine changes *how* computed work is scheduled, not just
// how much of it there is. Summed span durations answer "how much computing
// happened", which does not move under a serial/parallel refactor.
//
// This module is deliberately dependency-free: no OpenTelemetry types, no
// clock, no I/O. The sink (framework/compute-span-sink.ts) owns all of that
// and hands plain records in here, so the arithmetic that decides whether a
// number is reportable is testable without booting anything.

// The two engine spans that carry compute duration. They NEST — on the async
// path `processClaimedTask` is the parent of `execute` — so a sum must pick
// exactly one of them. `execute` is the canonical compute number because it is
// the only one emitted in both sync and hybrid computed-update modes.
export const COMPUTE_SPAN_NAMES = {
  execute: "teable.ComputedFieldUpdater.execute",
  task: "teable.worker.processClaimedTask",
} as const;

// Attributes the engine already stamps on those spans. Kept here rather than
// inline so an engine rename is a one-line change with a test behind it.
export const COMPUTE_SPAN_ATTRIBUTES = {
  runId: "computed.runId",
  taskId: "computed.taskId",
  phase: "computed.phase",
  executedStepCount: "computed.executedStepCount",
  estimatedComplexity: "computed.estimatedComplexity",
  outboxTaskId: "outbox.taskId",
} as const;

export type ComputeSpanKind = "execute" | "task";

// `full` is the sync strategy, `sync` is the hybrid strategy's inline leg, and
// `async` is a worker task. Only `async` work goes through the outbox, so this
// is what separates request-time compute from background compute.
export type ComputeSpanPhase = "full" | "sync" | "async";

export type ComputeSpanSample = {
  kind: ComputeSpanKind;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  runId?: string;
  taskId?: string;
  phase?: ComputeSpanPhase;
  executedStepCount?: number;
  estimatedComplexity?: number;
};

export type ComputeWindow = {
  openedAtMs: number;
  closedAtMs: number;
};

export type ComputeWindowSummary = {
  computeMs: number;
  computeInlineMs: number;
  computeAsyncMs: number;
  computeTaskMs: number;
  computeTaskOverheadMs: number;
  computeSpanCount: number;
  computeRunCount: number;
  computeTaskCount: number;
  computeStepsExecuted: number;
  computeEstimatedComplexity: number;
  computeSpillInCount: number;
  computeUnsettledSpans: number;
  computeSamplesDropped: number;
};

type SpanAttributeValue = string | number | boolean | undefined | null;

const round = (value: number) => Number(value.toFixed(2));

const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);

// Math.max() with no arguments is -Infinity, which then serializes to null in
// the artifact JSON and reads as a missing measurement rather than an empty
// one. Every aggregate here has to survive an empty window.
const maxOrZero = (values: number[]) =>
  values.length === 0 ? 0 : Math.max(...values);

const distinctCount = (values: Array<string | undefined>) =>
  new Set(values.filter((value): value is string => Boolean(value))).size;

const stringAttribute = (value: SpanAttributeValue) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberAttribute = (value: SpanAttributeValue) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const phaseAttribute = (
  value: SpanAttributeValue,
): ComputeSpanPhase | undefined =>
  value === "full" || value === "sync" || value === "async" ? value : undefined;

export const classifyComputeSpanName = (
  name: string,
): ComputeSpanKind | undefined => {
  if (name === COMPUTE_SPAN_NAMES.execute) return "execute";
  if (name === COMPUTE_SPAN_NAMES.task) return "task";
  return undefined;
};

// Returns undefined for spans this model does not measure, so the sink can use
// it as both the filter and the mapper.
export const toComputeSpanSample = (input: {
  name: string;
  attributes?: Record<string, SpanAttributeValue>;
  startedAtMs: number;
  endedAtMs: number;
}): ComputeSpanSample | undefined => {
  const kind = classifyComputeSpanName(input.name);
  if (!kind) return undefined;
  if (
    !Number.isFinite(input.startedAtMs) ||
    !Number.isFinite(input.endedAtMs)
  ) {
    return undefined;
  }

  const attributes = input.attributes ?? {};
  return {
    kind,
    startedAtMs: input.startedAtMs,
    endedAtMs: input.endedAtMs,
    // Clamped: a span whose clock went backwards must not subtract from a sum.
    durationMs: Math.max(0, input.endedAtMs - input.startedAtMs),
    runId: stringAttribute(attributes[COMPUTE_SPAN_ATTRIBUTES.runId]),
    taskId:
      stringAttribute(attributes[COMPUTE_SPAN_ATTRIBUTES.taskId]) ??
      stringAttribute(attributes[COMPUTE_SPAN_ATTRIBUTES.outboxTaskId]),
    phase: phaseAttribute(attributes[COMPUTE_SPAN_ATTRIBUTES.phase]),
    executedStepCount: numberAttribute(
      attributes[COMPUTE_SPAN_ATTRIBUTES.executedStepCount],
    ),
    estimatedComplexity: numberAttribute(
      attributes[COMPUTE_SPAN_ATTRIBUTES.estimatedComplexity],
    ),
  };
};

export const emptyComputeWindowSummary = (): ComputeWindowSummary => ({
  computeMs: 0,
  computeInlineMs: 0,
  computeAsyncMs: 0,
  computeTaskMs: 0,
  computeTaskOverheadMs: 0,
  computeSpanCount: 0,
  computeRunCount: 0,
  computeTaskCount: 0,
  computeStepsExecuted: 0,
  computeEstimatedComplexity: 0,
  computeSpillInCount: 0,
  computeUnsettledSpans: 0,
  computeSamplesDropped: 0,
});

export const summarizeComputeWindow = (input: {
  samples: ComputeSpanSample[];
  window: ComputeWindow;
  unsettledSpanCount?: number;
  droppedSampleCount?: number;
}): ComputeWindowSummary => {
  const { samples, window } = input;

  // Attribution is by END time. A span that ended inside the window did its
  // work for this window; one that ended after it belongs to whatever comes
  // next. Start time is used only to detect spill-in below.
  const ended = samples.filter(
    (sample) =>
      sample.endedAtMs >= window.openedAtMs &&
      sample.endedAtMs <= window.closedAtMs,
  );

  // Spill-in: started before the window opened, usually the previous case's
  // compute still draining. Excluded from every sum and counted instead, so a
  // contaminated window is visible rather than silently inflated.
  const spillIn = ended.filter(
    (sample) => sample.startedAtMs < window.openedAtMs,
  );
  const scoped = ended.filter(
    (sample) => sample.startedAtMs >= window.openedAtMs,
  );

  const execute = scoped.filter((sample) => sample.kind === "execute");
  const task = scoped.filter((sample) => sample.kind === "task");

  const computeInlineMs = sum(
    execute
      .filter((sample) => sample.phase !== "async")
      .map((sample) => sample.durationMs),
  );
  const computeAsyncMs = sum(
    execute
      .filter((sample) => sample.phase === "async")
      .map((sample) => sample.durationMs),
  );
  const computeTaskMs = sum(task.map((sample) => sample.durationMs));

  return {
    computeMs: round(computeInlineMs + computeAsyncMs),
    computeInlineMs: round(computeInlineMs),
    computeAsyncMs: round(computeAsyncMs),
    computeTaskMs: round(computeTaskMs),
    // The orchestration tax: claim, lock, plan, continuation enqueue, markDone.
    // Clamped because a task span can land in the window while the `execute`
    // it contains ended just outside it, which would otherwise read negative.
    computeTaskOverheadMs: round(Math.max(0, computeTaskMs - computeAsyncMs)),
    computeSpanCount: scoped.length,
    // A continuation chain shares one runId, so a plan split into N stages
    // still counts as one logical run.
    computeRunCount: distinctCount(execute.map((sample) => sample.runId)),
    computeTaskCount: distinctCount(task.map((sample) => sample.taskId)),
    computeStepsExecuted: sum(
      execute.map((sample) => sample.executedStepCount ?? 0),
    ),
    // Max, not sum: continuation stages each carry an estimate for the same
    // originating plan, so summing would multiply one plan's complexity.
    computeEstimatedComplexity: maxOrZero(
      execute.map((sample) => sample.estimatedComplexity ?? 0),
    ),
    computeSpillInCount: spillIn.length,
    computeUnsettledSpans: input.unsettledSpanCount ?? 0,
    computeSamplesDropped: input.droppedSampleCount ?? 0,
  };
};
