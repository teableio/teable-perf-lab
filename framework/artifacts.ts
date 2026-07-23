import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomically } from "./atomic-file.js";
import type { PerfTraceArtifactSummary } from "./trace-collector";
import type { TraceFetchArtifactState } from "./trace-fetch-control";
import type { MetricThreshold, PerfCase, PerfRunResult } from "./types";

export interface PerfArtifactPayload {
  caseId: string;
  title: string;
  runId: string;
  engine: string;
  appUrl: string;
  result: "pass" | "fail" | "skipped";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  metrics: Record<string, number>;
  thresholds: Array<
    MetricThreshold & { passed: boolean; actual: number | null }
  >;
  phases?: PerfRunResult["phases"];
  details?: PerfRunResult["details"];
  error?: {
    name?: string;
    message: string;
    stack?: string;
  };
}

const sanitizeCaseId = (caseId: string) =>
  caseId.replace(/[^a-zA-Z0-9_.-]+/g, "-");

const sanitizeSegment = (value: string) =>
  value.replace(/[^a-zA-Z0-9_.-]+/g, "-");

export const getArtifactJsonName = (caseId: string, engine: string) =>
  `${sanitizeCaseId(caseId)}-${sanitizeSegment(engine)}.json`;

export const getSummaryMarkdownName = (caseId: string, engine: string) =>
  `summary-${sanitizeCaseId(caseId)}-${sanitizeSegment(engine)}.md`;

export const buildSummaryMarkdown = (payload: PerfArtifactPayload) => {
  const lines = [
    `# Perf lab summary: ${payload.caseId}`,
    "",
    `Result: **${payload.result}**`,
    "",
    `Engine: \`${payload.engine}\``,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| duration | ${payload.durationMs} ms |`,
    ...Object.entries(payload.metrics).map(
      ([metric, value]) => `| ${metric} | ${value} |`,
    ),
  ];

  if (payload.thresholds.length > 0) {
    lines.push(
      "",
      "| Threshold | Actual | Max | Result |",
      "| --- | ---: | ---: | --- |",
    );
    payload.thresholds.forEach((threshold) => {
      lines.push(
        `| ${threshold.metric} | ${threshold.actual ?? "n/a"} ${threshold.unit} | ${threshold.max} ${threshold.unit} | ${
          threshold.passed ? "pass" : "fail"
        } |`,
      );
    });
  }

  if (payload.phases?.length) {
    lines.push("", "| Phase | Duration |", "| --- | ---: |");
    payload.phases.forEach((phase) => {
      lines.push(`| ${phase.name} | ${phase.durationMs} ms |`);
    });
  }

  const traces = (
    payload.details as
      | {
          observability?: {
            traces?: {
              enabled?: boolean;
              traceRefCount?: number;
              uniqueTraceCount?: number;
              selectedTraceCount?: number;
              savedTraceCount?: number;
              failedTraceCount?: number;
              skippedTraceCount?: number;
              missingFetchCount?: number;
              wastedFetchMs?: number;
              traceFetchCaseBudgetMs?: number;
              traceFetchJobBudgetMs?: number;
              traceFetchWaitMs?: number;
              traceFetchJobWaitMs?: number;
              traceFetchBreakerState?: TraceFetchArtifactState;
              traceFetchBreakerReason?: string;
              traceFetchRecoveryProbeCount?: number;
              traceFetchRecoverySucceeded?: boolean;
              maxSnapshotCount?: number;
              fetchConcurrency?: number;
              backgroundFlushIntervalMs?: number;
              backgroundFlushCount?: number;
              backgroundFlushErrorCount?: number;
              backgroundFlushLastError?: string;
              flushDurationMs?: number;
              flushError?: string;
              traceFetchSkippedReason?: string;
              manifestPath?: string;
              artifactDir?: string;
              refs?: Array<{ traceLink?: string; traceId?: string }>;
              savedTraces?: Array<{ traceId?: string; status?: string }>;
            };
          };
        }
      | undefined
  )?.observability?.traces;

  if (traces) {
    lines.push(
      "",
      "| Trace Artifact | Value |",
      "| --- | ---: |",
      `| enabled | ${String(traces.enabled)} |`,
      `| captured refs | ${traces.traceRefCount ?? 0} |`,
      `| unique traces | ${traces.uniqueTraceCount ?? 0} |`,
      `| selected for fetch | ${traces.selectedTraceCount ?? 0} |`,
      `| max JSON snapshots | ${traces.maxSnapshotCount ?? 0} |`,
      `| fetch concurrency | ${traces.fetchConcurrency ?? 0} |`,
      `| OTEL flush duration | ${
        traces.flushDurationMs == null ? "n/a" : `${traces.flushDurationMs} ms`
      } |`,
      `| saved JSON traces | ${traces.savedTraceCount ?? 0} |`,
      `| failed trace fetches | ${traces.failedTraceCount ?? 0} |`,
      `| skipped trace fetches | ${traces.skippedTraceCount ?? 0} |`,
      `| trace fetch budget | case ${traces.traceFetchWaitMs ?? 0}/${
        traces.traceFetchCaseBudgetMs ?? 0
      } ms · job ${traces.traceFetchJobWaitMs ?? 0}/${
        traces.traceFetchJobBudgetMs ?? 0
      } ms |`,
    );
    if (
      traces.traceFetchBreakerState &&
      traces.traceFetchBreakerState !== "closed"
    ) {
      lines.push(
        `| trace fetch breaker | \`${traces.traceFetchBreakerState}\`${
          traces.traceFetchBreakerReason
            ? ` — ${traces.traceFetchBreakerReason}`
            : ""
        } |`,
      );
    }
    if (traces.traceFetchRecoveryProbeCount) {
      lines.push(
        `| trace recovery probes | ${traces.traceFetchRecoveryProbeCount} · ${
          traces.traceFetchRecoverySucceeded ? "recovered" : "not recovered"
        } |`,
      );
    }
    if (traces.missingFetchCount) {
      // wastedFetchMs sums poll time across concurrent lanes; divide by the
      // fetch concurrency to estimate the wall-clock added to the run.
      const wallWastedSeconds = Math.round(
        (traces.wastedFetchMs ?? 0) /
          Math.max(traces.fetchConcurrency ?? 1, 1) /
          1000,
      );
      lines.push(
        `| traces missing in Jaeger | ${traces.missingFetchCount} |`,
        `| wall-clock wasted polling (≈) | ${wallWastedSeconds} s |`,
      );
    }
    lines.push(
      `| background flush interval | ${
        traces.backgroundFlushIntervalMs ?? 0
      } ms |`,
      `| background flushes | ${traces.backgroundFlushCount ?? 0} |`,
    );
    if (traces.backgroundFlushErrorCount) {
      lines.push(
        `| background flush errors | ${traces.backgroundFlushErrorCount} |`,
      );
    }
    if (traces.backgroundFlushLastError) {
      lines.push(
        `| background flush last error | \`${traces.backgroundFlushLastError}\` |`,
      );
    }
    if (traces.flushError) {
      lines.push(`| OTEL flush error | \`${traces.flushError}\` |`);
    }
    if (traces.traceFetchSkippedReason) {
      lines.push(
        `| trace fetch skipped | \`${traces.traceFetchSkippedReason}\` |`,
      );
    }
    if (traces.manifestPath) {
      lines.push(`| manifest | \`${traces.manifestPath}\` |`);
    }
    if (traces.artifactDir) {
      lines.push(`| trace dir | \`${traces.artifactDir}\` |`);
    }
    const savedTraceIds = new Set(
      traces.savedTraces
        ?.filter((trace) => trace.status === "saved" && trace.traceId)
        .map((trace) => trace.traceId),
    );
    const availableRefs =
      savedTraceIds.size > 0
        ? traces.refs?.filter((ref) => savedTraceIds.has(ref.traceId))
        : traces.refs;
    const primaryTrace = availableRefs?.find(
      (ref) => ref.traceLink ?? ref.traceId,
    );
    if (primaryTrace?.traceLink) {
      lines.push(`| primary trace | ${primaryTrace.traceLink} |`);
    }
  }

  lines.push(
    "",
    `App URL: \`${payload.appUrl}\``,
    "",
    `Run ID: \`${payload.runId}\``,
    "",
  );

  if (payload.error) {
    lines.push(`Error: \`${payload.error.message}\``, "");
  }

  return lines.join("\n");
};

const assertWritesSettled = (
  outcomes: PromiseSettledResult<void>[],
  label: string,
) => {
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (failures.length > 0) {
    const reasons = failures
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join("; ");
    throw new AggregateError(failures, `${label}: ${reasons}`);
  }
};

export const writePerfArtifacts = async (
  artifactDir: string | undefined,
  perfCase: PerfCase,
  payload: PerfArtifactPayload,
  writeArtifactFile: PerfArtifactFileWriter = writeFileAtomically,
) => {
  if (!artifactDir) {
    return;
  }

  await mkdir(artifactDir, { recursive: true });
  const summaryMarkdown = buildSummaryMarkdown(payload);
  const outcomes = await Promise.allSettled([
    writeArtifactFile(
      join(artifactDir, getArtifactJsonName(perfCase.id, payload.engine)),
      JSON.stringify(payload, null, 2),
    ),
    writeArtifactFile(
      join(artifactDir, getSummaryMarkdownName(perfCase.id, payload.engine)),
      summaryMarkdown,
    ),
  ]);
  assertWritesSettled(outcomes, "Perf artifact set update failed");
};

type PerfArtifactFileWriter = (path: string, contents: string) => Promise<void>;

const withTraceSummary = (
  payload: PerfArtifactPayload,
  traceSummary: PerfTraceArtifactSummary,
): PerfArtifactPayload => {
  const details = payload.details ?? {};
  const observability =
    details.observability &&
    typeof details.observability === "object" &&
    !Array.isArray(details.observability)
      ? details.observability
      : {};
  return {
    ...payload,
    details: {
      ...details,
      observability: {
        ...observability,
        traces: traceSummary,
      },
    },
  };
};

const writeTraceArtifactSet = async ({
  artifactDir,
  perfCase,
  payload,
  traceSummary,
  writeArtifactFile,
}: {
  artifactDir: string;
  perfCase: PerfCase;
  payload: PerfArtifactPayload;
  traceSummary: PerfTraceArtifactSummary;
  writeArtifactFile: PerfArtifactFileWriter;
}) => {
  const updatedPayload = withTraceSummary(payload, traceSummary);
  const writes = [
    {
      path: join(artifactDir, getArtifactJsonName(perfCase.id, payload.engine)),
      contents: JSON.stringify(updatedPayload, null, 2),
    },
    {
      path: join(
        artifactDir,
        getSummaryMarkdownName(perfCase.id, payload.engine),
      ),
      contents: buildSummaryMarkdown(updatedPayload),
    },
  ];
  if (traceSummary.manifestPath) {
    const manifestPath = join(artifactDir, traceSummary.manifestPath);
    await mkdir(dirname(manifestPath), { recursive: true });
    writes.push({
      path: manifestPath,
      contents: JSON.stringify(traceSummary, null, 2),
    });
  }
  const outcomes = await Promise.allSettled(
    writes.map(({ path, contents }) => writeArtifactFile(path, contents)),
  );
  assertWritesSettled(outcomes, "Trace artifact set update failed");
};

export const updatePerfArtifactTraceSummary = async ({
  artifactDir,
  perfCase,
  engine,
  traceSummary,
  writeArtifactFile = writeFileAtomically,
}: {
  artifactDir?: string;
  perfCase: PerfCase;
  engine: string;
  traceSummary: PerfTraceArtifactSummary;
  writeArtifactFile?: PerfArtifactFileWriter;
}) => {
  if (!artifactDir) {
    return;
  }
  const payloadPath = join(
    artifactDir,
    getArtifactJsonName(perfCase.id, engine),
  );
  const payload = JSON.parse(
    await readFile(payloadPath, "utf8"),
  ) as PerfArtifactPayload;
  if (payload.caseId !== perfCase.id || payload.engine !== engine) {
    throw new Error(
      `Perf artifact identity mismatch at ${payloadPath}: expected ${perfCase.id}/${engine}, received ${payload.caseId}/${payload.engine}`,
    );
  }
  try {
    await writeTraceArtifactSet({
      artifactDir,
      perfCase,
      payload,
      traceSummary,
      writeArtifactFile,
    });
    return traceSummary;
  } catch (error) {
    const reason = `Trace artifact reconciliation failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    const tailErrorSummary: PerfTraceArtifactSummary = {
      ...traceSummary,
      traceFetchBreakerState: "tail-error",
      traceFetchBreakerReason: reason,
    };
    try {
      await writeTraceArtifactSet({
        artifactDir,
        perfCase,
        payload,
        traceSummary: tailErrorSummary,
        writeArtifactFile,
      });
    } catch (fallbackError) {
      throw new AggregateError(
        [error, fallbackError],
        `${reason}; tail-error artifact reconciliation also failed`,
      );
    }
    return tailErrorSummary;
  }
};
