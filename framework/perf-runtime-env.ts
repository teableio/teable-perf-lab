import type { PerfCase, RecordPasteCaseConfig } from "./types";

const DEFAULT_PERF_TRACE_EXPORT_RATIO = "0.001";

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

export const applyCaseRuntimeEnv = (perfCases: PerfCase[]) => {
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
      .map((perfCase) => {
        const config = perfCase.config as RecordPasteCaseConfig;
        const payloadCells = config.rowCount * config.fields.length;
        return Math.max(config.maxPasteCells ?? 0, payloadCells);
      }),
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

export const applyPerfObservabilityRuntimeEnv = () => {
  if (process.env.PERF_LAB_MODE === "seed") {
    process.env.PERF_LAB_TRACE_ENABLED = "false";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "";
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "";
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "";
    process.env.OTEL_EXPORT_RATIO = "0";
    return;
  }

  if (process.env.PERF_LAB_TRACE_ENABLED !== "false") {
    process.env.OTEL_EXPORT_RATIO =
      process.env.PERF_LAB_TRACE_EXPORT_RATIO ??
      DEFAULT_PERF_TRACE_EXPORT_RATIO;
    return;
  }

  // Teable's development defaults point traces and logs at localhost:4318.
  // A local perf run that explicitly disables trace collection should not
  // create exporter retries against a collector that is intentionally absent.
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "";
  process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ??= "";
  process.env.OTEL_EXPORT_RATIO ??= "0";
};

export const applySingleEngineBootstrapEnv = () => {
  const engines = (process.env.PERF_LAB_ENGINE_LIST ?? "v1,v2")
    .split(",")
    .map((engine) => engine.trim())
    .filter((engine) => engine === "v1" || engine === "v2");
  if (new Set(engines).size !== 1) {
    return;
  }

  const selectedEngine = engines[0] as "v1" | "v2";
  const seedMode = process.env.PERF_LAB_MODE === "seed";
  const runtimeEngine = seedMode ? "seed" : selectedEngine;
  const bootEngine = seedMode ? "v1" : selectedEngine;

  // A perf job owns one database, one Redis instance, one engine and one Nest
  // app. Reusing the shared-app boot avoids the private e2e BullMQ prefix that
  // QueueEvents created inside product code cannot observe.
  process.env.E2E_SHARED_APP = "1";
  process.env.FORCE_V2_ALL = bootEngine === "v2" ? "true" : "false";
  process.env.PERF_LAB_ENGINE = runtimeEngine;
  if (process.env.PERF_LAB_COMPUTED_UPDATE_MODE) {
    process.env.V2_COMPUTED_UPDATE_MODE =
      process.env.PERF_LAB_COMPUTED_UPDATE_MODE;
  }
  process.env.OTEL_SERVICE_NAME =
    process.env.PERF_LAB_OTEL_SERVICE_PREFIX != null
      ? `${process.env.PERF_LAB_OTEL_SERVICE_PREFIX}-${runtimeEngine}`
      : `teable-perf-serial-${runtimeEngine}`;
};
