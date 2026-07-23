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

const walkArtifactFiles = async ({ directory, files, include }) => {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkArtifactFiles({ directory: path, files, include });
      continue;
    }
    if (entry.isFile() && include(entry.name)) {
      files.push(path);
    }
  }
};

export const readTraceManifests = async ({ artifactDir }) => {
  const manifestFiles = [];
  await walkArtifactFiles({
    directory: artifactDir,
    files: manifestFiles,
    include: (name) => name === "manifest.json",
  });
  manifestFiles.sort();
  return Promise.all(
    manifestFiles.map(async (manifestPath) => {
      const fileName = relative(artifactDir, manifestPath);
      return {
        manifest: await readJsonFile(manifestPath),
        manifestPath,
        fileName,
        artifactName: artifactNameFromPayloadPath(fileName),
      };
    }),
  );
};

export const readSeedCacheStatuses = async ({ artifactDir }) => {
  const statusFiles = [];
  await walkArtifactFiles({
    directory: artifactDir,
    files: statusFiles,
    include: (name) =>
      name.startsWith("seed-cache-status-") && name.endsWith(".json"),
  });
  statusFiles.sort();
  return Promise.all(
    statusFiles.map(async (statusPath) => {
      const fileName = relative(artifactDir, statusPath);
      return {
        status: await readJsonFile(statusPath),
        statusPath,
        fileName,
        artifactName: artifactNameFromPayloadPath(fileName),
      };
    }),
  );
};

const seedIdentityPath = (segments) =>
  segments.reduce(
    (result, segment) =>
      typeof segment === "number"
        ? `${result}[${segment}]`
        : result
          ? `${result}.${segment}`
          : segment,
    "",
  );

const collectSeedCacheIdentities = (value, path, identities) => {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectSeedCacheIdentities(item, [...path, index], identities),
    );
    return;
  }

  if (typeof value.seedHash === "string" && value.seedHash.trim()) {
    const seedHash = value.seedHash.trim();
    const seedAffinity =
      typeof value.seedAffinity === "string" && value.seedAffinity.trim()
        ? value.seedAffinity.trim()
        : undefined;
    const existing = identities.get(seedHash);
    if (
      existing?.seedAffinity &&
      seedAffinity &&
      existing.seedAffinity !== seedAffinity
    ) {
      const error = new Error(
        `Seed ${seedHash} reports conflicting affinities: ${existing.seedAffinity}, ${seedAffinity}.`,
      );
      error.seedHash = seedHash;
      error.artifactAffinities = [existing.seedAffinity, seedAffinity].sort();
      throw error;
    }
    const cacheHit =
      typeof value.cacheHit === "boolean" ? value.cacheHit : undefined;
    identities.set(seedHash, {
      seedHash,
      ...(existing?.seedAffinity || seedAffinity
        ? { seedAffinity: existing?.seedAffinity ?? seedAffinity }
        : {}),
      ...(existing?.cacheHit != null || cacheHit != null
        ? { cacheHit: (existing?.cacheHit ?? true) && (cacheHit ?? true) }
        : {}),
      paths: [...(existing?.paths ?? []), seedIdentityPath(path)].sort(),
    });
  }

  for (const [key, child] of Object.entries(value)) {
    collectSeedCacheIdentities(child, [...path, key], identities);
  }
};

export const extractSeedCacheIdentities = (payload) => {
  const identities = new Map();
  collectSeedCacheIdentities(payload, [], identities);
  return [...identities.values()].sort((left, right) =>
    left.seedHash.localeCompare(right.seedHash),
  );
};

export const seedShardFromArtifactEntry = ({ artifactName, fileName }) => {
  const source = `${artifactName ?? ""}/${fileName ?? ""}`;
  return /seed-(shard-\d+-of-\d+)(?:-|\/)/.exec(source)?.[1];
};

const normalizeAffinityIndex = (affinityByCaseId) => {
  if (affinityByCaseId instanceof Map) {
    return affinityByCaseId;
  }
  if (!affinityByCaseId || typeof affinityByCaseId !== "object") {
    return new Map();
  }
  return new Map(Object.entries(affinityByCaseId));
};

export const buildSeedObservationReport = ({
  payloadEntries,
  affinityByCaseId,
}) => {
  const affinityIndex = normalizeAffinityIndex(affinityByCaseId);
  const observations = [];
  const issues = [];

  for (const entry of payloadEntries) {
    const { payload } = entry;
    if (payload.engine !== "seed") {
      continue;
    }
    const shard = seedShardFromArtifactEntry(entry);
    if (!shard) {
      issues.push({
        issue: "unresolved-seed-shard",
        caseId: payload.caseId,
        fileName: entry.fileName,
      });
      continue;
    }
    let identities;
    try {
      identities = extractSeedCacheIdentities(payload);
    } catch (error) {
      issues.push({
        issue: "conflicting-artifact-seed-affinities",
        caseId: payload.caseId,
        shard,
        ...(error?.seedHash ? { seedHash: error.seedHash } : {}),
        ...(error?.artifactAffinities
          ? { artifactAffinities: error.artifactAffinities }
          : {}),
        fileName: entry.fileName,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (identities.length === 0) {
      continue;
    }
    const declaredAffinity = affinityIndex.get(payload.caseId);
    for (const identity of identities) {
      if (!declaredAffinity && identity.seedAffinity) {
        issues.push({
          issue: "artifact-affinity-without-declaration",
          caseId: payload.caseId,
          shard,
          seedHash: identity.seedHash,
          artifactAffinity: identity.seedAffinity,
        });
      }
      if (
        declaredAffinity &&
        identity.seedAffinity &&
        declaredAffinity !== identity.seedAffinity
      ) {
        issues.push({
          issue: "declared-artifact-affinity-mismatch",
          caseId: payload.caseId,
          shard,
          seedHash: identity.seedHash,
          declaredAffinity,
          artifactAffinity: identity.seedAffinity,
        });
      }
      observations.push({
        caseId: payload.caseId,
        shard,
        seedHash: identity.seedHash,
        ...(declaredAffinity ? { affinityId: declaredAffinity } : {}),
        buildMs:
          identity.cacheHit === true
            ? 0
            : (numberOrUndefined(payload.durationMs) ?? 0),
        ...(identity.cacheHit != null ? { cacheHit: identity.cacheHit } : {}),
        paths: identity.paths,
      });
    }
  }

  return { observations, issues, payloadEntries };
};

export const readSeedObservationReport = async ({
  artifactDir,
  affinityByCaseId,
}) =>
  buildSeedObservationReport({
    payloadEntries: await readArtifactPayloads({
      artifactDir,
      allowEmpty: true,
    }),
    affinityByCaseId,
  });

const renderSeedObservationIssue = (issue) => {
  if (issue.issue === "artifact-affinity-without-declaration") {
    return `Seed affinity drift for ${issue.caseId}: artifact reports ${issue.artifactAffinity} but the planner has no declaration (seed ${issue.seedHash}, ${issue.shard}).`;
  }
  if (issue.issue === "declared-artifact-affinity-mismatch") {
    return `Seed affinity drift for ${issue.caseId}: declared ${issue.declaredAffinity}, artifact ${issue.artifactAffinity} (seed ${issue.seedHash}, ${issue.shard}).`;
  }
  if (issue.issue === "unresolved-seed-shard") {
    return `Cannot resolve seed shard for ${issue.fileName || issue.caseId}.`;
  }
  return issue.message ?? `Invalid seed identity evidence for ${issue.caseId}.`;
};

export const readSeedObservations = async (options) => {
  const report = await readSeedObservationReport(options);
  if (report.issues.length > 0) {
    const error = new Error(renderSeedObservationIssue(report.issues[0]));
    error.seedAffinityIssues = report.issues;
    throw error;
  }
  return report.observations;
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
  await walkArtifactFiles({
    directory: artifactDir,
    files: payloadFiles,
    include: (name) => name.endsWith(".json") && name !== "manifest.json",
  });
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

export const summarizeSeedPayloadCoverage = ({
  payloadEntries,
  expectedCaseIds,
}) => {
  if (!Array.isArray(payloadEntries) || !Array.isArray(expectedCaseIds)) {
    throw new Error("Seed payload coverage requires payload and case arrays.");
  }
  const expected = new Set(expectedCaseIds);
  if (expected.size !== expectedCaseIds.length) {
    throw new Error("Expected seed case ids must be unique.");
  }
  const counts = new Map();
  for (const { payload } of payloadEntries) {
    if (payload?.engine !== "seed" || typeof payload.caseId !== "string") {
      continue;
    }
    counts.set(payload.caseId, (counts.get(payload.caseId) ?? 0) + 1);
  }
  const observed = new Set(counts.keys());
  const missingCaseIds = [...expected]
    .filter((caseId) => !observed.has(caseId))
    .sort();
  const unexpectedCaseIds = [...observed]
    .filter((caseId) => !expected.has(caseId))
    .sort();
  const duplicateCaseIds = [...counts]
    .filter(([, count]) => count > 1)
    .map(([caseId]) => caseId)
    .sort();
  return {
    expectedCaseCount: expected.size,
    observedCaseCount: observed.size,
    missingCaseIds,
    unexpectedCaseIds,
    duplicateCaseIds,
    complete:
      missingCaseIds.length === 0 &&
      unexpectedCaseIds.length === 0 &&
      duplicateCaseIds.length === 0,
  };
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
        requestBodyShape: ref?.requestBodyShape,
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
    traceFetchCaseBudgetMs: traceManifest.traceFetchCaseBudgetMs,
    traceFetchJobBudgetMs: traceManifest.traceFetchJobBudgetMs,
    traceFetchWaitMs: traceManifest.traceFetchWaitMs,
    traceFetchJobWaitMs: traceManifest.traceFetchJobWaitMs,
    traceFetchBreakerState: traceManifest.traceFetchBreakerState,
    traceFetchBreakerReason: traceManifest.traceFetchBreakerReason,
    traceFetchRecoveryProbeCount: traceManifest.traceFetchRecoveryProbeCount,
    traceFetchRecoverySucceeded: traceManifest.traceFetchRecoverySucceeded,
    maxSnapshotCount: traceManifest.maxSnapshotCount,
    fetchConcurrency: traceManifest.fetchConcurrency,
    backgroundFlushIntervalMs: traceManifest.backgroundFlushIntervalMs,
    backgroundFlushCount: traceManifest.backgroundFlushCount,
    backgroundFlushErrorCount: traceManifest.backgroundFlushErrorCount,
    flushDurationMs: traceManifest.flushDurationMs,
    flushError: traceManifest.flushError,
    traceFetchSkippedReason: traceManifest.traceFetchSkippedReason,
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

export const traceServiceOutage = (payloads) => {
  const byEngine = {};
  let skippedFetchCount = 0;
  for (const payload of payloads) {
    const traces = payload.details?.observability?.traces;
    if (!traces?.traceFetchSkippedReason) {
      continue;
    }

    const skipped =
      numberOrUndefined(traces.selectedTraceCount) ??
      numberOrUndefined(traces.traceRefCount) ??
      0;
    skippedFetchCount += skipped;
    const bucket = (byEngine[payload.engine] ??= {
      skippedFetchCount: 0,
      reason: traces.traceFetchSkippedReason,
    });
    bucket.skippedFetchCount += skipped;
  }
  return { skippedFetchCount, byEngine };
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
