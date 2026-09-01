import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMeasurementMetadata,
  workloadDigestOf,
} from "./measurement-contract.ts";

const perfCase = {
  id: "record-read/example",
  title: "Example",
  runner: "record-read",
  timeoutMs: 30_000,
  watchdogMs: 5_000,
  seedAffinity: "fixture-a",
  config: {
    baseId: "seed-base",
    recordCount: 10_000,
    threshold: { metric: "recordsReadMs", maxMs: 20_000 },
    verify: { timeoutMs: 5_000, sampleRows: [0, 1] },
  },
};

const threshold = {
  metric: "recordsReadMs",
  max: 20_000,
  unit: "ms",
};

const stableHost = {
  cpuModel: "Test CPU",
  cpuCount: 4,
  platform: "linux",
  arch: "x64",
  release: "test-kernel",
  nodeVersion: "v22.18.0",
};

test("threshold and timeout tuning do not sever the measurement contract", () => {
  const tuned = structuredClone(perfCase);
  tuned.timeoutMs = 60_000;
  tuned.watchdogMs = 10_000;
  tuned.config.threshold.maxMs = 40_000;
  tuned.config.verify.timeoutMs = 15_000;
  assert.equal(workloadDigestOf(perfCase), workloadDigestOf(tuned));
});

test("a workload change severs the measurement contract", () => {
  const changed = structuredClone(perfCase);
  changed.config.recordCount = 50_000;
  assert.notEqual(workloadDigestOf(perfCase), workloadDigestOf(changed));
});

test("execution identity does not affect comparability", () => {
  const left = buildMeasurementMetadata({
    perfCase,
    engine: "v2",
    primaryThreshold: threshold,
    host: stableHost,
    env: {
      PERF_LAB_SAMPLES: "10",
      PERF_LAB_RUN_LANE: "paired",
      PERF_LAB_PAIR_ID: "pair-1",
      PERF_LAB_SAMPLE_INDEX: "0",
      CI_JOB_ID: "job-a",
      RUNNER_OS: "Linux",
      RUNNER_ARCH: "X64",
    },
  });
  const right = buildMeasurementMetadata({
    perfCase,
    engine: "v2",
    primaryThreshold: threshold,
    host: stableHost,
    env: {
      PERF_LAB_SAMPLES: "10",
      PERF_LAB_RUN_LANE: "paired",
      PERF_LAB_PAIR_ID: "pair-2",
      PERF_LAB_SAMPLE_INDEX: "9",
      CI_JOB_ID: "job-b",
      RUNNER_OS: "Linux",
      RUNNER_ARCH: "X64",
    },
  });
  assert.equal(left.contract.id, right.contract.id);
  assert.equal(left.environment.fingerprint, right.environment.fingerprint);
  assert.notDeepEqual(left.execution, right.execution);
});

test("metric, sample policy, mode and seed schema are contract inputs", () => {
  const baseline = buildMeasurementMetadata({
    perfCase,
    engine: "v2",
    primaryThreshold: threshold,
    host: stableHost,
    env: {
      PERF_LAB_SAMPLES: "10",
      PERF_LAB_COMPUTED_UPDATE_MODE: "sync",
      PERF_LAB_SEED_SCHEMA_SIGNATURE: "schema-a",
    },
  });
  const changes = [
    {
      PERF_LAB_SAMPLES: "20",
      PERF_LAB_COMPUTED_UPDATE_MODE: "sync",
      PERF_LAB_SEED_SCHEMA_SIGNATURE: "schema-a",
    },
    {
      PERF_LAB_SAMPLES: "10",
      PERF_LAB_COMPUTED_UPDATE_MODE: "hybrid",
      PERF_LAB_SEED_SCHEMA_SIGNATURE: "schema-a",
    },
    {
      PERF_LAB_SAMPLES: "10",
      PERF_LAB_COMPUTED_UPDATE_MODE: "sync",
      PERF_LAB_SEED_SCHEMA_SIGNATURE: "schema-b",
    },
  ];
  for (const env of changes) {
    const changed = buildMeasurementMetadata({
      perfCase,
      engine: "v2",
      primaryThreshold: threshold,
      host: stableHost,
      env,
    });
    assert.notEqual(changed.contract.id, baseline.contract.id);
  }
});

test("environment fingerprint changes without changing the contract", () => {
  const first = buildMeasurementMetadata({
    perfCase,
    engine: "v2",
    primaryThreshold: threshold,
    host: stableHost,
  });
  const second = buildMeasurementMetadata({
    perfCase,
    engine: "v2",
    primaryThreshold: threshold,
    host: { ...stableHost, cpuModel: "Other CPU" },
  });
  assert.equal(first.contract.id, second.contract.id);
  assert.notEqual(
    first.environment.fingerprint,
    second.environment.fingerprint,
  );
  assert.equal(first.environment.class, second.environment.class);
});
