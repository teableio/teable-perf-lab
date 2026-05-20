import type { INestApplication } from "@nestjs/common";
import { initApp } from "../utils/init-app";
import { getPerfCase } from "./registry";
import { runPerfCase } from "./framework/run-perf-case";

describe("perf-lab case runner (e2e)", () => {
  const caseId = process.env.PERF_LAB_CASE_ID ?? "smoke/auth-user";
  const perfCase = getPerfCase(caseId);
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

  it(`runs ${perfCase.id}`, { timeout: perfCase.timeoutMs }, async () => {
    await runPerfCase(perfCase, { app, appUrl });
  });
});
