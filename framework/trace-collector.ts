import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { axios } from "@teable/openapi";
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
  maxSnapshotCount: number;
  fetchConcurrency: number;
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

const getPositiveIntegerEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isTraceCollectionEnabled = () =>
  process.env.PERF_LAB_TRACE_ENABLED !== "false";

export const setPerfTraceFlush = (
  flush: (() => Promise<void> | void) | undefined,
) => {
  flushBeforeTraceFetch = flush;
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
  const priorityRefs = uniqueRefs.filter(isPriorityTraceRef);
  const selected = [...priorityRefs];
  const selectedTraceIds = new Set(selected.map((ref) => ref.traceId));

  for (const ref of uniqueRefs) {
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
};

export const uninstallPerfTraceCollector = () => {
  if (!installed) {
    return;
  }

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
  const selectedRefs =
    enabled && jaegerApiBaseUrl ? selectTraceRefsToSave(perfCase, engine) : [];
  const runRefs = uniqueTraceRefsForRun(perfCase, engine);
  const selectedTraceIds = new Set(selectedRefs.map((ref) => ref.traceId));
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
    maxSnapshotCount,
    fetchConcurrency,
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

  for (const ref of runRefs.filter((ref) => !ref.sampled)) {
    summary.skippedTraceCount += 1;
    summary.savedTraces.push({
      traceId: ref.traceId,
      stepId: ref.stepId,
      path: "",
      status: "skipped",
      error:
        "Traceparent is not sampled, so Jaeger is not expected to store it",
      sampled: ref.sampled,
    });
  }

  if (jaegerApiBaseUrl) {
    for (const ref of runRefs.filter(
      (ref) => ref.sampled && !selectedTraceIds.has(ref.traceId),
    )) {
      summary.skippedTraceCount += 1;
      summary.savedTraces.push({
        traceId: ref.traceId,
        stepId: ref.stepId,
        path: "",
        status: "skipped",
        error: `Sampled trace was not fetched because PERF_LAB_TRACE_MAX_SNAPSHOTS=${maxSnapshotCount}`,
        sampled: ref.sampled,
      });
    }
  }

  if (selectedRefs.length > 0 && flushBeforeTraceFetch) {
    const flushStartedAt = Date.now();
    try {
      await flushBeforeTraceFetch();
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

  const fetchResults = await runWithConcurrency(
    selectedRefs,
    fetchConcurrency,
    async (ref) => {
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
    },
  );

  for (const { ref, result } of fetchResults) {
    const fileName = `${sanitizePathSegment(ref.stepId)}-${ref.traceId}.json`;
    const path = join(traceDir, fileName);
    const relativePath = join(traceRelativeDir, fileName);

    if (result.status === "saved") {
      await writeFile(path, JSON.stringify(result.data, null, 2));
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
      continue;
    }

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
  }

  summary.artifactDir = traceRelativeDir;
  summary.manifestPath = join(traceRelativeDir, "manifest.json");
  await writeFile(
    join(artifactDir, summary.manifestPath),
    JSON.stringify(summary, null, 2),
  );

  return summary;
};
