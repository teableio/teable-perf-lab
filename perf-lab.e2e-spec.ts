import type { INestApplication } from "@nestjs/common";
import { performance } from "node:perf_hooks";
import "../../src/tracing";
import { initApp } from "../utils/init-app";
import { getPerfCase } from "./registry";
import { runPerfCase } from "./framework/run-perf-case";
import { installPerfTraceCollector } from "./framework/trace-collector";

const specStarted = performance.now();

const logPhase = (
  phase: string,
  details: Record<string, string | number | boolean | undefined> = {},
) => {
  if (process.env.PERF_LAB_PHASE_LOG === "false") {
    return;
  }

  const detailText = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");

  console.log(
    `[perf-lab] ${phase} at=${new Date().toISOString()} elapsedMs=${Math.round(
      performance.now() - specStarted,
    )}${detailText ? ` ${detailText}` : ""}`,
  );
};

describe("perf-lab case runner (e2e)", () => {
  const caseId = process.env.PERF_LAB_CASE_ID ?? "smoke/auth-user";
  const perfCase = getPerfCase(caseId);
  let app: INestApplication;
  let appUrl: string;

  logPhase("module-loaded", { caseId: perfCase.id });

  beforeAll(async () => {
    logPhase("beforeAll:start");
    installPerfTraceCollector();
    const initStarted = performance.now();
    const appCtx = await initApp();
    app = appCtx.app;
    appUrl = appCtx.appUrl;
    logPhase("beforeAll:ready", {
      initAppMs: Math.round(performance.now() - initStarted),
      appUrl,
    });
  });

  afterAll(async () => {
    const closeStarted = performance.now();
    await app?.close();
    logPhase("afterAll:closed", {
      closeMs: Math.round(performance.now() - closeStarted),
    });
  });

  it(`runs ${perfCase.id}`, { timeout: perfCase.timeoutMs }, async () => {
    logPhase("case:start", { caseId: perfCase.id });
    const caseStarted = performance.now();
    await runPerfCase(perfCase, { app, appUrl });
    logPhase("case:done", {
      caseId: perfCase.id,
      caseMs: Math.round(performance.now() - caseStarted),
    });
  });
});
