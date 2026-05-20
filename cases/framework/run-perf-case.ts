import { performance } from "node:perf_hooks";
import { writePerfArtifacts, type PerfArtifactPayload } from "./artifacts";
import { roundMetric } from "./metrics";
import { runFormulaTableCase } from "./runners/formula-table.runner";
import { runHttpEndpointCase } from "./runners/http-endpoint.runner";
import type {
  MetricThreshold,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "./types";

const runCaseByKind = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  switch (perfCase.runner) {
    case "http-endpoint":
      return runHttpEndpointCase(perfCase, context);
    case "formula-table":
      return runFormulaTableCase(perfCase, context);
    default:
      throw new Error(`Unsupported perf runner: ${perfCase.runner}`);
  }
};

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

export const runPerfCase = async (
  perfCase: PerfCase,
  appContext: Pick<PerfRunContext, "app" | "appUrl">,
) => {
  const startedAt = new Date();
  const started = performance.now();
  let payloadWritten = false;
  const context: PerfRunContext = {
    ...appContext,
    runId: process.env.PERF_LAB_RUN_ID ?? `local-${Date.now()}`,
    artifactDir: process.env.PERF_LAB_ARTIFACT_DIR,
  };

  try {
    const result = await runCaseByKind(perfCase, context);
    const thresholdResults = evaluateThresholds(
      result.metrics,
      result.thresholds,
    );
    const passed = thresholdResults.every((threshold) => threshold.passed);
    const payload: PerfArtifactPayload = {
      caseId: perfCase.id,
      title: perfCase.title,
      runId: context.runId,
      appUrl: context.appUrl,
      result: passed ? "pass" : "fail",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: roundMetric(performance.now() - started),
      metrics: result.metrics,
      thresholds: thresholdResults,
      phases: result.phases,
      details: result.details,
    };

    await writePerfArtifacts(context.artifactDir, perfCase, payload);
    payloadWritten = true;

    const failedThreshold = thresholdResults.find(
      (threshold) => !threshold.passed,
    );
    if (failedThreshold) {
      throw new Error(
        `${failedThreshold.metric}=${failedThreshold.actual} ${failedThreshold.unit} exceeded ${failedThreshold.max} ${failedThreshold.unit}`,
      );
    }
  } catch (error) {
    if (payloadWritten) {
      throw error;
    }

    const payload: PerfArtifactPayload = {
      caseId: perfCase.id,
      title: perfCase.title,
      runId: context.runId,
      appUrl: context.appUrl,
      result: "fail",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: roundMetric(performance.now() - started),
      metrics: {},
      thresholds: [],
      error: normalizeError(error),
    };

    await writePerfArtifacts(context.artifactDir, perfCase, payload);
    throw error;
  }
};
