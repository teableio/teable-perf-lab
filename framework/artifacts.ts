import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MetricThreshold, PerfCase, PerfRunResult } from "./types";

export interface PerfArtifactPayload {
  caseId: string;
  title: string;
  runId: string;
  engine: string;
  appUrl: string;
  result: "pass" | "fail";
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

export const getArtifactJsonName = (caseId: string) =>
  `${sanitizeCaseId(caseId)}.json`;

export const getSummaryMarkdownName = (engine: string) =>
  `summary-${engine.replace(/[^a-zA-Z0-9_.-]+/g, "-")}.md`;

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
              savedTraceCount?: number;
              failedTraceCount?: number;
              manifestPath?: string;
              artifactDir?: string;
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
      `| saved JSON traces | ${traces.savedTraceCount ?? 0} |`,
      `| failed trace fetches | ${traces.failedTraceCount ?? 0} |`,
    );
    if (traces.manifestPath) {
      lines.push(`| manifest | \`${traces.manifestPath}\` |`);
    }
    if (traces.artifactDir) {
      lines.push(`| trace dir | \`${traces.artifactDir}\` |`);
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
  await writeFile(
    join(artifactDir, getArtifactJsonName(perfCase.id)),
    JSON.stringify(payload, null, 2),
  );
  await writeFile(
    join(artifactDir, "summary.md"),
    buildSummaryMarkdown(payload),
  );
  await writeFile(
    join(artifactDir, getSummaryMarkdownName(payload.engine)),
    buildSummaryMarkdown(payload),
  );
};
