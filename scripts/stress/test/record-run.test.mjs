import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EVIDENCE_BASE_ID,
  DEFAULT_EVIDENCE_TABLE_IDS,
} from "../evidence-schema.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const recorder = join(here, "..", "record-run.mjs");
const fixtures = join(here, "fixtures");

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("EVIDENCE_")) delete env[key];
  }
  delete env.BASE_URL;
  delete env.TEABLE_TOKEN;
  delete env.TOKEN;
  return { ...env, ...overrides };
}

function dryRun(bundlePath, args = [], env = {}) {
  const result = spawnSync(
    process.execPath,
    [recorder, "--bundle", bundlePath, "--dry-run", ...args],
    { encoding: "utf8", env: cleanEnv(env) },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function writeBundle(bundle) {
  const dir = await mkdtemp(join(tmpdir(), "stress-record-run-"));
  const path = join(dir, "bundle.json");
  await writeFile(path, JSON.stringify(bundle));
  return path;
}

function runRecorder(args) {
  return spawnSync(process.execPath, [recorder, ...args], {
    encoding: "utf8",
    env: cleanEnv(),
  });
}

function canonicalBundle(overrides = {}) {
  return {
    run: {
      runId: "lst_20261026T000000Z_v2",
      environment: "staging",
      category: "core",
      testType: "load",
      scenarioSet: "readmix_v1",
      status: "success",
      verdict: "inconclusive",
      loadModel: "open_arrival",
      targetRps: 10,
      startTime: "2026-10-26T00:00:00Z",
      endTime: "2026-10-26T00:10:00Z",
      windowStart: "2026-10-26T00:00:00Z",
      windowEnd: "2026-10-26T00:10:00Z",
      codeVersion: "fixture-sha",
      environmentBaseline: "fixture; 1 pod",
      mode: "byodb",
      repeat: 1,
      cleanupStatus: "verified",
      dbPhysicalCount: 1,
      specVersion: "v1",
      ...overrides,
    },
    registry: { sloP95Ms: 1000, maxErrorRatePct: 1, specVersion: "v1" },
    scenarios: [
      {
        scenarioId: "C0",
        specVersion: "v1",
        operationKey: "list",
        targetRps: 10,
        p95: 100,
        p99: 200,
        errorRate: 0,
        correctness: "pass",
      },
    ],
    metrics: [
      {
        metric: "p95",
        metricKey: "p95",
        value: 100,
        specVersion: "v1",
        operationKey: "list",
        scenario: "C0",
        collectionStatus: "observed",
        source: "signoz",
        queryReceipt: "p95 over 5m",
      },
      {
        metricKey: "http_req_failed",
        metric: "http_req_failed",
        value: 0,
        specVersion: "v1",
        operationKey: "list",
        collectionStatus: "observed",
        source: "k6",
        queryReceipt: "failed requests over the run",
      },
      {
        metric: "teable.database.client.pool.waiting",
        metricKey: "teable.database.client.pool.waiting",
        scenario: "C0",
        value: 0,
        specVersion: "v1",
        operationKey: "list",
        collectionStatus: "observed",
        source: "signoz",
        queryReceipt: "max over 5m",
      },
      {
        metric: "k6.dropped_iterations",
        scenario: "C0",
        metricKey: "k6.dropped_iterations",
        requests: 60000,
        value: 0,
        specVersion: "v1",
        operationKey: "list",
        source: "k6",
        queryReceipt: "dropped iterations over the run",
      },
    ],
    bottlenecks: [],
    correctness: [
      {
        checkKey: "write-readback",
        scenarioId: "C0",
        specVersion: "v1",
        operationKey: "list",
        sampleRef: "rec_sample_fixture",
        permissionCheck: true,
        delta: 0,
        tolerance: 0,
        verifier: "psql",
      },
    ],
    resources: [
      {
        resourceId: "rds-fixture",
        deletionVerified: true,
        cleanupStatus: "verified",
        receiptJson: '{"code":"DBInstanceNotFound"}',
        deletionEvidenceCode: "DBInstanceNotFound",
        deletedAtSource: "per-resource-receipt",
      },
    ],
    costs: [
      {
        costComponent: "db",
        actualAmount: 1,
        currency: "CNY",
        estAmount: 1,
        estimatedAt: "2026-10-25T23:00:00Z",
      },
      {
        costComponent: "loadgen",
        actualAmount: 1,
        currency: "CNY",
        estAmount: 1,
        estimatedAt: "2026-10-25T23:00:00Z",
      },
      {
        costComponent: "appnode",
        actualAmount: 0,
        currency: "CNY",
        estAmount: 0,
        estimatedAt: "2026-10-25T23:00:00Z",
      },
      {
        costComponent: "ops",
        actualAmount: 0,
        currency: "CNY",
        estAmount: 0,
        estimatedAt: "2026-10-25T23:00:00Z",
      },
    ],
    reports: [
      {
        reportKey: "fixture-report",
        reportVersion: "v1",
        queryReceipt: "rows read from 压测场景结果",
        sourceTables: "压测运行,压测场景结果",
        dataHash: "fixture-hash",
        generatedAt: "2026-10-26T00:20:00Z",
        uri: "https://staging.example/reports/fixture",
        status: "ok",
      },
    ],
  };
}

test("new bundles default to canonical v2 without network access", async () => {
  const path = await writeBundle(canonicalBundle());
  const summary = dryRun(path);

  assert.equal(summary.schemaVersion, "stress-evidence-v2");
  assert.equal(summary.keyFormat, "v2");
  assert.equal(summary.gate.mode, "enforce");
  assert.equal(summary.evidenceSchema.baseId, DEFAULT_EVIDENCE_BASE_ID);
  assert.deepEqual(summary.evidenceSchema.tableIds, {
    ...DEFAULT_EVIDENCE_TABLE_IDS,
  });
  assert.equal(summary.records[0].tableId, DEFAULT_EVIDENCE_TABLE_IDS.run);
  assert.equal(summary.records[0].keyValue, "lst:lst_20261026T000000Z_v2");
  assert.equal(summary.records[0].values["口径版本"], "stress-evidence-v2");
  assert.equal(summary.records[0].values.Key_Version, "v2");
  assert.equal(summary.records[0].values.Actual_Run_Cost, 2);
  assert.equal(
    summary.records[1].keyValue,
    "lst:lst_20261026T000000Z_v2:scenario:C0:byodb:1:list",
  );
  const costRecords = summary.records.filter(
    (record) => record.tableId === DEFAULT_EVIDENCE_TABLE_IDS.cost,
  );
  assert.equal(costRecords.length, 4);
  assert.equal(costRecords[0].values.Estimated_At, "2026-10-25T23:00:00.000Z");
  assert.equal(summary.created, 0);
  assert.equal(summary.updated, 0);
});

test("environment overrides redirect the base and each table independently", async () => {
  const path = await writeBundle(
    canonicalBundle({ runId: "lst_20261026T000000Z_env" }),
  );
  const summary = dryRun(path, ["--gate", "off"], {
    EVIDENCE_BASE_ID: "bse_env_test",
    EVIDENCE_RUN_TABLE_ID: "tbl_env_run",
    EVIDENCE_METRIC_TABLE_ID: "tbl_env_metric",
  });

  assert.equal(summary.evidenceSchema.baseId, "bse_env_test");
  assert.equal(summary.evidenceSchema.tableIds.run, "tbl_env_run");
  assert.equal(summary.evidenceSchema.tableIds.metric, "tbl_env_metric");
  assert.equal(
    summary.evidenceSchema.tableIds.scenario,
    DEFAULT_EVIDENCE_TABLE_IDS.scenario,
  );
  assert.equal(summary.records[0].tableId, "tbl_env_run");
  assert.ok(
    summary.records.some((record) => record.tableId === "tbl_env_metric"),
  );
});

test("an explicitly legacy bundle keeps byte-identical v1 keys", async () => {
  const summary = dryRun(join(fixtures, "run-bundle.json"));

  assert.equal(summary.schemaVersion, "stress-evidence-v1");
  assert.equal(summary.keyFormat, "v1");
  assert.equal(summary.records.length, 4);
  assert.equal(
    summary.records[0].keyValue,
    "lst:lst_fixture_20261019T140000Z_staging_readmix_abc1234",
  );
  assert.match(summary.records[1].keyValue, /:scenario:core\.crud\.list_plain/);
  assert.doesNotMatch(summary.records[1].keyValue, /:byodb:/);
});

test("explicit --key-format v1 keeps migration compatibility for a v2 bundle", async () => {
  const path = await writeBundle(
    canonicalBundle({ runId: "lst_20261026T000000Z_legacy" }),
  );
  const summary = dryRun(path, ["--key-format", "v1"]);

  assert.equal(summary.schemaVersion, "stress-evidence-v2");
  assert.equal(summary.keyFormat, "v1");
  assert.equal(summary.gate, undefined);
  assert.equal(summary.records[0].keyValue, "lst:lst_20261026T000000Z_legacy");
  assert.match(summary.records[1].keyValue, /:mode=byodb:repeat=1/);
  assert.doesNotMatch(
    summary.records[1].keyValue,
    /^lst:.*:scenario:C0:byodb:1:list$/,
  );
});

test("canonical v2 refuses to synthesize run timestamps", async () => {
  const bundle = canonicalBundle();
  delete bundle.run.windowStart;
  const path = await writeBundle(bundle);
  const result = runRecorder(["--bundle", path, "--dry-run"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /startTime, endTime, windowStart, and windowEnd/);
});

test("explicit legacy v1 keeps the timestamp fallback", async () => {
  const bundle = canonicalBundle({
    runId: "lst_20261026T000000Z_legacy_window",
    schemaVersion: "stress-evidence-v1",
  });
  delete bundle.run.windowStart;
  delete bundle.run.windowEnd;
  const path = await writeBundle(bundle);
  const summary = dryRun(path, ["--gate", "off"]);

  assert.equal(summary.keyFormat, "v1");
  assert.ok(
    summary.warnings.some((warning) =>
      warning.includes("windowStart/windowEnd missing"),
    ),
  );
});

test("a CLI token cannot bypass missing environment credentials", () => {
  const result = runRecorder([
    "--bundle",
    join(fixtures, "run-bundle.json"),
    "--token",
    "cli-secret",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /BASE_URL and TEABLE_TOKEN are required/);
});

test("canonical v2 requires explicit environment and code version", async () => {
  const bundle = canonicalBundle();
  delete bundle.run.codeVersion;
  const path = await writeBundle(bundle);
  const result = runRecorder(["--bundle", path, "--dry-run"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /environment, codeVersion, environmentBaseline/);
});

test("enforce clears Actual_Run_Cost to null when coverage is partial", async () => {
  const bundle = canonicalBundle();
  bundle.costs[2].actualAmount = null;
  const path = await writeBundle(bundle);
  const summary = dryRun(path);

  assert.equal(summary.gate.cost.coverage, "partial");
  assert.equal(summary.records[0].values.Actual_Run_Cost, null);
});

test("canonical v2 rejects metric windows outside the run", async () => {
  const bundle = canonicalBundle();
  bundle.metrics[0].windowStart = "2026-10-26T00:05:00Z";
  bundle.metrics[0].windowEnd = "2026-10-26T00:15:00Z";
  const path = await writeBundle(bundle);
  const result = runRecorder(["--bundle", path, "--dry-run"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /window must be contained in the run window/);
});

test("the recorder does not synthesize Deleted_At_Source", async () => {
  const bundle = canonicalBundle();
  delete bundle.resources[0].deletedAtSource;
  const path = await writeBundle(bundle);
  const summary = dryRun(path, ["--gate", "off"]);
  const resource = summary.records.find(
    (record) => record.tableId === DEFAULT_EVIDENCE_TABLE_IDS.resource,
  );

  assert.equal(resource.values.Deleted_At_Source, undefined);
});
