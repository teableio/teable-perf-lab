import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { axios } from "@teable/openapi";
import {
  createTraceEvidencePolicy,
  normalizeTraceRequestBodyShape,
} from "./trace-evidence-policy";
import {
  createTraceFetchControl,
  type TraceFetchArtifactState,
  type TraceFetchDecision,
} from "./trace-fetch-control";
import type { PerfCase, PerfRunContext } from "./types";

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

const traceStepStorage = new AsyncLocalStorage<PerfTraceStep>();
const traceRefs: PerfTraceRef[] = [];

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

export const buildPerfTraceHeaders = (
  context: PerfRunContext,
  perfCase: PerfCase,
  stepId: string,
) => ({
  [PERF_HEADER_RUN_ID]: context.runId,
  [PERF_HEADER_CASE_ID]: perfCase.id,
  [PERF_HEADER_ENGINE]: context.engine,
  [PERF_HEADER_STEP_ID]: stepId,
});

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
  if (traceRefs.length < maxRefs) {
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
    setHeaderValue(config.headers, PERF_HEADER_RUN_ID, step.runId);
    setHeaderValue(config.headers, PERF_HEADER_CASE_ID, step.caseId);
    setHeaderValue(config.headers, PERF_HEADER_ENGINE, step.engine);
    setHeaderValue(config.headers, PERF_HEADER_STEP_ID, step.stepId);
    return config;
  });

  responseInterceptorId = axios.interceptors.response.use((response) => {
    const traceparent = getHeaderValue(response.headers, "traceparent");
    const parsedTraceparent = parseTraceparent(traceparent);
    const step = traceStepStorage.getStore();
    if (!traceparent || !parsedTraceparent || !step) {
      return response;
    }

    const requestBodyShape = normalizeTraceRequestBodyShape(
      response.config.data,
    );
    pushTraceRef({
      ...step,
      ...parsedTraceparent,
      traceparent,
      traceLink: parseTraceLink(getHeaderValue(response.headers, "link")),
      method: response.config.method?.toUpperCase(),
      url: resolveRequestUrl(response.config),
      ...(requestBodyShape ? { requestBodyShape } : {}),
      status: response.status,
      capturedAt: new Date().toISOString(),
    });

    return response;
  });

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
): T =>
  traceStepStorage.run(
    {
      runId: context.runId,
      caseId: perfCase.id,
      engine: context.engine,
      stepId,
    },
    fn,
  );

export const writeTraceArtifacts = async ({
  artifactDir,
  perfCase,
  engine,
}: {
  artifactDir?: string;
  perfCase: PerfCase;
  engine: string;
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
  const traceFetchControl = createTraceFetchControl({
    partialLossThreshold: getPositiveIntegerEnv(
      "PERF_LAB_TRACE_PARTIAL_LOSS_THRESHOLD",
      3,
    ),
    recoveryProbeLimit: getPositiveIntegerEnv(
      "PERF_LAB_TRACE_RECOVERY_PROBE_LIMIT",
      1,
    ),
  });
  const capturedRunRefs = traceRefsForRun(perfCase, engine);
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
    backgroundFlushCount,
    backgroundFlushErrorCount,
    backgroundFlushLastError,
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
  const traceFetchStartedAt = selectedRefs.length > 0 ? Date.now() : undefined;
  const remainingJobBudgetMs = Math.max(
    traceFetchJobBudgetMs - traceFetchJobWaitMs,
    0,
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

  const stopForDeadline = () => {
    const budgetMs =
      deadlineBudgetState === "job-budget"
        ? traceFetchJobBudgetMs
        : traceFetchCaseBudgetMs;
    traceFetchControl.stop(
      deadlineBudgetState,
      `Trace fetch ${
        deadlineBudgetState === "job-budget" ? "job" : "case"
      } budget ${budgetMs}ms exhausted`,
    );
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
      traceFetchJobWaitMs = Math.min(
        traceFetchJobBudgetMs,
        traceFetchJobWaitMs + traceFetchWaitMs,
      );
      const control = traceFetchControl.snapshot();
      summary.traceFetchWaitMs = traceFetchWaitMs;
      summary.traceFetchJobWaitMs = traceFetchJobWaitMs;
      summary.traceFetchBreakerState ??= control.state;
      summary.traceFetchBreakerReason ??= control.reason;
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
    await writeFile(
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

  if (selectedRefs.length > 0 && flushBeforeTraceFetch) {
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
  if (selectedRefs.length > 0) {
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

    await writeFile(path, JSON.stringify(result.data, null, 2));
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
