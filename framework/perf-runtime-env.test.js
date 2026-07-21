import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCaseRuntimeEnv,
  applySingleEngineBootstrapEnv,
} from "./perf-runtime-env.ts";

const ENV_KEYS = [
  "E2E_SHARED_APP",
  "FORCE_V2_ALL",
  "MAX_PASTE_CELLS",
  "OTEL_SERVICE_NAME",
  "PERF_LAB_COMPUTED_UPDATE_MODE",
  "PERF_LAB_ENGINE",
  "PERF_LAB_ENGINE_LIST",
  "PERF_LAB_MODE",
  "PERF_LAB_OTEL_SERVICE_PREFIX",
  "TABLE_LIMIT_SELECT_CHOICES_MAX",
  "V2_COMPUTED_UPDATE_MODE",
];

const withCleanEnv = (callback) => {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of ENV_KEYS) delete process.env[key];
  try {
    callback();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("single-engine execute jobs establish one shared app environment", () =>
  withCleanEnv(() => {
    process.env.PERF_LAB_ENGINE_LIST = "v2";
    process.env.PERF_LAB_COMPUTED_UPDATE_MODE = "hybrid";
    process.env.PERF_LAB_OTEL_SERVICE_PREFIX = "perf-ci";

    applySingleEngineBootstrapEnv();

    assert.equal(process.env.E2E_SHARED_APP, "1");
    assert.equal(process.env.FORCE_V2_ALL, "true");
    assert.equal(process.env.PERF_LAB_ENGINE, "v2");
    assert.equal(process.env.V2_COMPUTED_UPDATE_MODE, "hybrid");
    assert.equal(process.env.OTEL_SERVICE_NAME, "perf-ci-v2");
  }));

test("seed jobs bootstrap V1 while retaining the seed artifact identity", () =>
  withCleanEnv(() => {
    process.env.PERF_LAB_ENGINE_LIST = "v2";
    process.env.PERF_LAB_MODE = "seed";

    applySingleEngineBootstrapEnv();

    assert.equal(process.env.FORCE_V2_ALL, "false");
    assert.equal(process.env.PERF_LAB_ENGINE, "seed");
    assert.equal(process.env.OTEL_SERVICE_NAME, "teable-perf-serial-seed");
  }));

test("multi-engine local runs keep private per-engine app booting", () =>
  withCleanEnv(() => {
    process.env.PERF_LAB_ENGINE_LIST = "v1,v2";
    applySingleEngineBootstrapEnv();
    assert.equal(process.env.E2E_SHARED_APP, undefined);
  }));

test("case runtime limits are applied before the app baseline is captured", () =>
  withCleanEnv(() => {
    applyCaseRuntimeEnv([
      {
        id: "record-paste/contract",
        title: "contract",
        runner: "record-paste",
        timeoutMs: 1_000,
        runtimeEnv: { TABLE_LIMIT_SELECT_CHOICES_MAX: 20_000 },
        config: {
          rowCount: 10_000,
          fields: Array.from({ length: 20 }, () => ({})),
          maxPasteCells: 250_000,
        },
      },
    ]);

    assert.equal(process.env.TABLE_LIMIT_SELECT_CHOICES_MAX, "20000");
    assert.equal(process.env.MAX_PASTE_CELLS, "250000");
  }));
