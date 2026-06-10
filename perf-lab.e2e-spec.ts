import type { INestApplication } from "@nestjs/common";
import { performance } from "node:perf_hooks";
import otelSDK from "../../src/tracing";
import { initApp } from "../utils/init-app";
import { listPerfCases } from "./registry";
import { runPerfCase } from "./framework/run-perf-case";
import { seedPerfCase } from "./framework/run-perf-seed";
import type { PerfCase, RecordPasteCaseConfig } from "./framework/types";
import {
  installPerfTraceCollector,
  setPerfTraceFlush,
  uninstallPerfTraceCollector,
} from "./framework/trace-collector";
import { axios } from "@teable/openapi";

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
type Mode = "execute" | "seed";
const SEED_BOOTSTRAP_ENGINE: Engine = "v1";

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

const getMode = (): Mode =>
  process.env.PERF_LAB_MODE === "seed" ? "seed" : "execute";

const getRuntimeEnvValue = (value: string | number | boolean) =>
  typeof value === "string" ? value : String(value);

const shouldOverrideRuntimeEnv = (
  currentValue: string | undefined,
  requiredValue: string,
) => {
  if (currentValue == null || currentValue === "") {
    return true;
  }

  const currentNumber = Number.parseFloat(currentValue);
  const requiredNumber = Number.parseFloat(requiredValue);

  if (Number.isFinite(currentNumber) && Number.isFinite(requiredNumber)) {
    return currentNumber < requiredNumber;
  }

  return false;
};

const applyCaseRuntimeEnv = (perfCases: PerfCase[]) => {
  for (const perfCase of perfCases) {
    for (const [key, value] of Object.entries(perfCase.runtimeEnv ?? {})) {
      const requiredValue = getRuntimeEnvValue(value);
      if (shouldOverrideRuntimeEnv(process.env[key], requiredValue)) {
        process.env[key] = requiredValue;
      }
    }
  }

  const requiredMaxPasteCells = Math.max(
    0,
    ...perfCases
      .filter((perfCase) => perfCase.runner === "record-paste")
      .map(
        (perfCase) =>
          (perfCase.config as RecordPasteCaseConfig).maxPasteCells ?? 0,
      ),
  );

  if (requiredMaxPasteCells <= 0) {
    return;
  }

  const currentMaxPasteCells = Number.parseInt(
    process.env.MAX_PASTE_CELLS ?? "",
    10,
  );
  if (
    Number.isFinite(currentMaxPasteCells) &&
    currentMaxPasteCells >= requiredMaxPasteCells
  ) {
    return;
  }

  process.env.MAX_PASTE_CELLS = String(requiredMaxPasteCells);
};

const resetAxiosInterceptors = () => {
  uninstallPerfTraceCollector();
  axios.interceptors.request.clear?.();
  axios.interceptors.response.clear?.();
  installPerfTraceCollector();
};

const getOtelForceFlush = () => {
  const sdk = otelSDK as unknown as {
    forceFlush?: () => Promise<void>;
    _tracerProvider?: { forceFlush?: () => Promise<void> };
    tracerProvider?: { forceFlush?: () => Promise<void> };
  };
  const provider = sdk._tracerProvider ?? sdk.tracerProvider;

  if (typeof sdk.forceFlush === "function") {
    return () => sdk.forceFlush?.call(sdk);
  }

  if (typeof provider?.forceFlush === "function") {
    return () => provider.forceFlush?.call(provider);
  }

  return undefined;
};

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

const withRunEngineEnv = async <T>(
  engine: Engine | "seed",
  fn: () => Promise<T>,
) =>
  withEngineEnv(
    engine === "seed" ? SEED_BOOTSTRAP_ENGINE : engine,
    async () => {
      if (engine === "seed") {
        process.env.PERF_LAB_ENGINE = "seed";
        process.env.OTEL_SERVICE_NAME =
          process.env.PERF_LAB_OTEL_SERVICE_PREFIX != null
            ? `${process.env.PERF_LAB_OTEL_SERVICE_PREFIX}-seed`
            : "teable-perf-serial-seed";
      }

      return fn();
    },
  );

describe("perf-lab serial case runner (e2e)", () => {
  const perfCases = listPerfCases(
    process.env.PERF_LAB_CASE_FILTER ??
      process.env.PERF_LAB_CASE_ID ??
      "smoke/auth-user",
  );
  applyCaseRuntimeEnv(perfCases);
  const engines = parseEngineList(process.env.PERF_LAB_ENGINE_LIST);
  const mode = getMode();

  logPhase("module-loaded", {
    mode,
    cases: perfCases.map((perfCase) => perfCase.id).join(","),
    engines: engines.join(","),
    maxPasteCells: process.env.MAX_PASTE_CELLS,
    maxSelectChoices: process.env.TABLE_LIMIT_SELECT_CHOICES_MAX,
  });

  beforeAll(() => {
    setPerfTraceFlush(getOtelForceFlush());
    installPerfTraceCollector();
  });

  const runEngines: Array<Engine | "seed"> =
    mode === "seed" ? ["seed"] : engines;

  for (const engine of runEngines) {
    describe(`engine ${engine}`, () => {
      let app: INestApplication;
      let appUrl: string;
      let cookie: string | undefined;

      beforeAll(async () => {
        logPhase("engine:beforeAll:start", { engine });
        await withRunEngineEnv(engine, async () => {
          resetAxiosInterceptors();
          const initStarted = performance.now();
          const appCtx = await initApp();
          app = appCtx.app;
          appUrl = appCtx.appUrl;
          cookie = appCtx.cookie;
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
            await withRunEngineEnv(engine, async () => {
              logPhase("case:start", { caseId: perfCase.id, engine });
              const caseStarted = performance.now();
              if (mode === "seed") {
                await seedPerfCase(perfCase, { app, appUrl, cookie });
              } else {
                await runPerfCase(perfCase, { app, appUrl, cookie });
              }
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
