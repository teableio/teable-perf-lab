import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  context as otelContext,
  trace as otelTrace,
  TraceFlags,
  type SpanContext,
} from "@opentelemetry/api";
import { axios } from "@teable/openapi";
import { getAdapter } from "axios";
import {
  createTraceEvidencePolicy,
  normalizeTraceRequestBodyShape,
} from "./trace-evidence-policy";
import {
  buildExportableTraceId,
  buildNonExportableTraceId,
  parsePerfTraceExportRatio,
  shouldExportTraceStepRequest,
  type TraceStepCheckpoint,
} from "./trace-export-policy";
import {
  createTraceFetchControl,
  type TraceFetchArtifactState,
  type TraceFetchDecision,
} from "./trace-fetch-control";
import type { PerfCase, PerfRunContext } from "./types";
import { writeFileAtomically } from "./atomic-file.js";

type HeaderBag = Record<string, unknown> & {
  set?: (name: string, value: string) => void;
  toJSON?: () => Record<string, unknown>;
};

export interface PerfTraceStep {
  runId: string;
  caseId: string;
  engine: string;
  stepId: string;
}

export interface PerfTraceStepOptions {
  checkpoint?: TraceStepCheckpoint;
  requestCount?: number;
}

interface PerfTraceStepState extends PerfTraceStep {
  options?: PerfTraceStepOptions;
  requestIndex: number;
  wrapperExportable: boolean;
  wrapperSpanContext: SpanContext;
}

export interface PerfTraceRef extends PerfTraceStep {
  traceId: string;
  spanId: string;
  sampled: boolean;
  traceparent: string;
  traceLink?: string;
  method?: string;
  url?: string;
  requestBodyShape?: string;
  status?: number;
  failed?: boolean;
  capturedAt: string;
}

export interface PerfTraceArtifactSummary {
  enabled: boolean;
  traceRefCount: number;
  uniqueTraceCount: number;
  selectedTraceCount: number;
  savedTraceCount: number;
  failedTraceCount: number;
  skippedTraceCount: number;
  // Selected traces whose Jaeger fetch never returned data (each polled until
  // PERF_LAB_TRACE_FETCH_TIMEOUT_MS) and the total wall-clock burned doing so.
  // Surfaced so a silently slow run is diagnosable without reverse-engineering
  // caseMs vs durationMs from the logs.
  missingFetchCount: number;
  wastedFetchMs: number;
  traceFetchCaseBudgetMs: number;
  traceFetchJobBudgetMs: number;
  traceFetchWaitMs: number;
  traceFetchJobWaitMs: number;
  traceFetchBreakerState?: TraceFetchArtifactState;
  traceFetchBreakerReason?: string;
  traceFetchRecoveryProbeCount: number;
  traceFetchRecoverySucceeded: boolean;
  maxSnapshotCount: number;
  fetchConcurrency: number;
  backgroundFlushIntervalMs?: number;
  backgroundFlushCount?: number;
  backgroundFlushErrorCount?: number;
  backgroundFlushLastError?: string;
  flushDurationMs?: number;
  flushError?: string;
  traceFetchSkippedReason?: string;
  artifactDir?: string;
  manifestPath?: string;
  jaegerApiBaseUrl?: string;
  refs: PerfTraceRef[];
  savedTraces: Array<{
    traceId: string;
    stepId: string;
    path: string;
    status: "saved" | "missing" | "error" | "skipped";
    error?: string;
    attempts?: number;
    durationMs?: number;
    sampled?: boolean;
  }>;
}

type JaegerTraceFetchResult =
  | {
      status: "saved";
      traceId: string;
      data: unknown;
      attempts: number;
      durationMs: number;
    }
  | {
      status: "missing";
      traceId: string;
      error: string;
      attempts: number;
      durationMs: number;
    }
  | {
      status: "error";
      traceId: string;
      error: string;
      attempts: number;
      durationMs: number;
      unavailable?: boolean;
    };

const PERF_HEADER_RUN_ID = "x-teable-perf-run-id";
const PERF_HEADER_CASE_ID = "x-teable-perf-case-id";
const PERF_HEADER_ENGINE = "x-teable-perf-engine";
const PERF_HEADER_STEP_ID = "x-teable-perf-step-id";
const PERF_HEADER_TRACE_CHECKPOINT = "x-teable-perf-trace-checkpoint";

const traceStepStorage = new AsyncLocalStorage<PerfTraceStepState>();
const traceRefs: PerfTraceRef[] = [];
const perfTraceRequestMetadata = Symbol("perfTraceRequestMetadata");

interface PerfTraceRequestMetadata {
  step: PerfTraceStep;
  requestIndex: number;
  exportable: boolean;
  spanContext: SpanContext;
}

type PerfTraceAxiosConfig = {
  adapter?: unknown;
  [perfTraceRequestMetadata]?: PerfTraceRequestMetadata;
};

let installed = false;
let requestInterceptorId: number | undefined;
let responseInterceptorId: number | undefined;
let flushBeforeTraceFetch: (() => Promise<void> | void) | undefined;
let backgroundFlushTimer: ReturnType<typeof setInterval> | undefined;
let backgroundFlushInFlight: Promise<void> | undefined;
let traceFlushChain: Promise<void> = Promise.resolve();
let backgroundFlushCount = 0;
let backgroundFlushErrorCount = 0;
let backgroundFlushLastError: string | undefined;
let traceFetchJobWaitMs = 0;

type TraceFetchControl = ReturnType<typeof createTraceFetchControl>;

type DeferredTraceArtifact = {
  artifactDir?: string;
  perfCase: PerfCase;
  engine: string;
  capturedTraceRefs: PerfTraceRef[];
  backgroundFlushCount: number;
  backgroundFlushErrorCount: number;
  backgroundFlushLastError?: string;
  pendingSummary: PerfTraceArtifactSummary;
};

export interface PerfTraceJobTailResult {
  artifactDir?: string;
  perfCase: PerfCase;
  engine: string;
  summary: PerfTraceArtifactSummary;
  tailError?: string;
}

export type PerfTraceArtifactReconciler = (
  result: PerfTraceJobTailResult,
) => Promise<PerfTraceArtifactSummary | undefined>;

export interface PerfTraceJobTailLifecycleResult {
  results: PerfTraceJobTailResult[];
  elapsedMs: number;
  budgetMs: number;
  exceededBudget: boolean;
  artifactErrors: Array<{
    caseId: string;
    engine: string;
    message: string;
  }>;
}

const deferredTraceArtifacts: DeferredTraceArtifact[] = [];

const getPositiveIntegerEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const getNonNegativeIntegerEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntilDeadline = async <T>(
  promise: Promise<T>,
  deadlineAt: number,
  timeoutMessage: string,
) => {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error(timeoutMessage);
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(timeoutMessage)),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const isTraceCollectionEnabled = () =>
  process.env.PERF_LAB_TRACE_ENABLED !== "false";

export const setPerfTraceFlush = (
  flush: (() => Promise<void> | void) | undefined,
) => {
  flushBeforeTraceFetch = flush;
  ensurePerfTraceBackgroundFlush();
};

const getBackgroundFlushIntervalMs = () =>
  getNonNegativeIntegerEnv("PERF_LAB_TRACE_BACKGROUND_FLUSH_MS", 0);

const resetPerfTraceBackgroundFlushCounters = () => {
  backgroundFlushCount = 0;
  backgroundFlushErrorCount = 0;
  backgroundFlushLastError = undefined;
};

const flushTraceProvider = async () => {
  if (!flushBeforeTraceFetch) {
    return;
  }

  const currentFlush = traceFlushChain
    .then(() => flushBeforeTraceFetch?.())
    .then(() => undefined)
    .catch((error: unknown) => {
      throw error;
    });
  traceFlushChain = currentFlush.catch(() => undefined);

  await currentFlush;
};

const runBackgroundFlush = async () => {
  if (!flushBeforeTraceFetch || backgroundFlushInFlight) {
    return;
  }

  backgroundFlushInFlight = flushTraceProvider();
  try {
    await backgroundFlushInFlight;
    backgroundFlushCount += 1;
  } catch (error) {
    backgroundFlushErrorCount += 1;
    backgroundFlushLastError =
      error instanceof Error ? error.message : String(error);
  } finally {
    backgroundFlushInFlight = undefined;
  }
};

const stopPerfTraceBackgroundFlush = () => {
  if (backgroundFlushTimer) {
    clearInterval(backgroundFlushTimer);
  }
  backgroundFlushTimer = undefined;
};

const ensurePerfTraceBackgroundFlush = () => {
  stopPerfTraceBackgroundFlush();

  const intervalMs = getBackgroundFlushIntervalMs();
  if (!installed || !isTraceCollectionEnabled() || !flushBeforeTraceFetch) {
    return;
  }
  if (intervalMs <= 0) {
    return;
  }

  backgroundFlushTimer = setInterval(() => {
    void runBackgroundFlush();
  }, intervalMs);
  backgroundFlushTimer.unref?.();
};

const getHeaderValue = (headers: unknown, headerName: string) => {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }

  const headerBag = headers as HeaderBag;
  const normalizedHeaders =
    typeof headerBag.toJSON === "function" ? headerBag.toJSON() : headerBag;

  const matchedEntry = Object.entries(normalizedHeaders).find(
    ([key, value]) =>
      key.toLowerCase() === headerName.toLowerCase() &&
      (typeof value === "string" || typeof value === "number"),
  );

  return matchedEntry ? String(matchedEntry[1]) : undefined;
};

const setHeaderValue = (headers: unknown, name: string, value: string) => {
  if (!headers || typeof headers !== "object") {
    return;
  }

  const headerBag = headers as HeaderBag;
  if (typeof headerBag.set === "function") {
    headerBag.set(name, value);
    return;
  }

  headerBag[name] = value;
};

const randomNonZeroHex = (byteLength: number) => {
  let value = "";
  while (!value || /^0+$/.test(value)) {
    value = randomBytes(byteLength).toString("hex");
  }
  return value;
};

const createPerfSpanContext = (exportable: boolean): SpanContext => {
  const exportRatio = parsePerfTraceExportRatio(process.env.OTEL_EXPORT_RATIO);
  const prefix = randomNonZeroHex(14);
  const traceId = exportable
    ? buildExportableTraceId(prefix, exportRatio)
    : buildNonExportableTraceId(prefix, exportRatio);

  return {
    traceId,
    spanId: randomNonZeroHex(8),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
};

const wrapAxiosAdapterWithTraceContext = (
  config: PerfTraceAxiosConfig,
  spanContext: SpanContext,
) => {
  const adapter = getAdapter(config.adapter ?? axios.defaults.adapter);
  const requestContext = otelTrace.setSpanContext(
    otelContext.active(),
    spanContext,
  );
  config.adapter = (adapterConfig: unknown) =>
    otelContext.with(requestContext, () => adapter(adapterConfig));
};

const prepareTraceRequest = (
  config: PerfTraceAxiosConfig,
  step: PerfTraceStepState,
) => {
  const requestIndex = step.requestIndex;
  step.requestIndex += 1;
  const exportable = shouldExportTraceStepRequest({
    requestIndex,
    requestCount: step.options?.requestCount,
    checkpoint: step.options?.checkpoint,
  });
  const spanContext = createPerfSpanContext(exportable);
  config[perfTraceRequestMetadata] = {
    step,
    requestIndex,
    exportable,
    spanContext,
  };
  wrapAxiosAdapterWithTraceContext(config, spanContext);
  return config[perfTraceRequestMetadata];
};

export const buildPerfTraceHeaders = (
  context: PerfRunContext,
  perfCase: PerfCase,
  stepId: string,
) => {
  const activeStep = traceStepStorage.getStore();
  const activeSpanContext =
    activeStep?.runId === context.runId &&
    activeStep.caseId === perfCase.id &&
    activeStep.engine === context.engine &&
    activeStep.stepId === stepId
      ? activeStep.wrapperSpanContext
      : undefined;

  return {
    [PERF_HEADER_RUN_ID]: context.runId,
    [PERF_HEADER_CASE_ID]: perfCase.id,
    [PERF_HEADER_ENGINE]: context.engine,
    [PERF_HEADER_STEP_ID]: stepId,
    ...(activeSpanContext
      ? {
          [PERF_HEADER_TRACE_CHECKPOINT]: activeStep?.wrapperExportable
            ? "1"
            : "0",
          traceparent: `00-${activeSpanContext.traceId}-${activeSpanContext.spanId}-01`,
        }
      : {}),
  };
};

const parseTraceparent = (traceparent?: string) => {
  const match = traceparent?.match(
    /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i,
  );
  if (!match) {
    return null;
  }

  return {
    traceId: match[1],
    spanId: match[2],
    sampled: (Number.parseInt(match[3], 16) & 1) === 1,
  };
};

const pushTraceRef = (ref: PerfTraceRef) => {
  const maxRefs = getPositiveIntegerEnv("PERF_LAB_TRACE_MAX_REFS", 500);
  if (ref.failed || traceRefs.length < maxRefs) {
    traceRefs.push(ref);
  }
};

// `traceRefs` is a process-global accumulator and `PERF_LAB_TRACE_MAX_REFS` is a
// per-case safety cap. The serial spec runs every case in one process, so without
// resetting between cases the budget is consumed by the earliest cases and every
// later case captures zero refs (empty Trace_URL). Call this at the start of each
// case so each case+engine gets its own ref budget.
export const resetPerfTraceRefs = () => {
  traceRefs.length = 0;
  resetPerfTraceBackgroundFlushCounters();
};

export const resetPerfTraceJobBudget = () => {
  traceFetchJobWaitMs = 0;
};

export const recordPerfTraceRefFromHeaders = ({
  context,
  perfCase,
  stepId,
  headers,
  method,
  url,
  requestBody,
  status,
}: {
  context: PerfRunContext;
  perfCase: PerfCase;
  stepId: string;
  headers: unknown;
  method?: string;
  url?: string;
  requestBody?: unknown;
  status?: number;
}) => {
  if (!isTraceCollectionEnabled()) {
    return undefined;
  }
  const activeStep = traceStepStorage.getStore();
  if (
    activeStep &&
    !activeStep.wrapperExportable &&
    (status == null || status < 400)
  ) {
    return undefined;
  }

  const traceparent = getHeaderValue(headers, "traceparent");
  const parsedTraceparent = parseTraceparent(traceparent);
  if (!traceparent || !parsedTraceparent) {
    return undefined;
  }

  const requestBodyShape = normalizeTraceRequestBodyShape(requestBody);
  const ref: PerfTraceRef = {
    runId: context.runId,
    caseId: perfCase.id,
    engine: context.engine,
    stepId,
    ...parsedTraceparent,
    traceparent,
    traceLink: parseTraceLink(getHeaderValue(headers, "link")),
    method: method?.toUpperCase(),
    url,
    ...(requestBodyShape ? { requestBodyShape } : {}),
    status,
    failed: status != null && status >= 400,
    capturedAt: new Date().toISOString(),
  };
  pushTraceRef(ref);
  return ref;
};

const parseTraceLink = (linkHeader?: string) => {
  const traceLink = linkHeader
    ?.split(",")
    .map((part) => part.trim())
    .find((part) => /;\s*rel="?trace"?/i.test(part));
  return traceLink?.match(/^<([^>]+)>/)?.[1];
};

const resolveRequestUrl = (config: unknown) => {
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const requestConfig = config as { baseURL?: string; url?: string };
  if (!requestConfig.url) {
    return undefined;
  }

  try {
    return new URL(requestConfig.url, requestConfig.baseURL).toString();
  } catch {
    return requestConfig.url;
  }
};

const getPerfTraceRequestMetadata = (config: unknown) =>
  config && typeof config === "object"
    ? (config as PerfTraceAxiosConfig)[perfTraceRequestMetadata]
    : undefined;

const pushAxiosTraceRef = ({
  config,
  headers,
  status,
  failed,
}: {
  config: unknown;
  headers: unknown;
  status?: number;
  failed: boolean;
}) => {
  const metadata = getPerfTraceRequestMetadata(config);
  if (!metadata || (!metadata.exportable && !failed)) {
    return;
  }

  const responseTraceparent = getHeaderValue(headers, "traceparent");
  const parsedResponseTraceparent = parseTraceparent(responseTraceparent);
  const traceparent =
    responseTraceparent ??
    `00-${metadata.spanContext.traceId}-${metadata.spanContext.spanId}-01`;
  const parsedTraceparent = parsedResponseTraceparent ?? {
    traceId: metadata.spanContext.traceId,
    spanId: metadata.spanContext.spanId,
    sampled: true,
  };
  const requestConfig = config as {
    data?: unknown;
    headers?: unknown;
    method?: string;
  };
  const requestBodyShape = normalizeTraceRequestBodyShape(requestConfig.data);

  pushTraceRef({
    ...metadata.step,
    ...parsedTraceparent,
    traceparent,
    traceLink: parseTraceLink(getHeaderValue(headers, "link")),
    method: requestConfig.method?.toUpperCase(),
    url: resolveRequestUrl(config),
    ...(requestBodyShape ? { requestBodyShape } : {}),
    status,
    failed,
    capturedAt: new Date().toISOString(),
  });
};

const sanitizePathSegment = (value: string) =>
  value.replace(/[^a-zA-Z0-9_.-]+/g, "-");

const getJaegerApiBaseUrl = () => {
  const explicitBaseUrl = process.env.PERF_LAB_JAEGER_API_BASE_URL;
  if (explicitBaseUrl) {
    return explicitBaseUrl.replace(/\/+$/, "");
  }

  const traceLinkBaseUrl = process.env.TRACE_LINK_BASE_URL;
  return traceLinkBaseUrl?.replace(/\/+$/, "");
};

const uniqueTraceRefs = (refs: PerfTraceRef[]) => {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.traceId)) {
      return false;
    }
    seen.add(ref.traceId);
    return true;
  });
};

const traceRefsForRun = (perfCase: PerfCase, engine: string) =>
  traceRefs.filter(
    (ref) => ref.caseId === perfCase.id && ref.engine === engine,
  );

// Trace step patterns may be scoped to one engine: an engine-suffixed key
// (e.g. PERF_LAB_TRACE_INCLUDE_STEP_PATTERN_V1) wins for that engine, and the
// bare key applies to every engine. This lets a case narrow trace capture for
// an engine that drops spans under burst (V1, won't-fix) while still capturing
// everything for an engine that doesn't (V2). A bare key alone keeps the old
// both-engines behavior, so existing cases are unaffected.
const getEngineScopedRuntimeEnv = (
  perfCase: PerfCase,
  baseKey: string,
  engine: string,
) =>
  perfCase.runtimeEnv?.[`${baseKey}_${engine.toUpperCase()}`] ??
  perfCase.runtimeEnv?.[baseKey];

const getTraceIncludeStepPattern = (perfCase: PerfCase, engine: string) =>
  getEngineScopedRuntimeEnv(
    perfCase,
    "PERF_LAB_TRACE_INCLUDE_STEP_PATTERN",
    engine,
  );

const getTraceFallbackStepPattern = (perfCase: PerfCase, engine: string) =>
  getEngineScopedRuntimeEnv(
    perfCase,
    "PERF_LAB_TRACE_FALLBACK_STEP_PATTERN",
    engine,
  );

const runWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
) => {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await fn(items[currentIndex]);
      }
    },
  );

  await Promise.all(workers);
  return results;
};

const fetchJaegerTrace = async (
  jaegerApiBaseUrl: string,
  traceId: string,
  deadlineAt: number,
): Promise<JaegerTraceFetchResult> => {
  const timeoutMs = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_FETCH_TIMEOUT_MS",
    60_000,
  );
  const pollIntervalMs = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_FETCH_POLL_INTERVAL_MS",
    500,
  );
  const startedAt = Date.now();
  let lastError = "";
  let attempts = 0;

  const fetchDeadlineAt = Math.min(startedAt + timeoutMs, deadlineAt);

  while (Date.now() < fetchDeadlineAt) {
    attempts += 1;
    const controller = new AbortController();
    const remainingRequestMs = fetchDeadlineAt - Date.now();
    const timeout = setTimeout(() => controller.abort(), remainingRequestMs);
    try {
      const res = await fetch(`${jaegerApiBaseUrl}/api/traces/${traceId}`, {
        signal: controller.signal,
      });
      if (res.ok) {
        const data = (await res.json()) as {
          data?: unknown[];
        };
        if (Array.isArray(data.data) && data.data.length > 0) {
          return {
            status: "saved",
            traceId,
            data,
            attempts,
            durationMs: Date.now() - startedAt,
          };
        }
        lastError = "Jaeger returned an empty trace response";
      } else {
        lastError = `Jaeger API returned ${res.status}`;
        if (res.status >= 500) {
          return {
            status: "error",
            traceId,
            error: lastError,
            attempts,
            durationMs: Date.now() - startedAt,
            unavailable: true,
          };
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        lastError = "Trace fetch request exceeded the fetch budget";
        break;
      }
      if (isTraceServiceUnavailableError(lastError)) {
        return {
          status: "error",
          traceId,
          error: lastError,
          attempts,
          durationMs: Date.now() - startedAt,
          unavailable: true,
        };
      }
    } finally {
      clearTimeout(timeout);
    }

    const remainingMs = fetchDeadlineAt - Date.now();
    if (remainingMs > 0) {
      await delay(Math.min(pollIntervalMs, remainingMs));
    }
  }

  return {
    status: lastError ? "error" : "missing",
    traceId,
    error: lastError || `Trace ${traceId} was not available in Jaeger`,
    attempts,
    durationMs: Date.now() - startedAt,
  };
};

const isTraceServiceUnavailableError = (error?: string) =>
  error != null &&
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT)\b|connect timeout|fetch failed|socket hang up/i.test(
    error,
  );

export const installPerfTraceCollector = () => {
  if (installed || !isTraceCollectionEnabled()) {
    return;
  }
  installed = true;

  requestInterceptorId = axios.interceptors.request.use((config) => {
    const step = traceStepStorage.getStore();
    if (!step) {
      return config;
    }

    config.headers ??= {};
    const requestMetadata = prepareTraceRequest(
      config as PerfTraceAxiosConfig,
      step,
    );
    setHeaderValue(config.headers, PERF_HEADER_RUN_ID, step.runId);
    setHeaderValue(config.headers, PERF_HEADER_CASE_ID, step.caseId);
    setHeaderValue(config.headers, PERF_HEADER_ENGINE, step.engine);
    setHeaderValue(config.headers, PERF_HEADER_STEP_ID, step.stepId);
    setHeaderValue(
      config.headers,
      PERF_HEADER_TRACE_CHECKPOINT,
      requestMetadata.exportable ? "1" : "0",
    );
    return config;
  });

  responseInterceptorId = axios.interceptors.response.use(
    (response) => {
      pushAxiosTraceRef({
        config: response.config,
        headers: response.headers,
        status: response.status,
        failed: false,
      });
      return response;
    },
    (error: unknown) => {
      const candidate = error as {
        config?: unknown;
        response?: {
          config?: unknown;
          headers?: unknown;
          status?: number;
        };
      };
      pushAxiosTraceRef({
        config: candidate.response?.config ?? candidate.config,
        headers: candidate.response?.headers,
        status: candidate.response?.status,
        failed: true,
      });
      return Promise.reject(error);
    },
  );

  ensurePerfTraceBackgroundFlush();
};

export const uninstallPerfTraceCollector = () => {
  if (!installed) {
    return;
  }

  stopPerfTraceBackgroundFlush();

  if (requestInterceptorId != null) {
    axios.interceptors.request.eject(requestInterceptorId);
  }
  if (responseInterceptorId != null) {
    axios.interceptors.response.eject(responseInterceptorId);
  }

  requestInterceptorId = undefined;
  responseInterceptorId = undefined;
  installed = false;
};

export const withPerfTraceStep = <T>(
  context: PerfRunContext,
  perfCase: PerfCase,
  stepId: string,
  fn: () => T,
  options?: PerfTraceStepOptions,
): T => {
  if (!isTraceCollectionEnabled()) {
    return fn();
  }

  const wrapperExportable =
    options?.requestCount == null &&
    shouldExportTraceStepRequest({
      requestIndex: 0,
      checkpoint: options?.checkpoint,
    });
  const wrapperContext = otelTrace.setSpanContext(
    otelContext.active(),
    createPerfSpanContext(wrapperExportable),
  );
  const wrapperSpanContext = otelTrace.getSpanContext(wrapperContext);
  if (!wrapperSpanContext) {
    throw new Error("Unable to establish performance trace context");
  }
  return otelContext.with(wrapperContext, () =>
    traceStepStorage.run(
      {
        runId: context.runId,
        caseId: perfCase.id,
        engine: context.engine,
        stepId,
        options,
        requestIndex: 0,
        wrapperExportable,
        wrapperSpanContext,
      },
      fn,
    ),
  );
};

type TraceArtifactTerminalSkip = {
  state: Extract<TraceFetchArtifactState, "pending-job-tail" | "tail-error">;
  reason: string;
};

type WriteTraceArtifactOptions = {
  capturedTraceRefs?: PerfTraceRef[];
  sharedTraceFetchControl?: TraceFetchControl;
  skipFlushAndSettle?: boolean;
  jobTailStartedAt?: number;
  jobFetchDeadlineAt?: number;
  sharedFlushDurationMs?: number;
  sharedFlushError?: string;
  capturedBackgroundFlushCount?: number;
  capturedBackgroundFlushErrorCount?: number;
  capturedBackgroundFlushLastError?: string;
  terminalSkip?: TraceArtifactTerminalSkip;
};

const createConfiguredTraceFetchControl = () =>
  createTraceFetchControl({
    partialLossThreshold: getPositiveIntegerEnv(
      "PERF_LAB_TRACE_PARTIAL_LOSS_THRESHOLD",
      3,
    ),
    recoveryProbeLimit: getPositiveIntegerEnv(
      "PERF_LAB_TRACE_RECOVERY_PROBE_LIMIT",
      1,
    ),
  });

export const writeTraceArtifacts = async ({
  artifactDir,
  perfCase,
  engine,
  options,
}: {
  artifactDir?: string;
  perfCase: PerfCase;
  engine: string;
  options?: WriteTraceArtifactOptions;
}): Promise<PerfTraceArtifactSummary> => {
  const enabled = isTraceCollectionEnabled();
  const jaegerApiBaseUrl = getJaegerApiBaseUrl();
  const maxSnapshotCount = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_MAX_SNAPSHOTS",
    100,
  );
  const fetchConcurrency = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_FETCH_CONCURRENCY",
    8,
  );
  const traceFetchCaseBudgetMs = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_CASE_BUDGET_MS",
    15_000,
  );
  const traceFetchJobBudgetMs = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_JOB_BUDGET_MS",
    60_000,
  );
  const traceFetchControl =
    options?.sharedTraceFetchControl ?? createConfiguredTraceFetchControl();
  const capturedRunRefs =
    options?.capturedTraceRefs ?? traceRefsForRun(perfCase, engine);
  const runRefs = uniqueTraceRefs(capturedRunRefs);
  const evidencePolicy = enabled
    ? createTraceEvidencePolicy({
        refs: runRefs,
        includePattern: getTraceIncludeStepPattern(perfCase, engine),
        fallbackPattern: getTraceFallbackStepPattern(perfCase, engine),
        maxSnapshots: maxSnapshotCount,
      })
    : undefined;
  const selectedRefs = evidencePolicy?.selectedRefs ?? [];
  const savedTraceIds = new Set<string>();
  const failedTraceIds = new Set<string>();
  const fallbackTraceIds = new Set<string>();
  const skippedTraceErrors = new Map<string, string>();
  const summary: PerfTraceArtifactSummary = {
    enabled,
    traceRefCount: capturedRunRefs.length,
    uniqueTraceCount: runRefs.length,
    selectedTraceCount: selectedRefs.length,
    savedTraceCount: 0,
    failedTraceCount: 0,
    skippedTraceCount: 0,
    missingFetchCount: 0,
    wastedFetchMs: 0,
    traceFetchCaseBudgetMs,
    traceFetchJobBudgetMs,
    traceFetchWaitMs: 0,
    traceFetchJobWaitMs,
    traceFetchRecoveryProbeCount: 0,
    traceFetchRecoverySucceeded: false,
    maxSnapshotCount,
    fetchConcurrency,
    backgroundFlushIntervalMs: getBackgroundFlushIntervalMs(),
    backgroundFlushCount:
      options?.capturedBackgroundFlushCount ?? backgroundFlushCount,
    backgroundFlushErrorCount:
      options?.capturedBackgroundFlushErrorCount ?? backgroundFlushErrorCount,
    backgroundFlushLastError:
      options?.capturedBackgroundFlushLastError ?? backgroundFlushLastError,
    flushDurationMs: options?.sharedFlushDurationMs,
    flushError: options?.sharedFlushError,
    jaegerApiBaseUrl,
    refs: capturedRunRefs,
    savedTraces: [],
  };

  if (!artifactDir || !enabled) {
    return summary;
  }
  if (!evidencePolicy) {
    throw new Error(
      "Trace evidence policy is unavailable while tracing is enabled",
    );
  }

  const traceRelativeDir = join(
    "traces",
    `${sanitizePathSegment(perfCase.id)}-${sanitizePathSegment(engine)}`,
  );
  const traceDir = join(artifactDir, traceRelativeDir);
  await mkdir(traceDir, { recursive: true });
  if (options?.terminalSkip) {
    if (options.jobTailStartedAt != null) {
      summary.traceFetchJobWaitMs = Math.max(
        0,
        Date.now() - options.jobTailStartedAt,
      );
    }
    summary.skippedTraceCount = capturedRunRefs.length;
    summary.traceFetchBreakerState = options.terminalSkip.state;
    summary.traceFetchBreakerReason = options.terminalSkip.reason;
    summary.traceFetchSkippedReason = options.terminalSkip.reason;
    summary.savedTraces = capturedRunRefs.map((ref) => ({
      traceId: ref.traceId,
      stepId: ref.stepId,
      path: "",
      status: "skipped" as const,
      error: options.terminalSkip?.reason,
      sampled: ref.sampled,
    }));
    summary.artifactDir = traceRelativeDir;
    summary.manifestPath = join(traceRelativeDir, "manifest.json");
    await writeFileAtomically(
      join(artifactDir, summary.manifestPath),
      JSON.stringify(summary, null, 2),
    );
    return summary;
  }
  const traceFetchStartedAt = selectedRefs.length > 0 ? Date.now() : undefined;
  const jobWaitBeforeCase =
    options?.jobTailStartedAt == null
      ? traceFetchJobWaitMs
      : Math.max(0, Date.now() - options.jobTailStartedAt);
  const remainingConfiguredJobBudgetMs = Math.max(
    traceFetchJobBudgetMs - jobWaitBeforeCase,
    0,
  );
  const remainingFetchDeadlineMs =
    options?.jobFetchDeadlineAt == null
      ? remainingConfiguredJobBudgetMs
      : Math.max(0, options.jobFetchDeadlineAt - Date.now());
  const remainingJobBudgetMs = Math.min(
    remainingConfiguredJobBudgetMs,
    remainingFetchDeadlineMs,
  );
  const allowedFetchWaitMs = Math.min(
    traceFetchCaseBudgetMs,
    remainingJobBudgetMs,
  );
  const fetchDeadlineAt =
    traceFetchStartedAt == null
      ? Number.POSITIVE_INFINITY
      : traceFetchStartedAt + allowedFetchWaitMs;
  const deadlineBudgetState =
    remainingJobBudgetMs <= traceFetchCaseBudgetMs
      ? "job-budget"
      : "case-budget";
  let traceFetchFinalized = false;
  let caseBudgetReason: string | undefined;

  const stopForDeadline = () => {
    const budgetMs =
      deadlineBudgetState === "job-budget"
        ? traceFetchJobBudgetMs
        : traceFetchCaseBudgetMs;
    const reservedFinalizeMs =
      options?.jobTailStartedAt != null && options.jobFetchDeadlineAt != null
        ? Math.max(
            0,
            options.jobTailStartedAt +
              traceFetchJobBudgetMs -
              options.jobFetchDeadlineAt,
          )
        : 0;
    const reason =
      deadlineBudgetState === "job-budget" && reservedFinalizeMs > 0
        ? `Trace fetch job budget ${budgetMs}ms reserves ${reservedFinalizeMs}ms for artifact finalization; retrieval deadline reached`
        : `Trace fetch ${
            deadlineBudgetState === "job-budget" ? "job" : "case"
          } budget ${budgetMs}ms exhausted`;
    if (deadlineBudgetState === "job-budget") {
      traceFetchControl.stop(deadlineBudgetState, reason);
    } else {
      caseBudgetReason = reason;
    }
  };

  if (selectedRefs.length > 0 && allowedFetchWaitMs <= 0) {
    stopForDeadline();
  }

  const writeSummary = async () => {
    if (!traceFetchFinalized) {
      const traceFetchWaitMs =
        traceFetchStartedAt == null
          ? 0
          : Math.min(Date.now() - traceFetchStartedAt, allowedFetchWaitMs);
      traceFetchJobWaitMs =
        options?.jobTailStartedAt == null
          ? Math.min(
              traceFetchJobBudgetMs,
              traceFetchJobWaitMs + traceFetchWaitMs,
            )
          : Math.max(0, Date.now() - options.jobTailStartedAt);
      const control = traceFetchControl.snapshot();
      summary.traceFetchWaitMs = traceFetchWaitMs;
      summary.traceFetchJobWaitMs = traceFetchJobWaitMs;
      summary.traceFetchBreakerState ??=
        caseBudgetReason == null ? control.state : "case-budget";
      summary.traceFetchBreakerReason ??= caseBudgetReason ?? control.reason;
      summary.traceFetchRecoveryProbeCount = control.recoveryProbeCount;
      summary.traceFetchRecoverySucceeded = control.recoverySucceeded;
      traceFetchFinalized = true;
    }
    const accountedTraceCount =
      summary.savedTraceCount +
      summary.failedTraceCount +
      summary.skippedTraceCount;
    if (accountedTraceCount !== summary.traceRefCount) {
      throw new Error(
        `Trace manifest count mismatch: saved + failed + skipped = ${accountedTraceCount}, captured refs = ${summary.traceRefCount}`,
      );
    }
    summary.artifactDir = traceRelativeDir;
    summary.manifestPath = join(traceRelativeDir, "manifest.json");
    await writeFileAtomically(
      join(artifactDir, summary.manifestPath),
      JSON.stringify(summary, null, 2),
    );
    return summary;
  };

  const addSkippedTrace = (ref: PerfTraceRef, error: string) => {
    summary.skippedTraceCount += 1;
    summary.savedTraces.push({
      traceId: ref.traceId,
      stepId: ref.stepId,
      path: "",
      status: "skipped",
      error,
      sampled: ref.sampled,
    });
  };

  if (
    !options?.skipFlushAndSettle &&
    selectedRefs.length > 0 &&
    flushBeforeTraceFetch
  ) {
    const flushStartedAt = Date.now();
    try {
      const remainingMs = fetchDeadlineAt - Date.now();
      if (remainingMs <= 0) {
        stopForDeadline();
      } else {
        await waitUntilDeadline(
          flushTraceProvider(),
          fetchDeadlineAt,
          "Trace flush exceeded the fetch budget",
        );
      }
      summary.flushDurationMs = Date.now() - flushStartedAt;
    } catch (error) {
      summary.flushDurationMs = Date.now() - flushStartedAt;
      summary.flushError =
        error instanceof Error ? error.message : String(error);
    }
  }

  if (
    selectedRefs.length > 0 &&
    isTraceServiceUnavailableError(summary.flushError)
  ) {
    summary.traceFetchBreakerState = "exporter-outage";
    summary.traceFetchBreakerReason = summary.flushError;
    summary.traceFetchSkippedReason = `Trace service unavailable; skipped Jaeger fetch: ${summary.flushError}`;
    for (const ref of capturedRunRefs) {
      addSkippedTrace(ref, summary.traceFetchSkippedReason);
    }
    return writeSummary();
  }

  const settleMs = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_FETCH_SETTLE_MS",
    5_000,
  );
  if (!options?.skipFlushAndSettle && selectedRefs.length > 0) {
    const remainingMs = fetchDeadlineAt - Date.now();
    if (remainingMs <= 0) {
      stopForDeadline();
    } else {
      await delay(Math.min(settleMs, remainingMs));
      if (Date.now() >= fetchDeadlineAt) {
        stopForDeadline();
      }
    }
  }

  const fetchTraceRef = async (ref: PerfTraceRef) => {
    if (Date.now() >= fetchDeadlineAt) {
      stopForDeadline();
    }
    if (caseBudgetReason) {
      return { ref, skippedReason: caseBudgetReason };
    }
    const decision: TraceFetchDecision = traceFetchControl.next();
    if (decision.action === "skip") {
      return { ref, skippedReason: decision.reason };
    }

    let result: JaegerTraceFetchResult;
    if (!jaegerApiBaseUrl) {
      result = {
        status: "error",
        traceId: ref.traceId,
        error: "PERF_LAB_JAEGER_API_BASE_URL or TRACE_LINK_BASE_URL is not set",
        attempts: 0,
        durationMs: 0,
        unavailable: true,
      };
    } else {
      result = await fetchJaegerTrace(
        jaegerApiBaseUrl,
        ref.traceId,
        fetchDeadlineAt,
      );
    }

    traceFetchControl.record(
      decision,
      result.status === "saved"
        ? { status: "saved" }
        : "unavailable" in result && result.unavailable
          ? { status: "unavailable", error: result.error }
          : { status: "missing", error: result.error },
    );
    if (Date.now() >= fetchDeadlineAt) {
      stopForDeadline();
    }
    return { ref, result, decision };
  };

  const addSavedTrace = async (
    ref: PerfTraceRef,
    result: Extract<JaegerTraceFetchResult, { status: "saved" }>,
  ) => {
    const fileName = `${sanitizePathSegment(ref.stepId)}-${ref.traceId}.json`;
    const path = join(traceDir, fileName);
    const relativePath = join(traceRelativeDir, fileName);

    await writeFileAtomically(path, JSON.stringify(result.data, null, 2));
    savedTraceIds.add(ref.traceId);
    summary.savedTraceCount += 1;
    summary.savedTraces.push({
      traceId: ref.traceId,
      stepId: ref.stepId,
      path: relativePath,
      status: "saved",
      attempts: result.attempts,
      durationMs: result.durationMs,
      sampled: ref.sampled,
    });
  };

  const addFailedTrace = (
    ref: PerfTraceRef,
    result: Exclude<JaegerTraceFetchResult, { status: "saved" }>,
  ) => {
    const fileName = `${sanitizePathSegment(ref.stepId)}-${ref.traceId}.json`;
    const relativePath = join(traceRelativeDir, fileName);

    failedTraceIds.add(ref.traceId);
    summary.failedTraceCount += 1;
    summary.savedTraces.push({
      traceId: ref.traceId,
      stepId: ref.stepId,
      path: relativePath,
      status: result.status,
      error: result.error,
      attempts: result.attempts,
      durationMs: result.durationMs,
      sampled: ref.sampled,
    });
  };

  const markCoveredFailedTraceSkipped = (
    ref: PerfTraceRef,
    result: Exclude<JaegerTraceFetchResult, { status: "saved" }>,
  ) => {
    const requestShape = evidencePolicy.requestShape(ref);
    skippedTraceErrors.set(
      ref.traceId,
      `Selected trace was not saved because Jaeger fetch failed (${result.error}); saved another trace from request shape ${requestShape}`,
    );
  };

  const maxFallbackAttempts = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_FALLBACK_MAX_ATTEMPTS",
    3,
  );
  const fetchFallbackTrace = async (
    failedRef: PerfTraceRef,
    failedResult: Exclude<JaegerTraceFetchResult, { status: "saved" }>,
  ) => {
    // A fallback may only stand in for a ref of the same request shape:
    // substituting a different operation would mark a real Jaeger failure as
    // skipped without any representative coverage for the failed request. The
    // fallback pattern is a coarse opt-in filter; this is the safety invariant.
    let attempts = 0;
    for (const fallbackRef of evidencePolicy.fallbackCandidates(failedRef)) {
      if (attempts >= maxFallbackAttempts) {
        break;
      }
      if (
        fallbackTraceIds.has(fallbackRef.traceId) ||
        savedTraceIds.has(fallbackRef.traceId)
      ) {
        continue;
      }

      attempts += 1;
      fallbackTraceIds.add(fallbackRef.traceId);
      const fallbackAttempt = await fetchTraceRef(fallbackRef);
      if (!("result" in fallbackAttempt)) {
        skippedTraceErrors.set(
          fallbackRef.traceId,
          `Fallback trace was not fetched while replacing ${failedRef.stepId}: ${fallbackAttempt.skippedReason}`,
        );
        return null;
      }
      const { result } = fallbackAttempt;
      if (result.status === "saved") {
        skippedTraceErrors.set(
          failedRef.traceId,
          `Selected trace was not saved because Jaeger fetch failed (${failedResult.error}); saved fallback trace ${fallbackRef.traceId} from ${fallbackRef.stepId}`,
        );
        return { ref: fallbackRef, result };
      }

      // Fallback attempt also polled to timeout without finding a trace.
      summary.missingFetchCount += 1;
      summary.wastedFetchMs += result.durationMs;
      skippedTraceErrors.set(
        fallbackRef.traceId,
        `Fallback trace fetch failed while replacing ${failedRef.stepId}: ${result.error}`,
      );
    }

    return null;
  };

  const fetchResults = await runWithConcurrency(
    selectedRefs,
    fetchConcurrency,
    fetchTraceRef,
  );

  const failedFetchResults: Array<{
    ref: PerfTraceRef;
    result: Exclude<JaegerTraceFetchResult, { status: "saved" }>;
  }> = [];

  for (const fetchResult of fetchResults) {
    const { ref } = fetchResult;
    if (!("result" in fetchResult)) {
      skippedTraceErrors.set(ref.traceId, fetchResult.skippedReason);
      continue;
    }
    const { result } = fetchResult;
    if (result.status === "saved") {
      await addSavedTrace(ref, result);
      continue;
    }

    // A non-"saved" result means the trace never showed up in Jaeger, so the
    // fetch polled until timing out. Record that wasted wall-clock even though
    // the ref ends up "skipped" (covered by a same-request-shape trace) or
    // "failed".
    summary.missingFetchCount += 1;
    summary.wastedFetchMs += result.durationMs;
    failedFetchResults.push({ ref, result });
  }

  for (const { ref, result } of failedFetchResults) {
    if (evidencePolicy.hasSavedRepresentative(ref, savedTraceIds)) {
      markCoveredFailedTraceSkipped(ref, result);
      continue;
    }

    const fallback = await fetchFallbackTrace(ref, result);
    if (fallback) {
      await addSavedTrace(fallback.ref, fallback.result);
      continue;
    }

    if (evidencePolicy.hasSavedRepresentative(ref, savedTraceIds)) {
      markCoveredFailedTraceSkipped(ref, result);
      continue;
    }

    addFailedTrace(ref, result);
  }

  for (const ref of runRefs) {
    if (savedTraceIds.has(ref.traceId) || failedTraceIds.has(ref.traceId)) {
      continue;
    }

    addSkippedTrace(
      ref,
      evidencePolicy.explainUnfetched(ref, {
        savedTraceIds,
        error: skippedTraceErrors.get(ref.traceId),
      }),
    );
  }

  const seenTraceIds = new Set<string>();
  for (const ref of capturedRunRefs) {
    if (seenTraceIds.has(ref.traceId)) {
      addSkippedTrace(
        ref,
        `Duplicate captured trace ref ${ref.traceId}; the first ref owns its fetch outcome`,
      );
      continue;
    }
    seenTraceIds.add(ref.traceId);
  }

  return writeSummary();
};

export const resetPerfTraceJobTail = () => {
  deferredTraceArtifacts.length = 0;
  resetPerfTraceJobBudget();
};

export const deferTraceArtifacts = async ({
  artifactDir,
  perfCase,
  engine,
}: {
  artifactDir?: string;
  perfCase: PerfCase;
  engine: string;
}): Promise<PerfTraceArtifactSummary> => {
  const capturedTraceRefs = traceRefsForRun(perfCase, engine).slice();
  const snapshot = {
    artifactDir,
    perfCase,
    engine,
    capturedTraceRefs,
    backgroundFlushCount,
    backgroundFlushErrorCount,
    backgroundFlushLastError,
  };
  const pendingReason =
    "Trace retrieval is pending the bounded execute job tail";
  const pendingSummary = await writeTraceArtifacts({
    artifactDir,
    perfCase,
    engine,
    options: {
      capturedTraceRefs,
      capturedBackgroundFlushCount: snapshot.backgroundFlushCount,
      capturedBackgroundFlushErrorCount: snapshot.backgroundFlushErrorCount,
      capturedBackgroundFlushLastError: snapshot.backgroundFlushLastError,
      terminalSkip: {
        state: "pending-job-tail",
        reason: pendingReason,
      },
    },
  });

  if (artifactDir && pendingSummary.enabled) {
    deferredTraceArtifacts.push({ ...snapshot, pendingSummary });
  }
  return pendingSummary;
};

export const deferPerfTraceDetails = async ({
  context,
  perfCase,
  details,
}: {
  context: PerfRunContext;
  perfCase: PerfCase;
  details?: Record<string, unknown>;
}) => {
  const existingObservability = details?.observability;
  const observability =
    existingObservability &&
    typeof existingObservability === "object" &&
    !Array.isArray(existingObservability)
      ? existingObservability
      : {};
  let traces: PerfTraceArtifactSummary;
  try {
    traces = await deferTraceArtifacts({
      artifactDir: context.artifactDir,
      perfCase,
      engine: context.engine,
    });
  } catch (error) {
    const reason = `Trace deferral failed before job tail: ${
      error instanceof Error ? error.message : String(error)
    }`;
    console.warn(
      `[perf-lab] trace deferral failed caseId=${perfCase.id} engine=${context.engine}; preserving perf result: ${reason}`,
    );
    const fallback = await writeTraceArtifacts({
      perfCase,
      engine: context.engine,
    });
    traces = {
      ...fallback,
      savedTraceCount: 0,
      failedTraceCount: 0,
      skippedTraceCount: fallback.traceRefCount,
      traceFetchBreakerState: "tail-error",
      traceFetchBreakerReason: reason,
      traceFetchSkippedReason: reason,
      savedTraces: fallback.refs.map((ref) => ({
        traceId: ref.traceId,
        stepId: ref.stepId,
        path: "",
        status: "skipped",
        error: reason,
        sampled: ref.sampled,
      })),
    };
  }
  return {
    ...details,
    observability: {
      ...observability,
      traces,
    },
  };
};

const tailFailureSummary = async (
  item: DeferredTraceArtifact,
  reason: string,
  jobTailStartedAt: number,
) => {
  try {
    return await writeTraceArtifacts({
      artifactDir: item.artifactDir,
      perfCase: item.perfCase,
      engine: item.engine,
      options: {
        capturedTraceRefs: item.capturedTraceRefs,
        capturedBackgroundFlushCount: item.backgroundFlushCount,
        capturedBackgroundFlushErrorCount: item.backgroundFlushErrorCount,
        capturedBackgroundFlushLastError: item.backgroundFlushLastError,
        jobTailStartedAt,
        terminalSkip: { state: "tail-error", reason },
      },
    });
  } catch {
    return {
      ...item.pendingSummary,
      traceFetchJobWaitMs: Math.max(0, Date.now() - jobTailStartedAt),
      traceFetchBreakerState: "tail-error" as const,
      traceFetchBreakerReason: reason,
      traceFetchSkippedReason: reason,
      savedTraces: item.pendingSummary.savedTraces.map((trace) => ({
        ...trace,
        error: reason,
      })),
    };
  }
};

export const finalizePerfTraceJobTail = async ({
  jobTailStartedAt = Date.now(),
}: {
  jobTailStartedAt?: number;
} = {}): Promise<PerfTraceJobTailResult[]> => {
  const items = deferredTraceArtifacts.splice(0, deferredTraceArtifacts.length);
  if (items.length === 0) {
    return [];
  }

  resetPerfTraceJobBudget();
  const traceFetchJobBudgetMs = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_JOB_BUDGET_MS",
    60_000,
  );
  const jobDeadlineAt = jobTailStartedAt + traceFetchJobBudgetMs;
  const defaultFinalizeReserveMs = Math.min(
    5_000,
    Math.max(1, Math.floor(traceFetchJobBudgetMs / 10)),
  );
  const configuredFinalizeReserveMs = getNonNegativeIntegerEnv(
    "PERF_LAB_TRACE_FINALIZE_RESERVE_MS",
    defaultFinalizeReserveMs,
  );
  const finalizeReserveMs = Math.min(
    configuredFinalizeReserveMs,
    traceFetchJobBudgetMs,
  );
  const jobFetchDeadlineAt = jobDeadlineAt - finalizeReserveMs;
  const sharedTraceFetchControl = createConfiguredTraceFetchControl();
  const hasCapturedRefs = items.some(
    ({ capturedTraceRefs }) => capturedTraceRefs.length > 0,
  );
  let sharedFlushDurationMs: number | undefined;
  let sharedFlushError: string | undefined;

  if (hasCapturedRefs && flushBeforeTraceFetch) {
    const flushStartedAt = Date.now();
    try {
      await waitUntilDeadline(
        flushTraceProvider(),
        jobFetchDeadlineAt,
        "Trace flush exceeded the job tail budget",
      );
    } catch (error) {
      sharedFlushError = error instanceof Error ? error.message : String(error);
    } finally {
      sharedFlushDurationMs = Date.now() - flushStartedAt;
    }
  }

  if (
    hasCapturedRefs &&
    !isTraceServiceUnavailableError(sharedFlushError) &&
    Date.now() < jobFetchDeadlineAt
  ) {
    const settleMs = getPositiveIntegerEnv(
      "PERF_LAB_TRACE_FETCH_SETTLE_MS",
      5_000,
    );
    await delay(Math.min(settleMs, jobFetchDeadlineAt - Date.now()));
  }

  const results: PerfTraceJobTailResult[] = [];
  for (const item of items) {
    try {
      const summary = await writeTraceArtifacts({
        artifactDir: item.artifactDir,
        perfCase: item.perfCase,
        engine: item.engine,
        options: {
          capturedTraceRefs: item.capturedTraceRefs,
          sharedTraceFetchControl,
          skipFlushAndSettle: true,
          jobTailStartedAt,
          jobFetchDeadlineAt,
          sharedFlushDurationMs,
          sharedFlushError,
          capturedBackgroundFlushCount: item.backgroundFlushCount,
          capturedBackgroundFlushErrorCount: item.backgroundFlushErrorCount,
          capturedBackgroundFlushLastError: item.backgroundFlushLastError,
        },
      });
      results.push({
        artifactDir: item.artifactDir,
        perfCase: item.perfCase,
        engine: item.engine,
        summary,
      });
    } catch (error) {
      const tailError = error instanceof Error ? error.message : String(error);
      const reason = `Trace job tail failed: ${tailError}`;
      results.push({
        artifactDir: item.artifactDir,
        perfCase: item.perfCase,
        engine: item.engine,
        summary: await tailFailureSummary(item, reason, jobTailStartedAt),
        tailError,
      });
    }
  }
  return results;
};

const withTraceJobTailElapsed = (
  result: PerfTraceJobTailResult,
  jobTailStartedAt: number,
): PerfTraceJobTailResult => ({
  ...result,
  summary: {
    ...result.summary,
    traceFetchJobWaitMs: Math.max(
      result.summary.traceFetchJobWaitMs,
      Date.now() - jobTailStartedAt,
    ),
  },
});

export const finalizePerfTraceJobTailLifecycle = async ({
  reconcileArtifact,
}: {
  reconcileArtifact: PerfTraceArtifactReconciler;
}): Promise<PerfTraceJobTailLifecycleResult> => {
  const jobTailStartedAt = Date.now();
  const budgetMs = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_JOB_BUDGET_MS",
    60_000,
  );
  const results = await finalizePerfTraceJobTail({ jobTailStartedAt });
  const artifactErrors: PerfTraceJobTailLifecycleResult["artifactErrors"] = [];
  const successfullyReconciledIndexes: number[] = [];

  await Promise.all(
    results.map(async (result, index) => {
      const candidate = withTraceJobTailElapsed(result, jobTailStartedAt);
      results[index] = candidate;
      try {
        const committedSummary = await reconcileArtifact(candidate);
        results[index] = {
          ...candidate,
          summary: committedSummary ?? candidate.summary,
        };
        successfullyReconciledIndexes.push(index);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = `Trace artifact reconciliation failed after job tail: ${message}`;
        artifactErrors.push({
          caseId: candidate.perfCase.id,
          engine: candidate.engine,
          message,
        });
        results[index] = {
          ...candidate,
          tailError: candidate.tailError ?? message,
          summary: {
            ...candidate.summary,
            traceFetchBreakerState: "tail-error",
            traceFetchBreakerReason: reason,
            traceFetchSkippedReason:
              candidate.summary.traceFetchSkippedReason ?? reason,
          },
        };
      }
    }),
  );

  // Persist the full lifecycle time, including artifact reconciliation, in one
  // successfully committed case. If that final write itself crosses the SLO,
  // write once more so the overrun remains visible in the uploaded evidence.
  const evidenceIndex = successfullyReconciledIndexes.sort((a, b) => b - a)[0];
  if (evidenceIndex != null) {
    const reconcileEvidence = async () => {
      const candidate = withTraceJobTailElapsed(
        results[evidenceIndex],
        jobTailStartedAt,
      );
      results[evidenceIndex] = candidate;
      try {
        const committedSummary = await reconcileArtifact(candidate);
        results[evidenceIndex] = {
          ...candidate,
          summary: committedSummary ?? candidate.summary,
        };
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = `Trace artifact reconciliation failed after job tail: ${message}`;
        artifactErrors.push({
          caseId: candidate.perfCase.id,
          engine: candidate.engine,
          message,
        });
        results[evidenceIndex] = {
          ...candidate,
          tailError: candidate.tailError ?? message,
          summary: {
            ...candidate.summary,
            traceFetchBreakerState: "tail-error",
            traceFetchBreakerReason: reason,
            traceFetchSkippedReason:
              candidate.summary.traceFetchSkippedReason ?? reason,
          },
        };
        return false;
      }
    };

    const firstEvidenceElapsedMs = Date.now() - jobTailStartedAt;
    const evidenceCommitted = await reconcileEvidence();
    if (
      evidenceCommitted &&
      firstEvidenceElapsedMs <= budgetMs &&
      Date.now() - jobTailStartedAt > budgetMs
    ) {
      await reconcileEvidence();
    }
  }

  const elapsedMs = Date.now() - jobTailStartedAt;
  return {
    results,
    elapsedMs,
    budgetMs,
    exceededBudget: elapsedMs > budgetMs,
    artifactErrors,
  };
};
