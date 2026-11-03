import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildUnifiedReport,
  parseCliArgs,
} from "./benchmark-unified-report.mjs";

const fixedSummary = (overrides = {}) => ({
  schema: "tea-bench-ci/1",
  backend: "postgres",
  score: 99,
  verdict: "pass",
  coverage: { requestedRuleIds: ["R-ONE"], executedRuleIds: ["R-ONE"] },
  cases: [
    {
      scenarioId: "scenario-one",
      ruleId: "R-ONE",
      title: "Fixed workload",
      correctnessVerdict: "pass",
      performanceVerdict: "pass",
      score: 88,
      caseP95Ms: 12.5,
      caseBudgetMs: 20,
      operations: [
        { key: "write", p95Ms: 7.5, budgetMs: 10, score: 75, verdict: "pass" },
      ],
      runPath: null,
      sourceFullScaleScenarioId: null,
      exclusionEvidence: null,
      dimensions: {},
    },
  ],
  ...overrides,
});

const complexitySummary = (overrides = {}) => ({
  schema: "tea-bench-complexity-score-gate/3",
  mode: "gate",
  backend: "postgres",
  modelVersion: "complexity-budget-v1",
  generatedAt: "2026-10-30T00:00:00.000Z",
  runner: "github-ubuntu-latest-node24-postgres16",
  requestedSamplesPerPoint: 20,
  calibrationEvidence: { status: "loaded" },
  verdict: "pass",
  executionErrors: [],
  series: [
    {
      ruleId: "R-FORMULA-004",
      operationKey: "flush-computed",
      operationFamily: "R-FORMULA-004/flush-computed",
      dimension: "graphDepth",
      requestedWorkUnits: { gate: 8 },
      receipt: {
        role: "gate",
        ruleId: "R-FORMULA-004",
        operationKey: "flush-computed",
        operationFamily: "R-FORMULA-004/flush-computed",
        workUnits: 8,
        complexityAssessment: { score: 303.9 },
        correctnessVerdict: "pass",
        actualP95Ms: 42.125,
      },
      gate: {
        verdict: "pass",
        reason: null,
        actualP95Ms: 42.125,
        maxP95Ms: 90,
        prediction: { empiricalP95Ms: 30 },
      },
    },
  ],
  ...overrides,
});

const SOURCE_SHA = "a".repeat(40);
const HARNESS_SHA = "b".repeat(40);

const provenance = (overrides = {}) => ({
  schema: 1,
  source: { repository: "teableio/teable-ee", sha: SOURCE_SHA },
  harness: { repository: "teableio/teable-perf-lab", sha: HARNESS_SHA },
  lockfiles: {},
  ...overrides,
});

async function putProvenance(root, family, value = provenance()) {
  const directory = join(root, `headless-bench-${family}`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "source.json"),
    typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
    "utf8",
  );
}

async function putSummary(
  root,
  family,
  value,
  sourceProvenance = provenance(),
) {
  if (sourceProvenance === null) {
    await mkdir(join(root, `headless-bench-${family}`), { recursive: true });
  } else {
    await putProvenance(root, family, sourceProvenance);
  }
  await writeFile(
    join(root, `headless-bench-${family}`, "summary.json"),
    typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
    "utf8",
  );
}

async function temporaryRoot() {
  return mkdtemp(join(tmpdir(), "benchmark-unified-report-"));
}

test("renders one fixed row per case with failure detail and a real score-model example", async () => {
  const rootDir = await temporaryRoot();
  const fixed = fixedSummary();
  fixed.cases[0].operations.push({
    key: "failing-op",
    p95Ms: 25,
    budgetMs: 10,
    score: 40,
    verdict: "fail",
  });
  await putSummary(rootDir, "write", fixed);
  await putSummary(rootDir, "complexity-score", complexitySummary());

  const result = await buildUnifiedReport({
    rootDir,
    sourceSha: SOURCE_SHA,
    harnessSha: HARNESS_SHA,
    expectedFamilies: ["write", "complexity-score"],
  });

  assert.equal(
    result.passed,
    false,
    "an operation failure must fail the whole report",
  );
  assert.equal(
    (result.markdown.match(/^\| ---/gm) ?? []).length,
    1,
    "there is one table",
  );
  assert.match(result.markdown, /fixed-budget \/ whole workload/);
  assert.doesNotMatch(result.markdown, /fixed-budget \/ operation/);
  assert.match(result.markdown, /score-model \/ gate operation/);
  assert.equal(
    result.rows.filter(
      (row) =>
        row.family === "write" &&
        row.kindScope === "fixed-budget / whole workload",
    ).length,
    1,
  );
  assert.match(
    result.markdown,
    /scenario-one[^\n]*fail[^\n]*failing-op fail \(actual 25 ms, budget 10 ms\)/,
  );
  assert.match(result.markdown, /303\.900[^\n]*30[^\n]*90[^\n]*42\.125/);
  assert.match(
    result.markdown,
    /Measured example: .*complexity score 303\.900.*expected p95 30 ms.*budget 90 ms.*actual p95 42\.125 ms/,
  );
  assert.doesNotMatch(result.markdown, /```(?:json)?/i);
});

test("shows missing and invalid families as fail-closed rows without invented measurements", async () => {
  const rootDir = await temporaryRoot();
  await putProvenance(rootDir, "missing");
  await putSummary(rootDir, "invalid", "{not json");

  const result = await buildUnifiedReport({
    rootDir,
    sourceSha: SOURCE_SHA,
    harnessSha: HARNESS_SHA,
    expectedFamilies: ["missing", "invalid"],
  });

  assert.equal(result.passed, false);
  assert.match(result.markdown, /missing[^\n]*Missing summary/);
  assert.match(result.markdown, /invalid[^\n]*Invalid summary/);
  assert.match(result.markdown, /Example unavailable/);
  assert.doesNotMatch(result.markdown, /\b0(?:\.0+)? ms\b/);
});

test("rejects mismatched field types and reports duplicate row identities", async () => {
  const rootDir = await temporaryRoot();
  const wrongType = fixedSummary();
  wrongType.cases[0].caseP95Ms = "12.5";
  await putSummary(rootDir, "wrong-type", wrongType);

  const duplicate = fixedSummary({
    cases: [fixedSummary().cases[0], fixedSummary().cases[0]],
  });
  await putSummary(rootDir, "duplicate", duplicate);

  const result = await buildUnifiedReport({
    rootDir,
    sourceSha: SOURCE_SHA,
    harnessSha: HARNESS_SHA,
    expectedFamilies: ["wrong-type", "duplicate"],
  });

  assert.equal(result.passed, false);
  assert.match(
    result.markdown,
    /caseP95Ms must be a non-negative finite number or null/,
  );
  assert.match(result.markdown, /Duplicate identity: case:scenario-one/);
});

test("escapes untrusted Markdown and exposes failed family status", async () => {
  const rootDir = await temporaryRoot();
  const summary = fixedSummary();
  summary.cases[0].scenarioId = "unsafe|row\n<script>alert(1)</script>";
  await putSummary(rootDir, "write", summary);

  const result = await buildUnifiedReport({
    rootDir,
    sourceSha: SOURCE_SHA,
    harnessSha: HARNESS_SHA,
    expectedFamilies: ["write"],
    familyStatuses: { write: "failure" },
  });

  assert.equal(result.passed, false);
  assert.match(
    result.markdown,
    /unsafe\\\|row &lt;script&gt;alert\(1\)&lt;\/script&gt;/,
  );
  assert.doesNotMatch(result.markdown, /<script>/);
  assert.match(result.markdown, /Job status: failure/);
});

test("fails stale passing evidence when the current runtime producer failed", async () => {
  const rootDir = await temporaryRoot();
  await putSummary(rootDir, "write", fixedSummary());

  const result = await buildUnifiedReport({
    rootDir,
    sourceSha: SOURCE_SHA,
    harnessSha: HARNESS_SHA,
    expectedFamilies: ["write"],
    runtimeStatus: "failure",
    benchStatus: "skipped",
  });

  assert.equal(result.passed, false);
  assert.deepEqual(
    new Set(
      result.rows
        .filter((row) => row.family === "execution")
        .map((row) => row.identity),
    ),
    new Set(["runtime producer", "benchmark matrix"]),
  );
  assert.ok(
    result.rows
      .filter((row) => row.family === "execution")
      .every((row) => row.performance === "fail"),
  );
  assert.equal(
    result.rows.find(
      (row) =>
        row.family === "write" && row.identity === "R-ONE / scenario-one",
    )?.performance,
    "pass",
  );
});

test("fails closed when a benchmark leg fails before producing an archive", async () => {
  const rootDir = await temporaryRoot();

  const result = await buildUnifiedReport({
    rootDir,
    sourceSha: SOURCE_SHA,
    harnessSha: HARNESS_SHA,
    expectedFamilies: ["write"],
    benchStatus: "failure",
  });

  assert.equal(result.passed, false);
  assert.deepEqual(
    new Set(result.rows.map((row) => row.identity)),
    new Set(["benchmark matrix", "provenance"]),
  );
  assert.ok(result.rows.every((row) => row.performance === "fail"));
});

test("reuses healthy sibling evidence when effective rerun statuses succeed", async () => {
  const rootDir = await temporaryRoot();
  await putSummary(rootDir, "write", fixedSummary());
  await putSummary(rootDir, "formula", fixedSummary());

  const result = await buildUnifiedReport({
    rootDir,
    sourceSha: SOURCE_SHA,
    harnessSha: HARNESS_SHA,
    expectedFamilies: ["write", "formula"],
    runtimeStatus: "success",
    benchStatus: "success",
  });

  assert.equal(result.passed, true);
  assert.equal(
    result.rows.filter(
      (row) => row.kindScope === "fixed-budget / whole workload",
    ).length,
    2,
  );
  assert.equal(
    result.rows.some((row) => row.family === "execution"),
    false,
  );
});

test("reports no example when valid summaries contain no measured budget pair", async () => {
  const rootDir = await temporaryRoot();
  const summary = fixedSummary();
  summary.verdict = "inconclusive";
  summary.cases[0].performanceVerdict = "not-compared";
  summary.cases[0].caseP95Ms = null;
  summary.cases[0].caseBudgetMs = null;
  summary.cases[0].operations = [];
  await putSummary(rootDir, "write", summary);

  const result = await buildUnifiedReport({
    rootDir,
    sourceSha: SOURCE_SHA,
    harnessSha: HARNESS_SHA,
    expectedFamilies: ["write"],
  });

  assert.equal(result.passed, false);
  assert.match(
    result.markdown,
    /Example unavailable: no valid measured operation or case was reported/,
  );
  assert.match(result.markdown, /Summary verdict: inconclusive/);
});

test("rejects missing, invalid, stale, and cross-harness provenance without trusting summaries", async () => {
  const rootDir = await temporaryRoot();
  const staleSource = "c".repeat(40);
  const otherHarness = "d".repeat(40);
  await putSummary(rootDir, "missing-provenance", fixedSummary(), null);
  await putSummary(
    rootDir,
    "malformed-provenance",
    fixedSummary(),
    "{not json",
  );
  await putSummary(
    rootDir,
    "schema-provenance",
    fixedSummary(),
    provenance({ schema: 2 }),
  );
  await putSummary(
    rootDir,
    "stale-source",
    fixedSummary(),
    provenance({
      source: { repository: "teableio/teable-ee", sha: staleSource },
    }),
  );
  await putSummary(
    rootDir,
    "cross-harness",
    fixedSummary(),
    provenance({
      harness: { repository: "teableio/teable-perf-lab", sha: otherHarness },
    }),
  );

  const result = await buildUnifiedReport({
    rootDir,
    sourceSha: SOURCE_SHA,
    harnessSha: HARNESS_SHA,
    expectedFamilies: [
      "missing-provenance",
      "malformed-provenance",
      "schema-provenance",
      "stale-source",
      "cross-harness",
    ],
  });

  assert.equal(result.passed, false);
  assert.match(result.markdown, /missing-provenance[^\n]*Missing source\.json/);
  assert.match(
    result.markdown,
    /malformed-provenance[^\n]*Invalid source\.json/,
  );
  assert.match(
    result.markdown,
    /schema-provenance[^\n]*source\.json\.schema must be 1/,
  );
  assert.match(
    result.markdown,
    /stale-source[^\n]*Source revision mismatch[^\n]*does not match expected/,
  );
  assert.match(
    result.markdown,
    /cross-harness[^\n]*Harness revision mismatch[^\n]*does not match expected/,
  );
  assert.equal(result.rows.length, 5, "untrusted summaries contribute no rows");
  assert.ok(
    result.rows.every(
      (row) => row.performance === "fail" && row.correctness === "unknown",
    ),
  );
});

test("requires exact expected source and harness revisions", async () => {
  const rootDir = await temporaryRoot();
  await putSummary(rootDir, "write", fixedSummary());

  await assert.rejects(
    buildUnifiedReport({
      rootDir,
      expectedFamilies: ["write"],
      harnessSha: HARNESS_SHA,
    }),
    /sourceSha must be an exact 40-character lowercase SHA/,
  );
  await assert.rejects(
    buildUnifiedReport({
      rootDir,
      expectedFamilies: ["write"],
      sourceSha: SOURCE_SHA,
      harnessSha: "B".repeat(40),
    }),
    /harnessSha must be an exact 40-character lowercase SHA/,
  );
});

test("parses shell-friendly CLI arguments and rejects duplicate families", () => {
  assert.deepEqual(
    parseCliArgs([
      "--root",
      "artifacts",
      "--source-sha",
      SOURCE_SHA,
      "--harness-sha",
      HARNESS_SHA,
      "--families",
      "write,complexity-score",
      "--status",
      "write=success",
      "--status",
      "complexity-score=failure",
      "--runtime-status",
      "success",
      "--bench-status",
      "failure",
      "--output",
      "bench-unified.md",
    ]),
    {
      rootDir: "artifacts",
      expectedFamilies: ["write", "complexity-score"],
      sourceSha: SOURCE_SHA,
      harnessSha: HARNESS_SHA,
      familyStatuses: { write: "success", "complexity-score": "failure" },
      runtimeStatus: "success",
      benchStatus: "failure",
      outputPath: "bench-unified.md",
    },
  );
  assert.throws(
    () =>
      parseCliArgs([
        "--root",
        "artifacts",
        "--source-sha",
        SOURCE_SHA,
        "--harness-sha",
        HARNESS_SHA,
        "--families",
        "write,write",
      ]),
    /Duplicate expected family/,
  );
  assert.throws(
    () => parseCliArgs(["--root", "artifacts", "--families", "write"]),
    /--source-sha is required/,
  );
  assert.throws(
    () =>
      parseCliArgs([
        "--root",
        "artifacts",
        "--families",
        "write",
        "--source-sha",
        "abc",
        "--harness-sha",
        HARNESS_SHA,
      ]),
    /--source-sha must be an exact 40-character lowercase SHA/,
  );
});
