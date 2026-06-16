import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { axios } from "@teable/openapi";
import {
  hasSavedTraceStepShape,
  normalizeTraceStepShape,
} from "./trace-classification";
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
  maxSnapshotCount: number;
  fetchConcurrency: number;
  backgroundFlushIntervalMs?: number;
  backgroundFlushCount?: number;
  backgroundFlushErrorCount?: number;
  backgroundFlushLastError?: string;
  flushDurationMs?: number;
  flushError?: string;
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

const getPositiveIntegerEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const getNonNegativeIntegerEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

export const recordPerfTraceRefFromHeaders = ({
  context,
  perfCase,
  stepId,
  headers,
  method,
  url,
  status,
}: {
  context: PerfRunContext;
  perfCase: PerfCase;
  stepId: string;
  headers: unknown;
  method?: string;
  url?: string;
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

const uniqueTraceRefs = () => {
  const seen = new Set<string>();
  return traceRefs.filter((ref) => {
    if (seen.has(ref.traceId)) {
      return false;
    }
    seen.add(ref.traceId);
    return true;
  });
};

const uniqueTraceRefsForRun = (perfCase: PerfCase, engine: string) =>
  uniqueTraceRefs().filter(
    (ref) => ref.caseId === perfCase.id && ref.engine === engine,
  );

const parseTraceStepPatterns = (value: unknown) => {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }

  return value
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern) => new RegExp(pattern));
};

const getTraceIncludeStepPattern = (perfCase: PerfCase) =>
  perfCase.runtimeEnv?.PERF_LAB_TRACE_INCLUDE_STEP_PATTERN;

const getTraceFallbackStepPattern = (perfCase: PerfCase) =>
  perfCase.runtimeEnv?.PERF_LAB_TRACE_FALLBACK_STEP_PATTERN;

const matchesTraceIncludePattern = (patterns: RegExp[], ref: PerfTraceRef) =>
  patterns.length === 0 || patterns.some((pattern) => pattern.test(ref.stepId));

const getStepNumber = (stepId: string) => {
  const match = stepId.match(/^(.*):(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    prefix: match[1],
    number: Number(match[2]),
  };
};

const sortFallbackRefsForFailedRef = (
  failedRef: PerfTraceRef,
  refs: PerfTraceRef[],
) => {
  const failedStepNumber = getStepNumber(failedRef.stepId);
  if (!failedStepNumber) {
    return refs;
  }

  return [...refs].sort((left, right) => {
    const leftStepNumber = getStepNumber(left.stepId);
    const rightStepNumber = getStepNumber(right.stepId);
    const leftDistance =
      leftStepNumber?.prefix === failedStepNumber.prefix
        ? Math.abs(leftStepNumber.number - failedStepNumber.number)
        : Number.POSITIVE_INFINITY;
    const rightDistance =
      rightStepNumber?.prefix === failedStepNumber.prefix
        ? Math.abs(rightStepNumber.number - failedStepNumber.number)
        : Number.POSITIVE_INFINITY;

    return leftDistance - rightDistance;
  });
};

const isPriorityTraceRef = (ref: PerfTraceRef) =>
  /create.*field|formula|lookup/i.test(ref.stepId) ||
  /\/field\//i.test(ref.url ?? "");

const selectTraceRefsToSave = (perfCase: PerfCase, engine: string) => {
  const maxSnapshots = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_MAX_SNAPSHOTS",
    100,
  );
  const uniqueRefs = uniqueTraceRefsForRun(perfCase, engine).filter(
    (ref) => ref.sampled,
  );
  const includePatterns = parseTraceStepPatterns(
    getTraceIncludeStepPattern(perfCase),
  );
  const candidateRefs = uniqueRefs.filter((ref) =>
    matchesTraceIncludePattern(includePatterns, ref),
  );
  const priorityRefs = candidateRefs.filter(isPriorityTraceRef);
  const selected = [...priorityRefs];
  const selectedTraceIds = new Set(selected.map((ref) => ref.traceId));

  for (const ref of candidateRefs) {
    if (selected.length >= maxSnapshots) {
      break;
    }
    if (!selectedTraceIds.has(ref.traceId)) {
      selected.push(ref);
      selectedTraceIds.add(ref.traceId);
    }
  }

  return selected.slice(0, maxSnapshots);
};

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

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    try {
      const res = await fetch(`${jaegerApiBaseUrl}/api/traces/${traceId}`);
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
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await delay(pollIntervalMs);
  }

  return {
    status: lastError ? "error" : "missing",
    traceId,
    error: lastError || `Trace ${traceId} was not available in Jaeger`,
    attempts,
    durationMs: Date.now() - startedAt,
  };
};

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

    pushTraceRef({
      ...step,
      ...parsedTraceparent,
      traceparent,
      traceLink: parseTraceLink(getHeaderValue(response.headers, "link")),
      method: response.config.method?.toUpperCase(),
      url: resolveRequestUrl(response.config),
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
  const selectedRefs = enabled ? selectTraceRefsToSave(perfCase, engine) : [];
  const runRefs = uniqueTraceRefsForRun(perfCase, engine);
  const selectedTraceIds = new Set(selectedRefs.map((ref) => ref.traceId));
  const savedTraceIds = new Set<string>();
  const failedTraceIds = new Set<string>();
  const fallbackTraceIds = new Set<string>();
  const skippedTraceErrors = new Map<string, string>();
  const summary: PerfTraceArtifactSummary = {
    enabled,
    traceRefCount: traceRefs.filter(
      (ref) => ref.caseId === perfCase.id && ref.engine === engine,
    ).length,
    uniqueTraceCount: runRefs.length,
    selectedTraceCount: selectedRefs.length,
    savedTraceCount: 0,
    failedTraceCount: 0,
    skippedTraceCount: 0,
    missingFetchCount: 0,
    wastedFetchMs: 0,
    maxSnapshotCount,
    fetchConcurrency,
    backgroundFlushIntervalMs: getBackgroundFlushIntervalMs(),
    backgroundFlushCount,
    backgroundFlushErrorCount,
    backgroundFlushLastError,
    jaegerApiBaseUrl,
    refs: runRefs,
    savedTraces: [],
  };

  if (!artifactDir || !enabled) {
    return summary;
  }

  const traceRelativeDir = join(
    "traces",
    `${sanitizePathSegment(perfCase.id)}-${sanitizePathSegment(engine)}`,
  );
  const traceDir = join(artifactDir, traceRelativeDir);
  await mkdir(traceDir, { recursive: true });

  if (selectedRefs.length > 0 && flushBeforeTraceFetch) {
    const flushStartedAt = Date.now();
    try {
      await flushTraceProvider();
      summary.flushDurationMs = Date.now() - flushStartedAt;
    } catch (error) {
      summary.flushDurationMs = Date.now() - flushStartedAt;
      summary.flushError =
        error instanceof Error ? error.message : String(error);
    }
  }

  const settleMs = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_FETCH_SETTLE_MS",
    5_000,
  );
  if (selectedRefs.length > 0) {
    await delay(settleMs);
  }

  const fetchTraceRef = async (ref: PerfTraceRef) => {
    if (!jaegerApiBaseUrl) {
      return {
        ref,
        result: {
          status: "missing" as const,
          traceId: ref.traceId,
          error:
            "PERF_LAB_JAEGER_API_BASE_URL or TRACE_LINK_BASE_URL is not set",
          attempts: 0,
          durationMs: 0,
        },
      };
    }

    return {
      ref,
      result: await fetchJaegerTrace(jaegerApiBaseUrl, ref.traceId),
    };
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
    const stepShape = normalizeTraceStepShape(ref.stepId);
    skippedTraceErrors.set(
      ref.traceId,
      `Selected trace was not saved because Jaeger fetch failed (${result.error}); saved another trace from step shape ${stepShape}`,
    );
  };

  const fallbackPattern = getTraceFallbackStepPattern(perfCase);
  const fallbackPatterns = parseTraceStepPatterns(fallbackPattern);
  const maxFallbackAttempts = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_FALLBACK_MAX_ATTEMPTS",
    3,
  );
  const fallbackRefs =
    fallbackPatterns.length > 0
      ? runRefs.filter(
          (ref) =>
            ref.sampled &&
            !selectedTraceIds.has(ref.traceId) &&
            matchesTraceIncludePattern(fallbackPatterns, ref),
        )
      : [];

  const fetchFallbackTrace = async (
    failedRef: PerfTraceRef,
    failedResult: Exclude<JaegerTraceFetchResult, { status: "saved" }>,
  ) => {
    // A fallback may only stand in for a ref of the *same* normalized shape:
    // substituting a different operation would mark a real Jaeger failure as
    // skipped without any representative coverage for the failed step. The
    // fallback pattern is a coarse opt-in filter; this is the safety invariant.
    const failedShape = normalizeTraceStepShape(failedRef.stepId);
    let attempts = 0;
    for (const fallbackRef of sortFallbackRefsForFailedRef(
      failedRef,
      fallbackRefs,
    )) {
      if (attempts >= maxFallbackAttempts) {
        break;
      }
      if (normalizeTraceStepShape(fallbackRef.stepId) !== failedShape) {
        continue;
      }
      if (
        fallbackTraceIds.has(fallbackRef.traceId) ||
        savedTraceIds.has(fallbackRef.traceId)
      ) {
        continue;
      }

      attempts += 1;
      fallbackTraceIds.add(fallbackRef.traceId);
      const { result } = await fetchTraceRef(fallbackRef);
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

  for (const { ref, result } of fetchResults) {
    if (result.status === "saved") {
      await addSavedTrace(ref, result);
      continue;
    }

    // A non-"saved" result means the trace never showed up in Jaeger, so the
    // fetch polled until timing out. Record that wasted wall-clock even though
    // the ref ends up "skipped" (covered by a same-shape trace) or "failed".
    summary.missingFetchCount += 1;
    summary.wastedFetchMs += result.durationMs;
    failedFetchResults.push({ ref, result });
  }

  for (const { ref, result } of failedFetchResults) {
    if (hasSavedTraceStepShape(ref, runRefs, savedTraceIds)) {
      markCoveredFailedTraceSkipped(ref, result);
      continue;
    }

    const fallback = await fetchFallbackTrace(ref, result);
    if (fallback) {
      await addSavedTrace(fallback.ref, fallback.result);
      continue;
    }

    if (hasSavedTraceStepShape(ref, runRefs, savedTraceIds)) {
      markCoveredFailedTraceSkipped(ref, result);
      continue;
    }

    addFailedTrace(ref, result);
  }

  const includePattern = getTraceIncludeStepPattern(perfCase);
  const includePatterns = parseTraceStepPatterns(includePattern);
  for (const ref of runRefs) {
    if (savedTraceIds.has(ref.traceId) || failedTraceIds.has(ref.traceId)) {
      continue;
    }

    const skippedByIncludePattern =
      ref.sampled && !matchesTraceIncludePattern(includePatterns, ref);
    summary.skippedTraceCount += 1;
    summary.savedTraces.push({
      traceId: ref.traceId,
      stepId: ref.stepId,
      path: "",
      status: "skipped",
      error:
        skippedTraceErrors.get(ref.traceId) ??
        (!ref.sampled
          ? "Traceparent is not sampled, so Jaeger is not expected to store it"
          : skippedByIncludePattern
            ? `Sampled trace was not fetched because stepId did not match PERF_LAB_TRACE_INCLUDE_STEP_PATTERN=${includePattern}`
            : `Sampled trace was not fetched because PERF_LAB_TRACE_MAX_SNAPSHOTS=${maxSnapshotCount}`),
      sampled: ref.sampled,
    });
  }

  summary.artifactDir = traceRelativeDir;
  summary.manifestPath = join(traceRelativeDir, "manifest.json");
  await writeFile(
    join(artifactDir, summary.manifestPath),
    JSON.stringify(summary, null, 2),
  );

  return summary;
};
