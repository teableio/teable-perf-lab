import type { INestApplication } from "@nestjs/common";
import { performance } from "node:perf_hooks";
import "../../src/tracing";
import { initApp } from "../utils/init-app";
import { listPerfCases } from "./registry";
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

type Engine = "v1" | "v2";

const parseEngineList = (engineList = "v1,v2"): Engine[] => {
  const engines = engineList
    .split(",")
    .map((engine) => engine.trim())
    .filter(Boolean);

  if (engines.length === 0) {
    throw new Error("PERF_LAB_ENGINE_LIST must include at least one engine");
  }

  const invalidEngines = engines.filter(
    (engine) => engine !== "v1" && engine !== "v2",
  );
  if (invalidEngines.length > 0) {
    throw new Error(
      `Unsupported PERF_LAB_ENGINE_LIST: ${invalidEngines.join(
        ", ",
      )}. Available engines: v1, v2.`,
    );
  }

  return [...new Set(engines)] as Engine[];
};

const getForceV2All = (engine: Engine) => (engine === "v2" ? "true" : "false");

const withEngineEnv = async <T>(engine: Engine, fn: () => Promise<T>) => {
  const previousForceV2All = process.env.FORCE_V2_ALL;
  const previousEngine = process.env.PERF_LAB_ENGINE;
  const previousOtelServiceName = process.env.OTEL_SERVICE_NAME;

  process.env.FORCE_V2_ALL = getForceV2All(engine);
  process.env.PERF_LAB_ENGINE = engine;
  process.env.OTEL_SERVICE_NAME =
    process.env.PERF_LAB_OTEL_SERVICE_PREFIX != null
      ? `${process.env.PERF_LAB_OTEL_SERVICE_PREFIX}-${engine}`
      : `teable-perf-serial-${engine}`;

  try {
    return await fn();
  } finally {
    if (previousForceV2All == null) {
      delete process.env.FORCE_V2_ALL;
    } else {
      process.env.FORCE_V2_ALL = previousForceV2All;
    }

    if (previousEngine == null) {
      delete process.env.PERF_LAB_ENGINE;
    } else {
      process.env.PERF_LAB_ENGINE = previousEngine;
    }

    if (previousOtelServiceName == null) {
      delete process.env.OTEL_SERVICE_NAME;
    } else {
      process.env.OTEL_SERVICE_NAME = previousOtelServiceName;
    }
  }
};

describe("perf-lab serial case runner (e2e)", () => {
  const perfCases = listPerfCases(
    process.env.PERF_LAB_CASE_FILTER ??
      process.env.PERF_LAB_CASE_ID ??
      "smoke/auth-user",
  );
  const engines = parseEngineList(process.env.PERF_LAB_ENGINE_LIST);

  logPhase("module-loaded", {
    cases: perfCases.map((perfCase) => perfCase.id).join(","),
    engines: engines.join(","),
  });

  beforeAll(() => {
    installPerfTraceCollector();
  });

  for (const engine of engines) {
    describe(`engine ${engine}`, () => {
      let app: INestApplication;
      let appUrl: string;

      beforeAll(async () => {
        logPhase("engine:beforeAll:start", { engine });
        await withEngineEnv(engine, async () => {
          const initStarted = performance.now();
          const appCtx = await initApp();
          app = appCtx.app;
          appUrl = appCtx.appUrl;
          logPhase("engine:beforeAll:ready", {
            engine,
            initAppMs: Math.round(performance.now() - initStarted),
            appUrl,
          });
        });
      });

      afterAll(async () => {
        const closeStarted = performance.now();
        await app?.close();
        logPhase("engine:afterAll:closed", {
          engine,
          closeMs: Math.round(performance.now() - closeStarted),
        });
      });

      for (const perfCase of perfCases) {
        it(
          `runs ${perfCase.id} (${engine})`,
          { timeout: perfCase.timeoutMs },
          async () => {
            await withEngineEnv(engine, async () => {
              logPhase("case:start", { caseId: perfCase.id, engine });
              const caseStarted = performance.now();
              await runPerfCase(perfCase, { app, appUrl });
              logPhase("case:done", {
                caseId: perfCase.id,
                engine,
                caseMs: Math.round(performance.now() - caseStarted),
              });
            });
          },
        );
      }
    });
  }
});
