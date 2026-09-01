import { performance } from "node:perf_hooks";
import { writePerfArtifacts, type PerfArtifactPayload } from "./artifacts";
import {
  closeComputeWindow,
  detachedComputeMetrics,
  openComputeWindow,
  toComputeMetrics,
} from "./compute-span-sink";
import { buildMeasurementMetadata } from "./measurement-contract";
import { roundMetric } from "./metrics";
import { normalizePerfError, toPerfTestFailure } from "./perf-error";
import { executeRegisteredRunner } from "./runner-registry";
import { thresholdDisposition } from "./threshold-disposition";
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

const measurementOf = (
  perfCase: PerfCase,
  context: PerfRunContext,
  thresholds: MetricThreshold[],
) =>
  buildMeasurementMetadata({
    perfCase,
    engine: context.engine,
    primaryThreshold: thresholds[0],
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

  // Opened around the runner so every case carries a compute number without
  // its runner having to opt in. This window covers fixture preparation as
  // well as the measured operation, so it is a coarse health signal — not a
  // comparable per-operation measurement. Narrowing it to the measured region
  // is a later phase; see docs/compute-time-observation-spec.md.
  const computeWindow = openComputeWindow();
  let computeMetrics: Record<string, number> | undefined;
  // Closing is idempotent and must happen before artifact work, so the window
  // does not absorb trace deferral time on either the success or failure path.
  const takeComputeMetrics = () => {
    if (!computeMetrics) {
      const summary = closeComputeWindow(computeWindow);
      computeMetrics = summary
        ? toComputeMetrics(summary)
        : detachedComputeMetrics();
    }
    return computeMetrics;
  };
  const withComputeDetails = (details?: Record<string, unknown>) => {
    const existing = details?.observability;
    const observability =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    return {
      ...details,
      observability: { ...observability, compute: takeComputeMetrics() },
    };
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
    const metrics = { ...result.metrics, ...takeComputeMetrics() };
    const thresholdResults = evaluateThresholds(metrics, result.thresholds);
    const skipped = result.result === "skipped";
    const thresholdObserveOnly =
      process.env.PERF_LAB_THRESHOLD_MODE === "observe";
    const thresholdDispositionResult = thresholdDisposition({
      skipped,
      thresholds: thresholdResults,
      observeOnly: thresholdObserveOnly,
    });
    const passed = thresholdDispositionResult.passed;
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
      metrics,
      thresholds: thresholdResults,
      measurement: measurementOf(perfCase, context, result.thresholds),
      phases: result.phases,
      details: await deferPerfTraceDetails({
        context,
        perfCase,
        details: withComputeDetails(result.details),
      }),
    };

    await writePerfArtifacts(context.artifactDir, perfCase, payload);
    payloadWritten = true;

    const { failedThreshold } = thresholdDispositionResult;
    if (failedThreshold) {
      throw new Error(
        `${failedThreshold.metric}=${failedThreshold.actual} ${failedThreshold.unit} exceeded ${failedThreshold.max} ${failedThreshold.unit}`,
      );
    }
  } catch (error) {
    if (payloadWritten) {
      throw toPerfTestFailure(error);
    }

    if (error instanceof PerfRunDiagnosticError) {
      const metrics = { ...error.result.metrics, ...takeComputeMetrics() };
      const thresholdResults = evaluateThresholds(
        metrics,
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
        metrics,
        thresholds: thresholdResults,
        measurement: measurementOf(perfCase, context, error.result.thresholds),
        phases: error.result.phases,
        details: await deferPerfTraceDetails({
          context,
          perfCase,
          details: withComputeDetails(error.result.details),
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
      metrics: { ...takeComputeMetrics() },
      thresholds: [],
      measurement: measurementOf(perfCase, context, []),
      details: await deferPerfTraceDetails({
        context,
        perfCase,
        details: withComputeDetails(),
      }),
      error: normalizePerfError(error),
    };

    await writePerfArtifacts(context.artifactDir, perfCase, payload);
    throw toPerfTestFailure(error);
  }
};
