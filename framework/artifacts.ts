import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
              maxSnapshotCount?: number;
              fetchConcurrency?: number;
              flushDurationMs?: number;
              flushError?: string;
              manifestPath?: string;
              artifactDir?: string;
              refs?: Array<{ traceLink?: string; traceId?: string }>;
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
    );
    if (traces.flushError) {
      lines.push(`| OTEL flush error | \`${traces.flushError}\` |`);
    }
    if (traces.manifestPath) {
      lines.push(`| manifest | \`${traces.manifestPath}\` |`);
    }
    if (traces.artifactDir) {
      lines.push(`| trace dir | \`${traces.artifactDir}\` |`);
    }
    const primaryTrace = traces.refs?.find(
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

export const writePerfArtifacts = async (
  artifactDir: string | undefined,
  perfCase: PerfCase,
  payload: PerfArtifactPayload,
) => {
  if (!artifactDir) {
    return;
  }

  await mkdir(artifactDir, { recursive: true });
  const summaryMarkdown = buildSummaryMarkdown(payload);
  await writeFile(
    join(artifactDir, getArtifactJsonName(perfCase.id, payload.engine)),
    JSON.stringify(payload, null, 2),
  );
  await writeFile(
    join(artifactDir, getSummaryMarkdownName(perfCase.id, payload.engine)),
    summaryMarkdown,
  );
};
