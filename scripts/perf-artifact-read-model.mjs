import { access, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export const sanitizeCaseId = (caseId) =>
  caseId.replace(/[^a-zA-Z0-9_.-]+/g, "-");

export const sanitizeSegment = (value) =>
  value.replace(/[^a-zA-Z0-9_.-]+/g, "-");

export const artifactJsonName = (caseId, engine) =>
  `${sanitizeCaseId(caseId)}-${sanitizeSegment(engine)}.json`;

export const legacyArtifactJsonName = (caseId) =>
  `${sanitizeCaseId(caseId)}.json`;

export const summaryMarkdownName = (caseId, engine) =>
  `summary-${sanitizeCaseId(caseId)}-${sanitizeSegment(engine)}.md`;

export const fileExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export const readJsonFile = async (path) =>
  JSON.parse(await readFile(path, "utf8"));

export const readTextFileIfExists = async (path) =>
  (await fileExists(path)) ? readFile(path, "utf8") : "";

export const readJsonFileIfExists = async (path) =>
  (await fileExists(path)) ? readJsonFile(path) : undefined;

export const artifactNameFromPayloadPath = (fileName) => {
  const [firstSegment] = fileName.split(/[\\/]/);
  return firstSegment?.startsWith("teable-ee-e2e-perf-")
    ? firstSegment
    : undefined;
};

const walkArtifactPayloadFiles = async (directory, payloadFiles) => {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkArtifactPayloadFiles(path, payloadFiles);
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith(".json") &&
      entry.name !== "manifest.json"
    ) {
      payloadFiles.push(path);
    }
  }
};

export const readArtifactPayloads = async ({
  artifactDir,
  fallbackCaseId,
  fallbackEngine = "local",
  includeSeed = true,
  allowEmpty = false,
  buildMissingPayload,
}) => {
  const payloadFiles = [];
  await walkArtifactPayloadFiles(artifactDir, payloadFiles);
  payloadFiles.sort();

  const payloads = [];
  for (const payloadPath of payloadFiles) {
    const payload = await readJsonFile(payloadPath);
    if (payload?.caseId && payload?.engine) {
      const fileName = relative(artifactDir, payloadPath);
      payloads.push({
        payload,
        payloadPath,
        fileName,
        artifactName: artifactNameFromPayloadPath(fileName),
      });
    }
  }

  if (payloads.length > 0) {
    return includeSeed
      ? payloads
      : payloads.filter(({ payload }) => payload.engine !== "seed");
  }

  if (!fallbackCaseId) {
    if (allowEmpty) {
      return [];
    }
    throw new Error(
      `No perf payloads found in ${artifactDir}, and no fallback case id was provided`,
    );
  }

  const newPayloadPath = join(
    artifactDir,
    artifactJsonName(fallbackCaseId, fallbackEngine),
  );
  const legacyPayloadPath = join(
    artifactDir,
    legacyArtifactJsonName(fallbackCaseId),
  );
  const payloadPath = (await fileExists(newPayloadPath))
    ? newPayloadPath
    : legacyPayloadPath;
  const payload = (await fileExists(payloadPath))
    ? await readJsonFile(payloadPath)
    : buildMissingPayload?.({
        caseId: fallbackCaseId,
        engine: fallbackEngine,
        payloadPath,
      });

  if (!payload) {
    throw new Error(`Perf payload was not generated at ${payloadPath}`);
  }

  if (!includeSeed && payload.engine === "seed") {
    return [];
  }

  const fileName = relative(artifactDir, payloadPath);
  return [
    {
      payload,
      payloadPath,
      fileName,
      artifactName: artifactNameFromPayloadPath(fileName),
    },
  ];
};

export const numberOrUndefined = (value) => {
  if (value == null || value === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

export const stringOrUndefined = (value) => {
  if (value == null || value === "") {
    return undefined;
  }
  return String(value);
};

export const jsonText = (value) =>
  value == null ? "" : JSON.stringify(value, null, 2);

export const primaryThreshold = (payload) =>
  Array.isArray(payload.thresholds) ? payload.thresholds[0] : undefined;

export const primaryMetricValue = (payload) => {
  const threshold = primaryThreshold(payload);
  if (Number.isFinite(threshold?.actual)) {
    return threshold.actual;
  }
  return numberOrUndefined(payload.durationMs);
};

export const compactTraceManifest = (traceManifest) => {
  if (!traceManifest) {
    return undefined;
  }

  const failedOrMissing = Array.isArray(traceManifest.savedTraces)
    ? traceManifest.savedTraces.filter(
        (trace) => trace?.status && trace.status !== "saved",
      )
    : [];
  const sampledRefs = Array.isArray(traceManifest.refs)
    ? traceManifest.refs.slice(0, 20).map((ref) => ({
        stepId: ref?.stepId,
        traceId: ref?.traceId,
        sampled: ref?.sampled,
        method: ref?.method,
        url: ref?.url,
        status: ref?.status,
        traceLink: ref?.traceLink,
      }))
    : undefined;

  return {
    enabled: traceManifest.enabled,
    traceRefCount: traceManifest.traceRefCount,
    uniqueTraceCount: traceManifest.uniqueTraceCount,
    selectedTraceCount: traceManifest.selectedTraceCount,
    savedTraceCount: traceManifest.savedTraceCount,
    failedTraceCount: traceManifest.failedTraceCount,
    skippedTraceCount: traceManifest.skippedTraceCount,
    missingFetchCount: traceManifest.missingFetchCount,
    wastedFetchMs: traceManifest.wastedFetchMs,
    maxSnapshotCount: traceManifest.maxSnapshotCount,
    fetchConcurrency: traceManifest.fetchConcurrency,
    backgroundFlushIntervalMs: traceManifest.backgroundFlushIntervalMs,
    backgroundFlushCount: traceManifest.backgroundFlushCount,
    backgroundFlushErrorCount: traceManifest.backgroundFlushErrorCount,
    flushDurationMs: traceManifest.flushDurationMs,
    jaegerApiBaseUrl: traceManifest.jaegerApiBaseUrl,
    artifactDir: traceManifest.artifactDir,
    manifestPath: traceManifest.manifestPath,
    refsSample: sampledRefs,
    nonSavedTracesSample: failedOrMissing.slice(0, 20),
  };
};

const isPriorityTraceRef = (ref) =>
  /create.*field|formula|lookup/i.test(ref?.stepId ?? "") ||
  /\/field\//i.test(ref?.url ?? "");

const buildTraceUrl = (traceId, traceBaseUrl) => {
  if (!traceBaseUrl || !traceId) {
    return "";
  }
  return `${traceBaseUrl.replace(/\/+$/, "")}/trace/${traceId}?uiEmbed=v0`;
};

export const resolvePrimaryTraceUrl = ({
  payload,
  traceManifest,
  traceBaseUrl,
}) => {
  const refs =
    traceManifest?.refs ?? payload.details?.observability?.traces?.refs;
  if (!Array.isArray(refs) || refs.length === 0) {
    return "";
  }

  const savedTraceIds = new Set(
    (Array.isArray(traceManifest?.savedTraces)
      ? traceManifest.savedTraces
      : (payload.details?.observability?.traces?.savedTraces ?? [])
    )
      .filter((trace) => trace?.status === "saved" && trace?.traceId)
      .map((trace) => trace.traceId),
  );
  const availableRefs =
    savedTraceIds.size > 0
      ? refs.filter((ref) => savedTraceIds.has(ref?.traceId))
      : refs;
  const ref =
    availableRefs.find(isPriorityTraceRef) ?? availableRefs[0] ?? refs[0];
  return (
    stringOrUndefined(ref.traceLink) || buildTraceUrl(ref.traceId, traceBaseUrl)
  );
};

export const traceWaste = (payloads) => {
  const byEngine = {};
  let missingCount = 0;
  let wastedMs = 0;
  for (const payload of payloads) {
    const traces = payload.details?.observability?.traces;
    const missing = numberOrUndefined(traces?.missingFetchCount) ?? 0;
    const wastedSum = numberOrUndefined(traces?.wastedFetchMs) ?? 0;
    if (!missing && !wastedSum) {
      continue;
    }
    const concurrency = Math.max(
      numberOrUndefined(traces?.fetchConcurrency) ?? 1,
      1,
    );
    const wasted = wastedSum / concurrency;
    missingCount += missing;
    wastedMs += wasted;
    const bucket = (byEngine[payload.engine] ??= { missing: 0, wastedMs: 0 });
    bucket.missing += missing;
    bucket.wastedMs += wasted;
  }
  return { missingCount, wastedMs, byEngine };
};
