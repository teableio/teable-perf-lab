import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { INestApplication } from "@nestjs/common";
import type { IUserMeVo } from "@teable/openapi";
import { axios, USER_ME } from "@teable/openapi";
import { initApp } from "../utils/init-app";

const CASE_ID = "smoke/auth-user";
const DEFAULT_SAMPLES = 10;
const DEFAULT_P95_THRESHOLD_MS = 2000;

interface ISample {
  iteration: number;
  status: number;
  durationMs: number;
  userId: string;
  email: string;
}

const parsePositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parsePositiveNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const round = (value: number) => Number(value.toFixed(2));

const percentile = (sortedValues: number[], quantile: number) => {
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil(sortedValues.length * quantile) - 1,
  );
  return sortedValues[index] ?? 0;
};

const buildSummaryMarkdown = (summary: {
  caseId: string;
  result: "pass" | "fail";
  samples: number;
  appUrl: string;
  user: { id: string; email: string };
  metrics: { minMs: number; p50Ms: number; p95Ms: number; maxMs: number };
  threshold: { p95Ms: number };
}) => {
  return [
    `# Perf lab summary: ${summary.caseId}`,
    "",
    `Result: **${summary.result}**`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| samples | ${summary.samples} |`,
    `| min | ${summary.metrics.minMs} ms |`,
    `| p50 | ${summary.metrics.p50Ms} ms |`,
    `| p95 | ${summary.metrics.p95Ms} ms |`,
    `| max | ${summary.metrics.maxMs} ms |`,
    `| p95 threshold | ${summary.threshold.p95Ms} ms |`,
    "",
    `App URL: \`${summary.appUrl}\``,
    "",
    `Seed user: \`${summary.user.email}\` / \`${summary.user.id}\``,
    "",
  ].join("\n");
};

describe("perf-lab smoke/auth-user (e2e)", () => {
  let app: INestApplication;
  let appUrl: string;

  beforeAll(async () => {
    const appCtx = await initApp();
    app = appCtx.app;
    appUrl = appCtx.appUrl;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("measures authenticated /auth/user/me through the teable-ee e2e session", async () => {
    const samples = parsePositiveInteger(
      process.env.PERF_LAB_SAMPLES,
      DEFAULT_SAMPLES,
    );
    const thresholdP95Ms = parsePositiveNumber(
      process.env.PERF_LAB_P95_THRESHOLD_MS,
      DEFAULT_P95_THRESHOLD_MS,
    );
    const runId = process.env.PERF_LAB_RUN_ID ?? `local-${Date.now()}`;

    await axios.get<IUserMeVo>(USER_ME, {
      headers: {
        "x-teable-perf-run-id": runId,
        "x-teable-perf-case-id": CASE_ID,
        "x-teable-perf-step-id": "warmup",
      },
    });

    const results: ISample[] = [];
    for (let iteration = 1; iteration <= samples; iteration++) {
      const startedAt = performance.now();
      const res = await axios.get<IUserMeVo>(USER_ME, {
        headers: {
          "x-teable-perf-run-id": runId,
          "x-teable-perf-case-id": CASE_ID,
          "x-teable-perf-step-id": `user-me-${iteration}`,
        },
      });
      const durationMs = performance.now() - startedAt;

      expect(res.status).toBe(200);
      expect(res.data.id).toBe(globalThis.testConfig.userId);
      expect(res.data.email).toBe(globalThis.testConfig.email);

      results.push({
        iteration,
        status: res.status,
        durationMs: round(durationMs),
        userId: res.data.id,
        email: res.data.email,
      });
    }

    const durations = results
      .map((result) => result.durationMs)
      .sort((a, b) => a - b);
    const metrics = {
      minMs: round(durations[0] ?? 0),
      p50Ms: round(percentile(durations, 0.5)),
      p95Ms: round(percentile(durations, 0.95)),
      maxMs: round(durations[durations.length - 1] ?? 0),
    };
    const passed = metrics.p95Ms <= thresholdP95Ms;
    const result: "pass" | "fail" = passed ? "pass" : "fail";
    const summary = {
      caseId: CASE_ID,
      runId,
      result,
      samples,
      appUrl,
      baseURL: axios.defaults.baseURL,
      user: {
        id: globalThis.testConfig.userId,
        email: globalThis.testConfig.email,
      },
      metrics,
      threshold: {
        p95Ms: thresholdP95Ms,
      },
      results,
    };

    const artifactDir = process.env.PERF_LAB_ARTIFACT_DIR;
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        join(artifactDir, "auth-user.json"),
        JSON.stringify(summary, null, 2),
      );
      await writeFile(
        join(artifactDir, "summary.md"),
        buildSummaryMarkdown(summary),
      );
    }

    expect(metrics.p95Ms).toBeLessThanOrEqual(thresholdP95Ms);
  });
});
