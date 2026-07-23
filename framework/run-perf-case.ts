import { performance } from "node:perf_hooks";
import { writePerfArtifacts, type PerfArtifactPayload } from "./artifacts";
import { roundMetric } from "./metrics";
import { normalizePerfError, toPerfTestFailure } from "./perf-error";
import { executeRegisteredRunner } from "./runner-registry";
import { deferPerfTraceDetails, resetPerfTraceRefs } from "./trace-collector";
import { runWithWatchdog } from "./watchdog";
import { PerfRunDiagnosticError } from "./types";
import type { MetricThreshold, PerfCase, PerfRunContext } from "./types";

const evaluateThresholds = (
  metrics: Record<string, number>,
  thresholds: MetricThreshold[],
): Array<MetricThreshold & { passed: boolean; actual: number | null }> =>
  thresholds.map((threshold) => {
    const actual = metrics[threshold.metric];
    return {
      ...threshold,
      actual: typeof actual === "number" ? actual : null,
      passed: typeof actual === "number" && actual <= threshold.max,
    };
  });

export const runPerfCase = async (
  perfCase: PerfCase,
  appContext: Pick<PerfRunContext, "app" | "appUrl" | "cookie">,
) => {
  const startedAt = new Date();
  const started = performance.now();
  let payloadWritten = false;
  // Each case gets a fresh per-case ref budget (see resetPerfTraceRefs); the serial
  // spec shares one process across all cases, so leftover refs would otherwise let
  // the earliest cases exhaust PERF_LAB_TRACE_MAX_REFS and starve later ones.
  resetPerfTraceRefs();
  const context: PerfRunContext = {
    ...appContext,
    runId: process.env.PERF_LAB_RUN_ID ?? `local-${Date.now()}`,
    engine: process.env.PERF_LAB_ENGINE ?? "local",
    artifactDir: process.env.PERF_LAB_ARTIFACT_DIR,
  };

  try {
    const result = perfCase.watchdogMs
      ? await runWithWatchdog(
          {
            watchdogMs: perfCase.watchdogMs,
            onAbort: (signal) => {
              context.signal = signal;
            },
          },
          () => executeRegisteredRunner(perfCase, context),
        )
      : await executeRegisteredRunner(perfCase, context);
    const thresholdResults = evaluateThresholds(
      result.metrics,
      result.thresholds,
    );
    const skipped = result.result === "skipped";
    const passed =
      skipped || thresholdResults.every((threshold) => threshold.passed);
    const payload: PerfArtifactPayload = {
      caseId: perfCase.id,
      title: perfCase.title,
      runId: context.runId,
      engine: context.engine,
      appUrl: context.appUrl,
      result: skipped ? "skipped" : passed ? "pass" : "fail",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: roundMetric(performance.now() - started),
      metrics: result.metrics,
      thresholds: thresholdResults,
      phases: result.phases,
      details: await deferPerfTraceDetails({
        context,
        perfCase,
        details: result.details,
      }),
    };

    await writePerfArtifacts(context.artifactDir, perfCase, payload);
    payloadWritten = true;

    const failedThreshold = thresholdResults.find(
      (threshold) => !threshold.passed,
    );
    if (!skipped && failedThreshold) {
      throw new Error(
        `${failedThreshold.metric}=${failedThreshold.actual} ${failedThreshold.unit} exceeded ${failedThreshold.max} ${failedThreshold.unit}`,
      );
    }
  } catch (error) {
    if (payloadWritten) {
      throw toPerfTestFailure(error);
    }

    if (error instanceof PerfRunDiagnosticError) {
      const thresholdResults = evaluateThresholds(
        error.result.metrics,
        error.result.thresholds,
      );
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
        metrics: error.result.metrics,
        thresholds: thresholdResults,
        phases: error.result.phases,
        details: await deferPerfTraceDetails({
          context,
          perfCase,
          details: error.result.details,
        }),
        error: normalizePerfError(error),
      };

      await writePerfArtifacts(context.artifactDir, perfCase, payload);
      throw toPerfTestFailure(error);
    }

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
