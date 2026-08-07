// In-process capture of the engine's computed-execution spans.
//
// The perf spec boots the Nest app in the same process it runs cases in, so
// span durations are readable directly — no Jaeger round trip, and none of the
// fetch-budget/settle/breaker machinery the trace evidence path needs.
//
// This module owns every impure part of that: the OpenTelemetry reach, the
// sample buffer, and the window bookkeeping. The arithmetic lives next door in
// framework/compute-span-model.ts, which is dependency-free and tested.
//
// The OTel attachment is a private-field reach. OTel 2.x removed
// `addSpanProcessor`, and there is no supported replacement for adding a
// processor to an already-started SDK. It works because
// `MultiSpanProcessor.onEnd` iterates its `_spanProcessors` array on every
// call, and every Tracer holds a reference to that one MultiSpanProcessor — so
// a processor pushed later is picked up by tracers created earlier. The same
// file that installs this sink already reaches `sdk._tracerProvider` for
// `forceFlush`, so this is not a new class of coupling.
//
// It is, however, a coupling that fails SILENTLY: a detached sink produces
// zero spans, which is indistinguishable from a case that did no computing.
// `getComputeSinkDiagnostics().spansSeen` counts every span of every name for
// exactly that reason — see the liveness note in
// docs/compute-time-observation-spec.md.

import {
  classifyComputeSpanName,
  emptyComputeWindowSummary,
  summarizeComputeWindow,
  toComputeSpanSample,
  type ComputeSpanSample,
  type ComputeWindowSummary,
} from "./compute-span-model";

// Structural stand-ins for the OTel shapes this file touches. Importing the
// real types would tie the perf lab's standalone type check to the engine's
// node_modules layout for no added safety — every field below is reached
// through a runtime guard anyway.
type SpanLike = {
  name?: string;
  attributes?: Record<string, unknown>;
  startTime?: [number, number];
  endTime?: [number, number];
  spanContext?: () => { spanId?: string } | undefined;
};

type SpanProcessorLike = {
  onStart: (span: SpanLike) => void;
  onEnd: (span: SpanLike) => void;
  shutdown: () => Promise<void>;
  forceFlush: () => Promise<void>;
};

type OtelSdkLike = {
  _tracerProvider?: unknown;
  tracerProvider?: unknown;
};

export type ComputeWindowHandle = {
  openedAtMs: number;
  closed: boolean;
};

export type ComputeSinkDiagnostics = {
  attached: boolean;
  spansSeen: number;
  samplesRecorded: number;
  droppedSampleCount: number;
  openWindowCount: number;
};

const DEFAULT_MAX_SAMPLES = 20_000;

let attached = false;
let processor: SpanProcessorLike | undefined;
let processorList: SpanProcessorLike[] | undefined;

let samples: ComputeSpanSample[] = [];
let droppedSampleCount = 0;
let samplesRecorded = 0;
let spansSeen = 0;

// Matching spans that have started and not yet ended, so a window can report
// how much compute was still in flight when it closed.
const openSpans = new Map<string, number>();
const openWindows = new Set<ComputeWindowHandle>();

const isEnabled = () => process.env.PERF_LAB_COMPUTE_SPANS !== "false";

const getMaxSamples = () => {
  const raw = Number(process.env.PERF_LAB_COMPUTE_SPAN_MAX_SAMPLES);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_SAMPLES;
};

// OTel HrTime is [seconds, nanoseconds] against the epoch. Converted here
// rather than via @opentelemetry/core so the sink adds no module resolution
// dependency on the engine's install layout.
const hrTimeToEpochMs = (hrTime: unknown) =>
  Array.isArray(hrTime) &&
  hrTime.length === 2 &&
  typeof hrTime[0] === "number" &&
  typeof hrTime[1] === "number"
    ? hrTime[0] * 1_000 + hrTime[1] / 1_000_000
    : undefined;

const getSpanId = (span: SpanLike) => {
  try {
    return span.spanContext?.()?.spanId;
  } catch {
    return undefined;
  }
};

// Walks NodeSDK -> NodeTracerProvider -> MultiSpanProcessor and returns the
// mutable processor array, or undefined if any link in that chain has moved.
const resolveSpanProcessors = (
  sdk: OtelSdkLike | undefined,
): SpanProcessorLike[] | undefined => {
  const provider = (sdk?._tracerProvider ?? sdk?.tracerProvider) as
    | { _activeSpanProcessor?: { _spanProcessors?: unknown } }
    | undefined;
  const list = provider?._activeSpanProcessor?._spanProcessors;
  return Array.isArray(list) ? (list as SpanProcessorLike[]) : undefined;
};

const recordSample = (sample: ComputeSpanSample) => {
  if (samples.length >= getMaxSamples()) {
    // Dropping the newest keeps this O(1) and makes every affected window's
    // sums an explicit lower bound rather than a silently reshaped history.
    droppedSampleCount += 1;
    return;
  }
  samples.push(sample);
  samplesRecorded += 1;
};

const createProcessor = (): SpanProcessorLike => ({
  onStart(span) {
    // A throw here would propagate into the engine's span lifecycle and take
    // the app down with it. Observability must never be able to do that.
    try {
      if (openWindows.size === 0) return;
      const name = typeof span.name === "string" ? span.name : undefined;
      if (!name) return;
      if (!classifyComputeSpanName(name)) return;
      const started = hrTimeToEpochMs(span.startTime);
      const spanId = getSpanId(span);
      if (started == null || !spanId) return;
      openSpans.set(spanId, started);
    } catch {
      // Ignore: a malformed span must not fail the run.
    }
  },
  onEnd(span) {
    try {
      spansSeen += 1;
      const spanId = getSpanId(span);
      if (spanId) openSpans.delete(spanId);
      if (openWindows.size === 0) return;

      const name = typeof span.name === "string" ? span.name : undefined;
      const startedAtMs = hrTimeToEpochMs(span.startTime);
      const endedAtMs = hrTimeToEpochMs(span.endTime);
      if (!name || startedAtMs == null || endedAtMs == null) return;

      const sample = toComputeSpanSample({
        name,
        attributes: span.attributes as
          | Record<string, string | number | boolean | undefined | null>
          | undefined,
        startedAtMs,
        endedAtMs,
      });
      if (sample) recordSample(sample);
    } catch {
      // Ignore: see onStart.
    }
  },
  shutdown: () => Promise.resolve(),
  forceFlush: () => Promise.resolve(),
});

// Returns whether the sink is live. A false return is a degraded run, not a
// failed one: every compute metric is simply absent from the artifact.
export const installComputeSpanSink = (sdk: unknown): boolean => {
  if (attached) return true;
  if (!isEnabled()) return false;

  const list = resolveSpanProcessors(sdk as OtelSdkLike | undefined);
  if (!list) {
    console.warn(
      "[perf-lab] compute span sink could not attach: the OpenTelemetry span " +
        "processor list was not reachable. Compute metrics will be absent " +
        "from this run; perf results are unaffected.",
    );
    return false;
  }

  processor = createProcessor();
  processorList = list;
  list.push(processor);
  attached = true;
  return true;
};

export const uninstallComputeSpanSink = () => {
  if (processorList && processor) {
    const index = processorList.indexOf(processor);
    if (index >= 0) processorList.splice(index, 1);
  }
  processor = undefined;
  processorList = undefined;
  attached = false;
  samples = [];
  droppedSampleCount = 0;
  samplesRecorded = 0;
  spansSeen = 0;
  openSpans.clear();
  openWindows.clear();
};

export const openComputeWindow = (): ComputeWindowHandle | undefined => {
  if (!attached) return undefined;
  const handle: ComputeWindowHandle = { openedAtMs: Date.now(), closed: false };
  openWindows.add(handle);
  return handle;
};

export const closeComputeWindow = (
  handle: ComputeWindowHandle | undefined,
): ComputeWindowSummary | undefined => {
  if (!handle || handle.closed) return undefined;
  handle.closed = true;
  openWindows.delete(handle);

  const closedAtMs = Date.now();
  // Compute still running when the window closed. Reported rather than
  // silently truncated, because a case that has not drained is not comparable
  // across runs.
  let unsettledSpanCount = 0;
  for (const startedAtMs of openSpans.values()) {
    if (startedAtMs >= handle.openedAtMs) unsettledSpanCount += 1;
  }

  const summary = summarizeComputeWindow({
    samples,
    window: { openedAtMs: handle.openedAtMs, closedAtMs },
    unsettledSpanCount,
    droppedSampleCount,
  });

  // Retain only what a still-open outer window could still need.
  if (openWindows.size === 0) {
    samples = [];
    droppedSampleCount = 0;
  } else {
    let earliestOpenedAtMs = Number.POSITIVE_INFINITY;
    for (const open of openWindows) {
      earliestOpenedAtMs = Math.min(earliestOpenedAtMs, open.openedAtMs);
    }
    samples = samples.filter(
      (sample) => sample.endedAtMs >= earliestOpenedAtMs,
    );
  }

  return summary;
};

export const getComputeSinkDiagnostics = (): ComputeSinkDiagnostics => ({
  attached,
  spansSeen,
  samplesRecorded,
  droppedSampleCount,
  openWindowCount: openWindows.size,
});

// The metric block a case carries when the sink never attached, so an artifact
// always states whether compute was measured instead of leaving it ambiguous.
export const detachedComputeMetrics = () => ({
  computeSinkAttached: 0,
  ...emptyComputeWindowSummary(),
});

export const toComputeMetrics = (summary: ComputeWindowSummary) => ({
  computeSinkAttached: 1,
  ...summary,
});
