import { performance } from "node:perf_hooks";
import type { IUserMeVo } from "@teable/openapi";
import { axios } from "@teable/openapi";
import { getPositiveIntegerEnv, getPrimaryThresholdMs } from "../env";
import { roundMetric, summarizeDurations } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import type { PerfCaseFor, PerfRunContext, PerfRunResult } from "../types";

// Intentionally NOT on a lifecycle driver — legacy by design, not yet-to-do.
//
// http-endpoint is a bare warmup + sampled-GET loop: no seed or fixture, no
// seedReady, no measured-operation/diagnostic wrapping, no cleanup, no SSE. The
// lifecycle drivers exist to consolidate the prepare -> seedReady -> measured op
// -> restore/cleanup protocol that many mutation/read/import kinds repeat; this
// runner shares none of that protocol, and it is the only bare-HTTP-smoke kind,
// so there is no second member to generalize a driver toward. Wrapping it would
// add indirection while consolidating nothing. It stays a direct runner on
// purpose — revisit only if a second bare-HTTP-sampling kind ever appears.
// See tasks/runner-migration-tracker.md.
export const runHttpEndpointCase = async (
  perfCase: PerfCaseFor<"http-endpoint">,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config;
  const samples = getPositiveIntegerEnv("PERF_LAB_SAMPLES") ?? config.samples;
  const thresholdMs = getPrimaryThresholdMs(config.threshold.maxMs);

  await withPerfTraceStep(context, perfCase, "warmup", () =>
    axios.get<IUserMeVo>(config.path),
  );

  const results = [];
  for (let iteration = 1; iteration <= samples; iteration++) {
    const startedAt = performance.now();
    const res = await withPerfTraceStep(
      context,
      perfCase,
      `sample-${iteration}`,
      () => axios.get<IUserMeVo>(config.path),
    );
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
