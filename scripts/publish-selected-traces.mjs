#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeSegment } from "../framework/artifact-names.js";
import { runWithConcurrency } from "../framework/concurrency.ts";
import { buildSummaryMarkdown } from "../framework/artifacts.ts";
import { writeFileAtomically as writeFileAtomicallyShared } from "../framework/atomic-file.js";
import { requiredEnv } from "./env.mjs";
import { sleep as delay } from "../framework/sleep.js";

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const positiveInteger = (value, fallback, label) => {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
};

const findFiles = async (root, fileName) => {
  const matches = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name === fileName) {
        matches.push(path);
      }
    }
  };
  await visit(root);
  return matches.sort();
};

// Keep the parent-directory creation this script needs, but delegate the atomic
// write itself to framework/atomic-file.js. The local copy used a
// pid+timestamp temp name and left the temp file behind when the rename failed.
const writeFileAtomically = async (path, contents) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomicallyShared(path, contents);
};

// Jaeger-format snapshot naming has exactly one owner across the two producers.
// framework/trace-collector.ts wrote `<stepId>-<traceId>.json` next to the
// manifest back when execute jobs fetched their own traces. The report job now
// owns that fetch, so it writes the same file name at the same path: a snapshot
// is droppable into any Jaeger UI regardless of which job produced it, and
// `savedTraces[].path` keeps meaning "this file exists in the artifact".
const snapshotFileName = (ref) =>
  `${sanitizeSegment(ref.stepId)}-${ref.traceId}.json`;

const snapshotRelativePath = (manifest, ref) =>
  manifest.artifactDir ? join(manifest.artifactDir, snapshotFileName(ref)) : "";

// Resolve which manifest owns each selected trace before any fetch runs, so a
// fetched trace can be written to disk and dropped from memory immediately.
// Retaining every `/api/traces` response until reconciliation meant holding a
// full run's traces (~400 MB of JSON, over a gigabyte once parsed) in one heap.
const loadManifestOwners = async (artifactDir) => {
  const manifestFiles = await findFiles(artifactDir, "manifest.json");
  const ownerByTraceId = new Map();
  for (const manifestFile of manifestFiles) {
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    const selectedTraceIds = new Set(manifest.selectedTraceIds ?? []);
    for (const ref of manifest.refs ?? []) {
      // The first ref for a trace owns its outcome in buildPublishedTraceSummary;
      // keep the snapshot file name on that same ref.
      if (!selectedTraceIds.has(ref.traceId) || ownerByTraceId.has(ref.traceId)) {
        continue;
      }
      ownerByTraceId.set(ref.traceId, {
        snapshotPath: join(dirname(manifestFile), snapshotFileName(ref)),
      });
    }
  }
  return { manifestFiles, ownerByTraceId };
};

const traceIdsAndSpanCount = (payload) => {
  const traceIds = new Set();
  let spanCount = 0;
  for (const resourceSpans of payload?.resourceSpans ?? []) {
    for (const scopeSpans of resourceSpans?.scopeSpans ?? []) {
      for (const span of scopeSpans?.spans ?? []) {
        if (typeof span?.traceId === "string") {
          traceIds.add(span.traceId);
        }
        spanCount += 1;
      }
    }
  }
  return { traceIds: [...traceIds], spanCount };
};

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));

const buildScopePayload = ({ resourceSpans, scopeSpans, spans }) => ({
  resourceSpans: [
    {
      ...resourceSpans,
      scopeSpans: [
        {
          ...scopeSpans,
          spans,
        },
      ],
    },
  ],
});

const splitScopeSpans = ({
  resourceSpans,
  scopeSpans,
  maxRequestBytes,
  traceId,
}) => {
  const spans = scopeSpans?.spans ?? [];
  const chunks = [];
  let start = 0;
  while (start < spans.length) {
    let low = start + 1;
    let high = spans.length;
    let acceptedEnd = start;
    let acceptedPayload;
    let acceptedBody;
    while (low <= high) {
      const end = Math.floor((low + high) / 2);
      const payload = buildScopePayload({
        resourceSpans,
        scopeSpans,
        spans: spans.slice(start, end),
      });
      const body = JSON.stringify(payload);
      if (Buffer.byteLength(body) <= maxRequestBytes) {
        acceptedEnd = end;
        acceptedPayload = payload;
        acceptedBody = body;
        low = end + 1;
      } else {
        high = end - 1;
      }
    }
    if (acceptedEnd === start) {
      const singleSpanBytes = jsonBytes(
        buildScopePayload({
          resourceSpans,
          scopeSpans,
          spans: spans.slice(start, start + 1),
        }),
      );
      throw new Error(
        `Trace ${traceId} contains a single span that exceeds the ${maxRequestBytes}-byte OTLP request limit (${singleSpanBytes} bytes).`,
      );
    }
    chunks.push({
      payload: acceptedPayload,
      body: acceptedBody,
      spanCount: acceptedEnd - start,
    });
    start = acceptedEnd;
  }
  return chunks;
};

export const splitSelectedTracePayload = (selected, maxRequestBytes) => {
  if (Buffer.byteLength(selected.body) <= maxRequestBytes) {
    return [{ ...selected, chunkIndex: 0, chunkCount: 1 }];
  }
  const chunks = [];
  for (const resourceSpans of selected.payload?.resourceSpans ?? []) {
    for (const scopeSpans of resourceSpans?.scopeSpans ?? []) {
      chunks.push(
        ...splitScopeSpans({
          resourceSpans,
          scopeSpans,
          maxRequestBytes,
          traceId: selected.traceId,
        }),
      );
    }
  }
  if (chunks.length === 0) {
    throw new Error(
      `Trace ${selected.traceId} exceeds the OTLP request limit but contains no spans to split.`,
    );
  }
  return chunks.map((chunk, chunkIndex) => ({
    ...selected,
    ...chunk,
    chunkIndex,
    chunkCount: chunks.length,
  }));
};

const loadSelectedPayloads = async (artifactDir) => {
  const payloads = new Map();
  for (const path of await findFiles(
    artifactDir,
    "selected-traces.otlp.jsonl",
  )) {
    for (const [index, line] of (await readFile(path, "utf8"))
      .split(/\r?\n/)
      .entries()) {
      if (!line.trim()) {
        continue;
      }
      const payload = JSON.parse(line);
      const { traceIds, spanCount } = traceIdsAndSpanCount(payload);
      if (traceIds.length !== 1) {
        throw new Error(
          `${path}:${index + 1} must contain exactly one trace id; received ${traceIds.join(",") || "none"}.`,
        );
      }
      const traceId = traceIds[0];
      if (payloads.has(traceId)) {
        throw new Error(
          `Selected trace ${traceId} occurs in multiple artifacts.`,
        );
      }
      payloads.set(traceId, {
        traceId,
        spanCount,
        payload,
        body: line,
        sourcePath: path,
      });
    }
  }
  return payloads;
};

const postTrace = async ({ endpoint, selected, attempts = 3 }) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: selected.body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(
          `OTLP HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
        );
      }
      return { attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < attempts) {
        await delay(250 * 2 ** (attempt - 1));
      }
    }
  }
  throw new Error(
    `Failed to publish trace ${selected.traceId}: ${lastError?.message ?? "unknown error"}`,
  );
};

const publishSequentially = async ({
  endpoint,
  selectedPayloads,
  intervalMs,
  maxRequestBytes,
}) => {
  const startedAt = Date.now();
  let requestCount = 0;
  let spanCount = 0;
  for (const selected of selectedPayloads) {
    const chunks = splitSelectedTracePayload(selected, maxRequestBytes);
    for (const chunk of chunks) {
      await postTrace({ endpoint, selected: chunk });
      requestCount += 1;
      if (intervalMs > 0) {
        await delay(intervalMs);
      }
    }
    spanCount += selected.spanCount;
  }
  return {
    traceCount: selectedPayloads.length,
    requestCount,
    spanCount,
    durationMs: Date.now() - startedAt,
  };
};

const fetchJaegerTrace = async ({ jaegerApiBaseUrl, traceId, timeoutMs }) => {
  const startedAt = Date.now();
  let attempts = 0;
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    try {
      const response = await fetch(
        `${jaegerApiBaseUrl.replace(/\/+$/, "")}/api/traces/${traceId}`,
        { signal: AbortSignal.timeout(Math.min(5_000, timeoutMs)) },
      );
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data?.data) && data.data.length > 0) {
          return {
            status: "saved",
            traceId,
            data,
            attempts,
            durationMs: Date.now() - startedAt,
          };
        }
      } else if (response.status !== 404) {
        lastError = `Jaeger HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs > 0) {
      await delay(Math.min(500 * 2 ** Math.min(attempts - 1, 3), remainingMs));
    }
  }
  return {
    status: "missing",
    traceId,
    error: lastError || `Trace was not visible in Jaeger after ${timeoutMs}ms`,
    attempts,
    durationMs: Date.now() - startedAt,
  };
};

// Write the Jaeger-format trace next to its manifest and return an outcome with
// the response body dropped. The snapshot is what makes the report-local Jaeger
// worth starting: the container dies with the job, the artifact does not.
const fetchAndSnapshotTrace = async ({
  jaegerApiBaseUrl,
  traceId,
  timeoutMs,
  ownerByTraceId,
  snapshots,
}) => {
  const outcome = await fetchJaegerTrace({
    jaegerApiBaseUrl,
    traceId,
    timeoutMs,
  });
  if (outcome.status !== "saved") {
    return outcome;
  }

  const { data, ...retained } = outcome;
  const owner = ownerByTraceId.get(traceId);
  if (!owner) {
    return retained;
  }

  const contents = `${JSON.stringify(data, null, 2)}\n`;
  await writeFileAtomically(owner.snapshotPath, contents);
  snapshots.count += 1;
  snapshots.bytes += Buffer.byteLength(contents);
  return retained;
};

export const buildPublishedTraceSummary = ({
  manifest,
  outcomesByTraceId,
  publishByTraceId,
  fetchJobWaitMs,
}) => {
  const selectedTraceIds = new Set(manifest.selectedTraceIds ?? []);
  const seenTraceIds = new Set();
  const savedTraces = [];
  let savedTraceCount = 0;
  let failedTraceCount = 0;
  let skippedTraceCount = 0;
  let wastedFetchMs = 0;
  let maxFetchMs = 0;
  let publishedSpanCount = 0;

  for (const ref of manifest.refs ?? []) {
    if (!selectedTraceIds.has(ref.traceId) || seenTraceIds.has(ref.traceId)) {
      skippedTraceCount += 1;
      savedTraces.push({
        traceId: ref.traceId,
        stepId: ref.stepId,
        path: "",
        status: "skipped",
        error: seenTraceIds.has(ref.traceId)
          ? `Duplicate captured trace ref ${ref.traceId}; the first ref owns its publication outcome`
          : "Trace was not selected for report Jaeger publication",
        sampled: ref.sampled,
      });
      continue;
    }
    seenTraceIds.add(ref.traceId);
    const outcome = outcomesByTraceId.get(ref.traceId);
    const published = publishByTraceId.get(ref.traceId);
    publishedSpanCount += published?.spanCount ?? 0;
    maxFetchMs = Math.max(maxFetchMs, outcome?.durationMs ?? 0);
    if (outcome?.status === "saved") {
      savedTraceCount += 1;
      savedTraces.push({
        traceId: ref.traceId,
        stepId: ref.stepId,
        path: snapshotRelativePath(manifest, ref),
        status: "saved",
        attempts: outcome.attempts,
        durationMs: outcome.durationMs,
        sampled: ref.sampled,
      });
    } else {
      failedTraceCount += 1;
      wastedFetchMs += outcome?.durationMs ?? 0;
      savedTraces.push({
        traceId: ref.traceId,
        stepId: ref.stepId,
        path: "",
        status: "missing",
        error: outcome?.error ?? "Selected trace was not published",
        attempts: outcome?.attempts ?? 0,
        durationMs: outcome?.durationMs ?? 0,
        sampled: ref.sampled,
      });
    }
  }

  return {
    ...manifest,
    selectedTraceCount: selectedTraceIds.size,
    savedTraceCount,
    failedTraceCount,
    skippedTraceCount,
    missingFetchCount: failedTraceCount,
    wastedFetchMs,
    // Do NOT overwrite traceFetchWaitMs / traceFetchJobWaitMs here. Those are
    // the execute job's own trace-fetch measurements, and they are what
    // PERF_LAB_TRACE_CASE_BUDGET_MS / PERF_LAB_TRACE_JOB_BUDGET_MS bound. This
    // is the single report job, so writing its elapsed time into every case's
    // manifest replaced 21 independent per-job measurements with one number and
    // then had acceptance check that number against a per-job budget. The
    // report job's publish time scales with the total trace count, so the gate
    // went red as the suite grew rather than when anything was wrong.
    sharedPublishWaitMs: fetchJobWaitMs,
    sharedPublishMaxTraceMs: maxFetchMs,
    traceFetchBreakerState: failedTraceCount === 0 ? "closed" : "partial-loss",
    traceFetchBreakerReason:
      failedTraceCount === 0
        ? undefined
        : `${failedTraceCount} selected traces were missing after serialized publication`,
    traceFetchRecoveryProbeCount: 0,
    traceFetchRecoverySucceeded: false,
    traceFetchSkippedReason: undefined,
    sharedPublishTraceCount: selectedTraceIds.size,
    sharedPublishSpanCount: publishedSpanCount,
    savedTraces,
  };
};

const findPayloadForManifest = async ({ artifactRoot, manifestPath }) => {
  for (const entry of await readdir(artifactRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const path = join(artifactRoot, entry.name);
    const payload = JSON.parse(await readFile(path, "utf8"));
    if (
      payload?.details?.observability?.traces?.manifestPath === manifestPath
    ) {
      return { path, payload };
    }
  }
  throw new Error(
    `No perf payload references trace manifest ${manifestPath} under ${artifactRoot}.`,
  );
};

const reconcileManifest = async ({
  manifestFile,
  outcomesByTraceId,
  publishByTraceId,
  fetchJobWaitMs,
}) => {
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const updated = buildPublishedTraceSummary({
    manifest,
    outcomesByTraceId,
    publishByTraceId,
    fetchJobWaitMs,
  });
  const artifactRoot = resolve(dirname(manifestFile), "../..");
  const payloadEntry = await findPayloadForManifest({
    artifactRoot,
    manifestPath: manifest.manifestPath,
  });

  const payload = payloadEntry.payload;
  payload.details.observability.traces = updated;
  await Promise.all([
    writeFileAtomically(manifestFile, `${JSON.stringify(updated, null, 2)}\n`),
    writeFileAtomically(
      payloadEntry.path,
      `${JSON.stringify(payload, null, 2)}\n`,
    ),
    writeFileAtomically(
      join(
        artifactRoot,
        `summary-${sanitizeSegment(payload.caseId)}-${sanitizeSegment(payload.engine)}.md`,
      ),
      buildSummaryMarkdown(payload),
    ),
  ]);
  return updated;
};

export const publishAndReconcileSelectedTraces = async ({
  artifactDir,
  endpoint,
  jaegerApiBaseUrl,
  outputPath,
  intervalMs,
  maxRequestBytes = 1_000_000,
  settleMs,
  fetchTimeoutMs,
  fetchConcurrency,
}) => {
  const publishByTraceId = await loadSelectedPayloads(artifactDir);
  const { manifestFiles, ownerByTraceId } =
    await loadManifestOwners(artifactDir);
  const snapshots = { count: 0, bytes: 0 };
  const selectedPayloads = [...publishByTraceId.values()].sort((left, right) =>
    left.traceId.localeCompare(right.traceId),
  );
  const initialPublish = await publishSequentially({
    endpoint,
    selectedPayloads,
    intervalMs,
    maxRequestBytes,
  });
  await delay(settleMs);

  const fetchStartedAt = Date.now();
  const fetchOutcomes = await runWithConcurrency(
    selectedPayloads,
    fetchConcurrency,
    ({ traceId }) =>
      fetchAndSnapshotTrace({
        jaegerApiBaseUrl,
        traceId,
        timeoutMs: fetchTimeoutMs,
        ownerByTraceId,
        snapshots,
      }),
  );
  const outcomesByTraceId = new Map(
    fetchOutcomes.map((outcome) => [outcome.traceId, outcome]),
  );
  const initiallyMissing = selectedPayloads.filter(
    ({ traceId }) => outcomesByTraceId.get(traceId)?.status !== "saved",
  );

  let recoveryPublish = {
    traceCount: 0,
    requestCount: 0,
    spanCount: 0,
    durationMs: 0,
  };
  if (initiallyMissing.length > 0) {
    recoveryPublish = await publishSequentially({
      endpoint,
      selectedPayloads: initiallyMissing,
      intervalMs,
      maxRequestBytes,
    });
    await delay(Math.min(settleMs, 3_000));
    const recovered = await runWithConcurrency(
      initiallyMissing,
      fetchConcurrency,
      ({ traceId }) =>
        fetchAndSnapshotTrace({
          jaegerApiBaseUrl,
          traceId,
          timeoutMs: fetchTimeoutMs,
          ownerByTraceId,
          snapshots,
        }),
    );
    for (const outcome of recovered) {
      outcomesByTraceId.set(outcome.traceId, outcome);
    }
  }
  const fetchJobWaitMs = Date.now() - fetchStartedAt;
  const manifests = [];
  for (const manifestFile of manifestFiles) {
    manifests.push(
      await reconcileManifest({
        manifestFile,
        outcomesByTraceId,
        publishByTraceId,
        fetchJobWaitMs,
      }),
    );
  }

  const missingTraceIds = selectedPayloads
    .filter(({ traceId }) => outcomesByTraceId.get(traceId)?.status !== "saved")
    .map(({ traceId }) => traceId);
  const summary = {
    selectedTraceCount: selectedPayloads.length,
    publishedTraceCount: initialPublish.traceCount,
    publishedSpanCount: initialPublish.spanCount,
    publishRequestCount:
      initialPublish.requestCount + recoveryPublish.requestCount,
    publishDurationMs: initialPublish.durationMs + recoveryPublish.durationMs,
    publishIntervalMs: intervalMs,
    maxRequestBytes,
    recoveryPublishTraceCount: recoveryPublish.traceCount,
    fetchDurationMs: fetchJobWaitMs,
    manifestCount: manifests.length,
    savedTraceCount: selectedPayloads.length - missingTraceIds.length,
    snapshotTraceCount: snapshots.count,
    snapshotBytes: snapshots.bytes,
    missingTraceCount: missingTraceIds.length,
    missingTraceIds,
  };
  await writeFileAtomically(
    outputPath,
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  if (missingTraceIds.length > 0) {
    throw new Error(
      `${missingTraceIds.length}/${selectedPayloads.length} selected traces were missing from the report-local Jaeger after recovery publication.`,
    );
  }
  return summary;
};

const main = async () => {
  const summary = await publishAndReconcileSelectedTraces({
    artifactDir: resolve(requiredEnv("PERF_LAB_ARTIFACT_DIR")),
    endpoint: requiredEnv("PERF_LAB_OTEL_UPSTREAM_ENDPOINT"),
    jaegerApiBaseUrl: requiredEnv("PERF_LAB_JAEGER_API_BASE_URL"),
    outputPath: resolve(requiredEnv("PERF_LAB_TRACE_PUBLISH_SUMMARY_PATH")),
    intervalMs: positiveInteger(
      process.env.PERF_LAB_TRACE_PUBLISH_INTERVAL_MS,
      50,
      "PERF_LAB_TRACE_PUBLISH_INTERVAL_MS",
    ),
    maxRequestBytes: positiveInteger(
      process.env.PERF_LAB_TRACE_PUBLISH_MAX_REQUEST_BYTES,
      1_000_000,
      "PERF_LAB_TRACE_PUBLISH_MAX_REQUEST_BYTES",
    ),
    settleMs: positiveInteger(
      process.env.PERF_LAB_TRACE_PUBLISH_SETTLE_MS,
      5_000,
      "PERF_LAB_TRACE_PUBLISH_SETTLE_MS",
    ),
    fetchTimeoutMs: positiveInteger(
      process.env.PERF_LAB_TRACE_FETCH_TIMEOUT_MS,
      10_000,
      "PERF_LAB_TRACE_FETCH_TIMEOUT_MS",
    ),
    fetchConcurrency: positiveInteger(
      process.env.PERF_LAB_TRACE_FETCH_CONCURRENCY,
      4,
      "PERF_LAB_TRACE_FETCH_CONCURRENCY",
    ),
  });
  console.log(
    `Published ${summary.savedTraceCount}/${summary.selectedTraceCount} selected traces (${summary.publishedSpanCount} spans) through ${summary.publishRequestCount} serialized OTLP requests, and stored ${summary.snapshotTraceCount} Jaeger snapshots (${summary.snapshotBytes} bytes).`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "## Report-local Jaeger selected-trace publication",
        "",
        `- traces: ${summary.savedTraceCount}/${summary.selectedTraceCount}`,
        `- spans: ${summary.publishedSpanCount}`,
        `- serialized requests: ${summary.publishRequestCount}`,
        `- publish duration: ${summary.publishDurationMs} ms`,
        `- verification duration: ${summary.fetchDurationMs} ms`,
        `- Jaeger snapshots: ${summary.snapshotTraceCount} (${summary.snapshotBytes} bytes)`,
        `- summary: \`${relative(process.cwd(), requiredEnv("PERF_LAB_TRACE_PUBLISH_SUMMARY_PATH"))}\``,
        "",
      ].join("\n"),
      { flag: "a" },
    );
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
