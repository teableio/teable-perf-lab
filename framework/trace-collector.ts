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
  savedTraceCount: number;
  failedTraceCount: number;
  artifactDir?: string;
  manifestPath?: string;
  jaegerApiBaseUrl?: string;
  refs: PerfTraceRef[];
  savedTraces: Array<{
    traceId: string;
    stepId: string;
    path: string;
    status: "saved" | "missing" | "error";
    error?: string;
  }>;
}

type JaegerTraceFetchResult =
  | { status: "saved"; traceId: string; data: unknown }
  | { status: "missing"; traceId: string; error: string }
  | { status: "error"; traceId: string; error: string };

const PERF_HEADER_RUN_ID = "x-teable-perf-run-id";
const PERF_HEADER_CASE_ID = "x-teable-perf-case-id";
const PERF_HEADER_ENGINE = "x-teable-perf-engine";
const PERF_HEADER_STEP_ID = "x-teable-perf-step-id";

const traceStepStorage = new AsyncLocalStorage<PerfTraceStep>();
const traceRefs: PerfTraceRef[] = [];

let installed = false;

const getPositiveIntegerEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const isTraceCollectionEnabled = () =>
  process.env.PERF_LAB_TRACE_ENABLED !== "false";

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
    25,
  );
  const uniqueRefs = uniqueTraceRefsForRun(perfCase, engine);
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

const fetchJaegerTrace = async (
  jaegerApiBaseUrl: string,
  traceId: string,
): Promise<JaegerTraceFetchResult> => {
  const timeoutMs = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_FETCH_TIMEOUT_MS",
    20_000,
  );
  const pollIntervalMs = getPositiveIntegerEnv(
    "PERF_LAB_TRACE_FETCH_POLL_INTERVAL_MS",
    500,
  );
  const startedAt = Date.now();
  let lastError = "";

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const res = await fetch(`${jaegerApiBaseUrl}/api/traces/${traceId}`);
      if (res.ok) {
        const data = (await res.json()) as {
          data?: unknown[];
        };
        if (Array.isArray(data.data) && data.data.length > 0) {
          return { status: "saved", traceId, data };
        }
        lastError = "Jaeger returned an empty trace response";
      } else {
        lastError = `Jaeger API returned ${res.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return {
    status: lastError ? "error" : "missing",
    traceId,
    error: lastError || `Trace ${traceId} was not available in Jaeger`,
  };
};

export const installPerfTraceCollector = () => {
  if (installed || !isTraceCollectionEnabled()) {
    return;
  }
  installed = true;

  axios.interceptors.request.use((config) => {
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

  axios.interceptors.response.use((response) => {
    const traceparent = getHeaderValue(response.headers, "traceparent");
    const parsedTraceparent = parseTraceparent(traceparent);
    const step = traceStepStorage.getStore();
    if (!traceparent || !parsedTraceparent || !step) {
      return response;
    }

    const maxRefs = getPositiveIntegerEnv("PERF_LAB_TRACE_MAX_REFS", 500);
    if (traceRefs.length < maxRefs) {
      traceRefs.push({
        ...step,
        ...parsedTraceparent,
        traceparent,
        traceLink: parseTraceLink(getHeaderValue(response.headers, "link")),
        method: response.config.method?.toUpperCase(),
        url: resolveRequestUrl(response.config),
        status: response.status,
        capturedAt: new Date().toISOString(),
      });
    }

    return response;
  });
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
  const selectedRefs =
    enabled && jaegerApiBaseUrl ? selectTraceRefsToSave(perfCase, engine) : [];
  const runRefs = uniqueTraceRefsForRun(perfCase, engine);
  const summary: PerfTraceArtifactSummary = {
    enabled,
    traceRefCount: traceRefs.filter(
      (ref) => ref.caseId === perfCase.id && ref.engine === engine,
    ).length,
    uniqueTraceCount: runRefs.length,
    savedTraceCount: 0,
    failedTraceCount: 0,
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

  const fetchResults = await Promise.all(
    selectedRefs.map(async (ref) => {
      if (!jaegerApiBaseUrl) {
        return {
          ref,
          result: {
            status: "missing" as const,
            traceId: ref.traceId,
            error:
              "PERF_LAB_JAEGER_API_BASE_URL or TRACE_LINK_BASE_URL is not set",
          },
        };
      }

      return {
        ref,
        result: await fetchJaegerTrace(jaegerApiBaseUrl, ref.traceId),
      };
    }),
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
