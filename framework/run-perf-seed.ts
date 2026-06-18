import { performance } from "node:perf_hooks";
import { writePerfArtifacts, type PerfArtifactPayload } from "./artifacts";
import { roundMetric } from "./metrics";
import { runnerRegistry } from "./runner-registry";
import { resetPerfTraceRefs, writeTraceArtifacts } from "./trace-collector";
import type { PerfCase, PerfRunContext, PerfRunResult } from "./types";

const seedCaseByKind = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const entry = runnerRegistry[perfCase.runner];
  if (!entry) {
    throw new Error(`Unsupported perf seed runner: ${perfCase.runner}`);
  }
  return entry.seed(perfCase, context);
};

const normalizeError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
};

const withTraceDetails = async (
  context: PerfRunContext,
  perfCase: PerfCase,
  details: PerfRunResult["details"],
) => {
  const traceArtifacts = await writeTraceArtifacts({
    artifactDir: context.artifactDir,
    perfCase,
    engine: context.engine,
  });

  return {
    ...details,
    observability: {
      traces: traceArtifacts,
    },
  };
};

export const seedPerfCase = async (
  perfCase: PerfCase,
  appContext: Pick<PerfRunContext, "app" | "appUrl" | "cookie">,
) => {
  const startedAt = new Date();
  const started = performance.now();
  // Fresh per-case ref budget; see resetPerfTraceRefs in run-perf-case.ts.
  resetPerfTraceRefs();
  const context: PerfRunContext = {
    ...appContext,
    runId: process.env.PERF_LAB_RUN_ID ?? `local-${Date.now()}`,
    engine: process.env.PERF_LAB_ENGINE ?? "seed",
    artifactDir: process.env.PERF_LAB_ARTIFACT_DIR,
  };

  try {
    const result = await seedCaseByKind(perfCase, context);
    const skipped = result.result === "skipped";
    const payload: PerfArtifactPayload = {
      caseId: perfCase.id,
      title: perfCase.title,
      runId: context.runId,
      engine: context.engine,
      appUrl: context.appUrl,
      result: skipped ? "skipped" : "pass",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: roundMetric(performance.now() - started),
      metrics: result.metrics,
      thresholds: [],
      phases: result.phases,
      details: await withTraceDetails(context, perfCase, result.details),
    };

    await writePerfArtifacts(context.artifactDir, perfCase, payload);
  } catch (error) {
    const payload: PerfArtifactPayload = {
      caseId: perfCase.id,
      title: perfCase.title,
      runId: context.runId,
      engine: context.engine,
      appUrl: context.appUrl,
      result: "fail",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: roundMetric(performance.now() - started),
      metrics: {},
      thresholds: [],
      details: await withTraceDetails(context, perfCase, undefined),
      error: normalizeError(error),
    };

    await writePerfArtifacts(context.artifactDir, perfCase, payload);
    throw error;
  }
};
