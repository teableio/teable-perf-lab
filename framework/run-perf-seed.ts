import { performance } from "node:perf_hooks";
import { writePerfArtifacts, type PerfArtifactPayload } from "./artifacts";
import { roundMetric } from "./metrics";
import { normalizePerfError, toPerfTestFailure } from "./perf-error";
import { seedRegisteredRunner } from "./runner-registry";
import { deferPerfTraceDetails, resetPerfTraceRefs } from "./trace-collector";
import type { PerfCase, PerfRunContext } from "./types";

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
    const result = await seedRegisteredRunner(perfCase, context);
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
      details: await deferPerfTraceDetails({
        context,
        perfCase,
        details: result.details,
      }),
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
      details: await deferPerfTraceDetails({ context, perfCase }),
      error: normalizePerfError(error),
    };

    await writePerfArtifacts(context.artifactDir, perfCase, payload);
    throw toPerfTestFailure(error);
  }
};
