import { performance } from "node:perf_hooks";
import type { IUserMeVo } from "@teable/openapi";
import { axios } from "@teable/openapi";
import { getPositiveIntegerEnv, getPrimaryThresholdMs } from "../env";
import { roundMetric, summarizeDurations } from "../metrics";
import type {
  HttpEndpointCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";

export const runHttpEndpointCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as HttpEndpointCaseConfig;
  const samples = getPositiveIntegerEnv("PERF_LAB_SAMPLES") ?? config.samples;
  const thresholdMs = getPrimaryThresholdMs(config.threshold.maxMs);

  await axios.get<IUserMeVo>(config.path, {
    headers: {
      "x-teable-perf-run-id": context.runId,
      "x-teable-perf-case-id": perfCase.id,
      "x-teable-perf-step-id": "warmup",
    },
  });

  const results = [];
  for (let iteration = 1; iteration <= samples; iteration++) {
    const startedAt = performance.now();
    const res = await axios.get<IUserMeVo>(config.path, {
      headers: {
        "x-teable-perf-run-id": context.runId,
        "x-teable-perf-case-id": perfCase.id,
        "x-teable-perf-step-id": `sample-${iteration}`,
      },
    });
    const durationMs = roundMetric(performance.now() - startedAt);

    expect(res.status).toBe(200);
    if (config.validateSeedUser) {
      expect(res.data.id).toBe(globalThis.testConfig.userId);
      expect(res.data.email).toBe(globalThis.testConfig.email);
    }

    results.push({
      iteration,
      status: res.status,
      durationMs,
      userId: res.data.id,
      email: res.data.email,
    });
  }

  const metrics = summarizeDurations(
    results.map((result) => result.durationMs),
  );
  return {
    metrics,
    thresholds: [
      { metric: config.threshold.metric, max: thresholdMs, unit: "ms" },
    ],
    details: {
      samples,
      endpoint: {
        method: config.method,
        path: config.path,
      },
      seedUser: config.validateSeedUser
        ? {
            id: globalThis.testConfig.userId,
            email: globalThis.testConfig.email,
          }
        : undefined,
      samplesDetail: results,
    },
  };
};
