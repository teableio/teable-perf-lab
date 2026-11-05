#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const FIXED_SCHEMA = "tea-bench-ci/1";
const COMPLEXITY_SCHEMA = "tea-bench-complexity-score-gate/3";
const FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROVENANCE_SCHEMA = 1;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const JOB_STATUSES = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "neutral",
  "stale",
]);
const CORRECTNESS_VERDICTS = new Set(["pass", "fail", "inconclusive"]);
const PERFORMANCE_VERDICTS = new Set([
  "pass",
  "fail",
  "inconclusive",
  "not-compared",
]);
const OPERATION_VERDICTS = new Set(["pass", "fail", "inconclusive"]);

const usage = `Usage: node headless/scripts/benchmark-unified-report.mjs \\
  --root <extracted-artifacts-dir> \\
  --families <family[,family...]> \\
  --source-sha <expected-source-sha> \\
  --harness-sha <expected-harness-sha> \\
  [--status <family>=<job-status>]... \\
  [--runtime-status <job-status>] \\
  [--bench-status <job-status>] \\
  [--output <markdown-file|->]

Each expected family is read from <root>/headless-bench-<family>/summary.json.
Its provenance is read from <root>/headless-bench-<family>/source.json and must match
--source-sha and --harness-sha exactly.
The report is still written when evidence is missing or invalid, then the command exits 1.`;

function record(value, location) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value;
}

function array(value, location) {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  return value;
}

function string(value, location) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function enumeration(value, allowed, location) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`${location} has an unsupported verdict`);
  }
  return value;
}

function nullableNumber(value, location, { nonnegative = false } = {}) {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (nonnegative && value < 0)
  ) {
    const qualifier = nonnegative
      ? "a non-negative finite number or null"
      : "a finite number or null";
    throw new Error(`${location} must be ${qualifier}`);
  }
  return value;
}

function number(value, location, options) {
  const result = nullableNumber(value, location, options);
  if (result === null) throw new Error(`${location} must not be null`);
  return result;
}

function validateFamily(family, location = "family") {
  if (typeof family !== "string" || !FAMILY_PATTERN.test(family)) {
    throw new Error(`${location} must match ${FAMILY_PATTERN}`);
  }
  return family;
}

function validateExpectedSha(value, location) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new Error(`${location} must be an exact 40-character lowercase SHA`);
  }
  return value;
}

function validateProvenance(value, { sourceSha, harnessSha }) {
  const provenance = record(value, "source.json");
  if (provenance.schema !== PROVENANCE_SCHEMA) {
    throw new Error(`source.json.schema must be ${PROVENANCE_SCHEMA}`);
  }
  const source = record(provenance.source, "source.json.source");
  string(source.repository, "source.json.source.repository");
  if (source.sha !== sourceSha) {
    throw new Error(
      `Source revision mismatch: source.json source.sha ${
        typeof source.sha === "string" ? source.sha : "(missing)"
      } does not match expected ${sourceSha}`,
    );
  }
  const harness = record(provenance.harness, "source.json.harness");
  string(harness.repository, "source.json.harness.repository");
  if (harness.sha !== harnessSha) {
    throw new Error(
      `Harness revision mismatch: source.json harness.sha ${
        typeof harness.sha === "string" ? harness.sha : "(missing)"
      } does not match expected ${harnessSha}`,
    );
  }
  record(provenance.lockfiles, "source.json.lockfiles");
}

function validateFixedSummary(value) {
  const summary = record(value, "summary");
  if (summary.schema !== FIXED_SCHEMA)
    throw new Error(`summary.schema must be ${FIXED_SCHEMA}`);
  if (summary.backend !== "pglite" && summary.backend !== "postgres") {
    throw new Error("summary.backend must be pglite or postgres");
  }
  enumeration(summary.verdict, CORRECTNESS_VERDICTS, "summary.verdict");
  nullableNumber(summary.score, "summary.score");

  const coverage = record(summary.coverage, "summary.coverage");
  const requestedRuleIds = array(
    coverage.requestedRuleIds,
    "summary.coverage.requestedRuleIds",
  ).map((item, index) =>
    string(item, `summary.coverage.requestedRuleIds[${index}]`),
  );
  const executedRuleIds = array(
    coverage.executedRuleIds,
    "summary.coverage.executedRuleIds",
  ).map((item, index) =>
    string(item, `summary.coverage.executedRuleIds[${index}]`),
  );

  const cases = array(summary.cases, "summary.cases").map(
    (rawCase, caseIndex) => {
      const item = record(rawCase, `summary.cases[${caseIndex}]`);
      const at = `summary.cases[${caseIndex}]`;
      const operations = array(item.operations, `${at}.operations`).map(
        (rawOperation, operationIndex) => {
          const operation = record(
            rawOperation,
            `${at}.operations[${operationIndex}]`,
          );
          const operationAt = `${at}.operations[${operationIndex}]`;
          const verdict = enumeration(
            operation.verdict,
            OPERATION_VERDICTS,
            `${operationAt}.verdict`,
          );
          const p95Ms = nullableNumber(
            operation.p95Ms,
            `${operationAt}.p95Ms`,
            {
              nonnegative: true,
            },
          );
          const budgetMs = nullableNumber(
            operation.budgetMs,
            `${operationAt}.budgetMs`,
            {
              nonnegative: true,
            },
          );
          nullableNumber(operation.score, `${operationAt}.score`);
          if (
            (verdict === "pass" || verdict === "fail") &&
            (p95Ms === null || budgetMs === null)
          ) {
            throw new Error(
              `${operationAt} has a conclusive verdict without p95Ms and budgetMs`,
            );
          }
          return {
            key: string(operation.key, `${operationAt}.key`),
            p95Ms,
            budgetMs,
            verdict,
          };
        },
      );
      const performanceVerdict = enumeration(
        item.performanceVerdict,
        PERFORMANCE_VERDICTS,
        `${at}.performanceVerdict`,
      );
      const caseP95Ms = nullableNumber(item.caseP95Ms, `${at}.caseP95Ms`, {
        nonnegative: true,
      });
      const caseBudgetMs = nullableNumber(
        item.caseBudgetMs,
        `${at}.caseBudgetMs`,
        {
          nonnegative: true,
        },
      );
      nullableNumber(item.score, `${at}.score`);
      if (
        (performanceVerdict === "pass" || performanceVerdict === "fail") &&
        (caseP95Ms === null || caseBudgetMs === null)
      ) {
        throw new Error(
          `${at} has a conclusive performance verdict without case p95 and budget`,
        );
      }
      return {
        scenarioId: string(item.scenarioId, `${at}.scenarioId`),
        ruleId: string(item.ruleId, `${at}.ruleId`),
        title: string(item.title, `${at}.title`),
        correctnessVerdict: enumeration(
          item.correctnessVerdict,
          CORRECTNESS_VERDICTS,
          `${at}.correctnessVerdict`,
        ),
        performanceVerdict,
        caseP95Ms,
        caseBudgetMs,
        operations,
      };
    },
  );

  return {
    verdict: summary.verdict,
    requestedRuleIds,
    executedRuleIds,
    cases,
  };
}

function validateComplexitySummary(value) {
  const summary = record(value, "summary");
  if (summary.schema !== COMPLEXITY_SCHEMA) {
    throw new Error(`summary.schema must be ${COMPLEXITY_SCHEMA}`);
  }
  if (summary.mode !== "gate") throw new Error("summary.mode must be gate");
  if (summary.backend !== "postgres")
    throw new Error("summary.backend must be postgres");
  string(summary.modelVersion, "summary.modelVersion");
  string(summary.generatedAt, "summary.generatedAt");
  string(summary.runner, "summary.runner");
  const requestedSamplesPerPoint = number(
    summary.requestedSamplesPerPoint,
    "summary.requestedSamplesPerPoint",
    { nonnegative: true },
  );
  if (
    !Number.isInteger(requestedSamplesPerPoint) ||
    requestedSamplesPerPoint < 1
  ) {
    throw new Error(
      "summary.requestedSamplesPerPoint must be a positive integer",
    );
  }
  record(summary.calibrationEvidence, "summary.calibrationEvidence");
  const verdict = enumeration(
    summary.verdict,
    CORRECTNESS_VERDICTS,
    "summary.verdict",
  );
  const executionErrors = array(
    summary.executionErrors,
    "summary.executionErrors",
  );
  const series = array(summary.series, "summary.series").map(
    (rawSeries, seriesIndex) => {
      const item = record(rawSeries, `summary.series[${seriesIndex}]`);
      const at = `summary.series[${seriesIndex}]`;
      const requestedWorkUnits = record(
        item.requestedWorkUnits,
        `${at}.requestedWorkUnits`,
      );
      const gateWorkUnits = number(
        requestedWorkUnits.gate,
        `${at}.requestedWorkUnits.gate`,
        {
          nonnegative: true,
        },
      );
      const ruleId = string(item.ruleId, `${at}.ruleId`);
      const operationKey = string(item.operationKey, `${at}.operationKey`);
      const operationFamily = string(
        item.operationFamily,
        `${at}.operationFamily`,
      );
      const dimension = string(item.dimension, `${at}.dimension`);

      let receipt = null;
      if (item.receipt !== null) {
        const rawReceipt = record(item.receipt, `${at}.receipt`);
        const receiptRuleId = string(rawReceipt.ruleId, `${at}.receipt.ruleId`);
        const receiptOperationKey = string(
          rawReceipt.operationKey,
          `${at}.receipt.operationKey`,
        );
        const receiptOperationFamily = string(
          rawReceipt.operationFamily,
          `${at}.receipt.operationFamily`,
        );
        const receiptWorkUnits = number(
          rawReceipt.workUnits,
          `${at}.receipt.workUnits`,
          {
            nonnegative: true,
          },
        );
        if (
          receiptRuleId !== ruleId ||
          receiptOperationKey !== operationKey ||
          receiptOperationFamily !== operationFamily ||
          receiptWorkUnits !== gateWorkUnits
        ) {
          throw new Error(`${at}.receipt identity does not match its series`);
        }
        let complexityScore = null;
        if (rawReceipt.complexityAssessment !== null) {
          const assessment = record(
            rawReceipt.complexityAssessment,
            `${at}.receipt.complexityAssessment`,
          );
          complexityScore = nullableNumber(
            assessment.score,
            `${at}.receipt.complexityAssessment.score`,
            { nonnegative: true },
          );
        }
        receipt = {
          correctnessVerdict: enumeration(
            rawReceipt.correctnessVerdict,
            CORRECTNESS_VERDICTS,
            `${at}.receipt.correctnessVerdict`,
          ),
          actualP95Ms: nullableNumber(
            rawReceipt.actualP95Ms,
            `${at}.receipt.actualP95Ms`,
            {
              nonnegative: true,
            },
          ),
          complexityScore,
        };
      }

      const gate = record(item.gate, `${at}.gate`);
      const gateVerdict = enumeration(
        gate.verdict,
        new Set(["pass", "fail", "unknown"]),
        `${at}.gate.verdict`,
      );
      const actualP95Ms = nullableNumber(
        gate.actualP95Ms,
        `${at}.gate.actualP95Ms`,
        {
          nonnegative: true,
        },
      );
      const maxP95Ms = nullableNumber(gate.maxP95Ms, `${at}.gate.maxP95Ms`, {
        nonnegative: true,
      });
      let expectedP95Ms = null;
      let reason = null;
      if (gateVerdict === "unknown") {
        reason = string(gate.reason, `${at}.gate.reason`);
        if (gate.prediction !== null || maxP95Ms !== null) {
          throw new Error(
            `${at}.gate unknown verdict must not claim a prediction or budget`,
          );
        }
      } else {
        if (gate.reason !== null)
          throw new Error(
            `${at}.gate conclusive verdict must have null reason`,
          );
        const prediction = record(gate.prediction, `${at}.gate.prediction`);
        expectedP95Ms = number(
          prediction.empiricalP95Ms,
          `${at}.gate.prediction.empiricalP95Ms`,
          { nonnegative: true },
        );
        if (actualP95Ms === null || maxP95Ms === null) {
          throw new Error(
            `${at}.gate conclusive verdict requires actualP95Ms and maxP95Ms`,
          );
        }
      }
      if (
        receipt !== null &&
        receipt.actualP95Ms !== null &&
        actualP95Ms !== null &&
        receipt.actualP95Ms !== actualP95Ms
      ) {
        throw new Error(
          `${at}.receipt actualP95Ms does not match gate actualP95Ms`,
        );
      }

      return {
        ruleId,
        operationKey,
        operationFamily,
        dimension,
        gateWorkUnits,
        receipt,
        gate: {
          verdict: gateVerdict,
          reason,
          actualP95Ms,
          maxP95Ms,
          expectedP95Ms,
        },
      };
    },
  );

  return { verdict, executionErrorCount: executionErrors.length, series };
}

function effectiveCasePerformance(item) {
  if (
    item.performanceVerdict === "fail" ||
    item.operations.some((operation) => operation.verdict === "fail")
  ) {
    return "fail";
  }
  if (item.performanceVerdict !== "pass") return item.performanceVerdict;
  return item.operations.every((operation) => operation.verdict === "pass")
    ? "pass"
    : "inconclusive";
}

function diagnosticRow(
  family,
  identity,
  details,
  performance = "fail",
  kindScope = "evidence / family",
) {
  return {
    family,
    identity,
    kindScope,
    complexityScore: null,
    expectedP95Ms: null,
    budgetP95Ms: null,
    actualP95Ms: null,
    correctness: "unknown",
    performance,
    details,
    identityKey: null,
    exampleKind: null,
  };
}

function fixedRows(family, summary) {
  const rows = [];
  for (const item of summary.cases) {
    const effectivePerformance = effectiveCasePerformance(item);
    const exceptionalOperations = item.operations.filter(
      (operation) => operation.verdict !== "pass",
    );
    const operationDetails = exceptionalOperations.map((operation) => {
      const actual =
        operation.p95Ms === null
          ? "actual unavailable"
          : `actual ${formatMetric(operation.p95Ms)} ms`;
      const budget =
        operation.budgetMs === null
          ? "budget unavailable"
          : `budget ${formatMetric(operation.budgetMs)} ms`;
      return `${operation.key} ${operation.verdict} (${actual}, ${budget})`;
    });
    rows.push({
      family,
      identity: `${item.ruleId} / ${item.scenarioId}`,
      kindScope: "fixed-budget / whole workload",
      complexityScore: null,
      expectedP95Ms: null,
      budgetP95Ms: item.caseBudgetMs,
      actualP95Ms: item.caseP95Ms,
      correctness: item.correctnessVerdict,
      performance: effectivePerformance,
      details: [item.title, ...operationDetails].join("; "),
      identityKey: `case:${item.scenarioId}`,
      exampleKind: "fixed",
    });
  }
  if (summary.cases.length === 0) {
    rows.push(diagnosticRow(family, "summary", "Summary contains no cases"));
  }
  const requested = [...new Set(summary.requestedRuleIds)].sort();
  const executed = [...new Set(summary.executedRuleIds)].sort();
  const coverageMatches =
    requested.length === executed.length &&
    requested.every((ruleId, index) => ruleId === executed[index]);
  if (!coverageMatches) {
    rows.push(
      diagnosticRow(
        family,
        "coverage",
        `Coverage mismatch: requested ${requested.length} rule(s), executed ${executed.length}`,
      ),
    );
  }
  if (summary.verdict !== "pass") {
    rows.push(
      diagnosticRow(
        family,
        "summary",
        `Summary verdict: ${summary.verdict}`,
        summary.verdict === "fail" ? "fail" : "inconclusive",
      ),
    );
  }
  return rows;
}

function complexityRows(family, summary) {
  const rows = summary.series.map((item) => ({
    family,
    identity: `${item.ruleId} / ${item.operationKey} / ${item.dimension}=${formatMetric(
      item.gateWorkUnits,
    )}`,
    kindScope: "score-model / gate operation",
    complexityScore: item.receipt?.complexityScore ?? null,
    expectedP95Ms: item.gate.expectedP95Ms,
    budgetP95Ms: item.gate.maxP95Ms,
    actualP95Ms: item.gate.actualP95Ms,
    correctness: item.receipt?.correctnessVerdict ?? "inconclusive",
    performance:
      item.gate.verdict === "unknown"
        ? `unknown:${item.gate.reason}`
        : item.gate.verdict,
    details:
      item.receipt === null ? "Missing gate receipt" : item.operationFamily,
    identityKey: `score:${item.operationFamily}/${item.gateWorkUnits}`,
    exampleKind: "complexity",
  }));
  if (summary.series.length === 0) {
    rows.push(
      diagnosticRow(
        family,
        "summary",
        "Summary contains no score-model series",
      ),
    );
  }
  if (summary.executionErrorCount > 0) {
    rows.push(
      diagnosticRow(
        family,
        "execution errors",
        `Summary contains ${summary.executionErrorCount} execution error(s)`,
      ),
    );
  }
  if (summary.verdict !== "pass") {
    rows.push(
      diagnosticRow(
        family,
        "summary",
        `Summary verdict: ${summary.verdict}`,
        summary.verdict === "fail" ? "fail" : "inconclusive",
      ),
    );
  }
  return rows;
}

async function provenanceRowsForFamily(rootDir, family, expected) {
  const provenancePath = join(
    rootDir,
    `headless-bench-${family}`,
    "source.json",
  );
  let provenance;
  try {
    provenance = await readFile(provenancePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [diagnosticRow(family, "provenance", "Missing source.json")];
    }
    return [
      diagnosticRow(
        family,
        "provenance",
        `Unreadable source.json: ${errorMessage(error)}`,
      ),
    ];
  }

  try {
    validateProvenance(JSON.parse(provenance), expected);
    return [];
  } catch (error) {
    return [
      diagnosticRow(
        family,
        "provenance",
        `Invalid source.json: ${errorMessage(error)}`,
      ),
    ];
  }
}

async function rowsForFamily(rootDir, family, expected) {
  const provenanceRows = await provenanceRowsForFamily(
    rootDir,
    family,
    expected,
  );
  if (provenanceRows.length > 0) return provenanceRows;
  const summaryPath = join(rootDir, `headless-bench-${family}`, "summary.json");
  let source;
  try {
    source = await readFile(summaryPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [diagnosticRow(family, "summary", "Missing summary")];
    }
    return [
      diagnosticRow(
        family,
        "summary",
        `Unreadable summary: ${errorMessage(error)}`,
      ),
    ];
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return [
      diagnosticRow(
        family,
        "summary",
        `Invalid summary: ${errorMessage(error)}`,
      ),
    ];
  }

  try {
    const parsed = record(value, "summary");
    if (parsed.schema === FIXED_SCHEMA)
      return fixedRows(family, validateFixedSummary(parsed));
    if (parsed.schema === COMPLEXITY_SCHEMA) {
      return complexityRows(family, validateComplexitySummary(parsed));
    }
    return [
      diagnosticRow(
        family,
        "summary",
        `Invalid summary: unsupported schema ${
          typeof parsed.schema === "string" ? parsed.schema : "(missing)"
        }`,
      ),
    ];
  } catch (error) {
    return [
      diagnosticRow(
        family,
        "summary",
        `Invalid summary: ${errorMessage(error)}`,
      ),
    ];
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function duplicateRows(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (row.identityKey === null) continue;
    const key = `${row.family}\u0000${row.identityKey}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const diagnostics = [];
  for (const [key, count] of counts) {
    if (count < 2) continue;
    const separator = key.indexOf("\u0000");
    const family = key.slice(0, separator);
    const identity = key.slice(separator + 1);
    diagnostics.push(
      diagnosticRow(
        family,
        "duplicate identity",
        `Duplicate identity: ${identity} appears ${count} times`,
      ),
    );
  }
  return diagnostics;
}

function formatMetric(value) {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function formatScore(value) {
  return value === null ? "—" : value.toFixed(3);
}

function escapeCell(value) {
  return String(value)
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|");
}

function measuredExample(rows) {
  const complete = (row) =>
    row.actualP95Ms !== null &&
    row.budgetP95Ms !== null &&
    row.correctness !== "unknown";
  const dynamic = rows.find(
    (row) =>
      row.exampleKind === "complexity" &&
      row.complexityScore !== null &&
      row.expectedP95Ms !== null &&
      complete(row),
  );
  if (dynamic) {
    return `Measured example: ${escapeCell(dynamic.family)} / ${escapeCell(
      dynamic.identity,
    )} has complexity score ${formatScore(dynamic.complexityScore)}, expected p95 ${formatMetric(
      dynamic.expectedP95Ms,
    )} ms, budget ${formatMetric(dynamic.budgetP95Ms)} ms, and actual p95 ${formatMetric(
      dynamic.actualP95Ms,
    )} ms; correctness ${escapeCell(dynamic.correctness)} and performance ${escapeCell(
      dynamic.performance,
    )}.`;
  }
  const fixed = rows.find(
    (row) => row.exampleKind === "fixed" && complete(row),
  );
  if (fixed) {
    return `Measured example: ${escapeCell(fixed.family)} / ${escapeCell(
      fixed.identity,
    )} uses a fixed ${formatMetric(fixed.budgetP95Ms)} ms budget and measured ${formatMetric(
      fixed.actualP95Ms,
    )} ms; complexity score and expected p95 are not applicable to this fixed-budget workload. Correctness ${escapeCell(
      fixed.correctness,
    )}; performance ${escapeCell(fixed.performance)}.`;
  }
  return "Example unavailable: no valid measured operation or case was reported.";
}

export function renderUnifiedReport(rows, passed) {
  const lines = [
    "# Unified benchmark report",
    "",
    `Overall verdict: **${passed ? "PASS" : "FAIL"}**. Missing, invalid, duplicate, inconclusive, and non-success job evidence fails closed.`,
    "",
    "Kind / scope distinguishes fixed whole-workload budgets from score-model operations.",
    "Execution rows are the current effective workflow status. Family rows may be retained from an earlier attempt when GitHub reuses successful matrix siblings; retained rows remain evidence but cannot override a current non-success status.",
    "Each family summary is trusted only when its source.json matches the exact expected source and harness revisions; missing, invalid, stale, or cross-harness provenance rejects that summary.",
    "Complexity score is a ranking index emitted by the operation assessment; it is not milliseconds and is not the fixed gate’s performance score. A dash means the column is not applicable or the evidence is absent.",
    "Expected p95 is emitted only by the pinned score model. Budget p95 is the comparison threshold, actual p95 is the measured latency, correctness is the oracle result, and performance verdict is the budget comparison.",
    "",
    "| Family | Identity | Kind / scope | Complexity score | Expected p95 (ms) | Budget p95 (ms) | Actual p95 (ms) | Correctness | Performance verdict | Details |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${escapeCell(row.family)} | ${escapeCell(row.identity)} | ${escapeCell(
          row.kindScope,
        )} | ${formatScore(row.complexityScore)} | ${formatMetric(
          row.expectedP95Ms,
        )} | ${formatMetric(row.budgetP95Ms)} | ${formatMetric(
          row.actualP95Ms,
        )} | ${escapeCell(row.correctness)} | ${escapeCell(row.performance)} | ${escapeCell(
          row.details,
        )} |`,
    ),
    "",
    measuredExample(rows),
    "",
  ];
  return lines.join("\n");
}

export async function buildUnifiedReport({
  rootDir,
  expectedFamilies,
  familyStatuses = {},
  runtimeStatus,
  benchStatus,
  sourceSha,
  harnessSha,
}) {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    throw new Error("rootDir is required");
  }
  if (!Array.isArray(expectedFamilies) || expectedFamilies.length === 0) {
    throw new Error("expectedFamilies must contain at least one family");
  }
  const expected = {
    sourceSha: validateExpectedSha(sourceSha, "sourceSha"),
    harnessSha: validateExpectedSha(harnessSha, "harnessSha"),
  };
  const seenFamilies = new Set();
  for (const family of expectedFamilies) {
    validateFamily(family, "expected family");
    if (seenFamilies.has(family))
      throw new Error(`Duplicate expected family: ${family}`);
    seenFamilies.add(family);
  }
  for (const [family, status] of Object.entries(familyStatuses)) {
    validateFamily(family, "status family");
    if (!seenFamilies.has(family))
      throw new Error(`Status supplied for unexpected family: ${family}`);
    if (!JOB_STATUSES.has(status))
      throw new Error(`Unsupported job status for ${family}: ${status}`);
  }
  if (runtimeStatus !== undefined && !JOB_STATUSES.has(runtimeStatus)) {
    throw new Error(`Unsupported runtime status: ${runtimeStatus}`);
  }
  if (benchStatus !== undefined && !JOB_STATUSES.has(benchStatus)) {
    throw new Error(`Unsupported benchmark matrix status: ${benchStatus}`);
  }

  const groups = await Promise.all(
    expectedFamilies.map(async (family) => {
      const rows = await rowsForFamily(rootDir, family, expected);
      const status = familyStatuses[family];
      if (status !== undefined && status !== "success") {
        rows.push(diagnosticRow(family, "job status", `Job status: ${status}`));
      }
      return rows;
    }),
  );
  const rows = groups.flat();
  if (runtimeStatus !== undefined && runtimeStatus !== "success") {
    rows.unshift(
      diagnosticRow(
        "execution",
        "runtime producer",
        `Current runtime producer status: ${runtimeStatus}. Retained family summaries remain visible as evidence but do not represent a current pass.`,
        "fail",
        "evidence / execution",
      ),
    );
  }
  if (benchStatus !== undefined && benchStatus !== "success") {
    rows.unshift(
      diagnosticRow(
        "execution",
        "benchmark matrix",
        `Current benchmark matrix status: ${benchStatus}. Retained family summaries remain visible as evidence but do not represent a current pass.`,
        "fail",
        "evidence / execution",
      ),
    );
  }
  rows.push(...duplicateRows(rows));
  const passed = rows.every(
    (row) => row.correctness === "pass" && row.performance === "pass",
  );
  return { markdown: renderUnifiedReport(rows, passed), passed, rows };
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
}

export function parseCliArgs(argv) {
  let rootDir;
  let outputPath = "-";
  let runtimeStatus;
  let benchStatus;
  let sourceSha;
  let harnessSha;
  const expectedFamilies = [];
  const familyStatuses = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--root") {
      rootDir = takeValue(argv, index, argument);
      index += 1;
    } else if (argument === "--source-sha") {
      sourceSha = takeValue(argv, index, argument);
      index += 1;
    } else if (argument === "--harness-sha") {
      harnessSha = takeValue(argv, index, argument);
      index += 1;
    } else if (argument === "--families") {
      const value = takeValue(argv, index, argument);
      expectedFamilies.push(
        ...value
          .split(",")
          .map((family) => family.trim())
          .filter((family) => family.length > 0),
      );
      index += 1;
    } else if (argument === "--status") {
      const value = takeValue(argv, index, argument);
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error("--status must be <family>=<status>");
      }
      const family = value.slice(0, separator);
      if (Object.hasOwn(familyStatuses, family))
        throw new Error(`Duplicate status: ${family}`);
      familyStatuses[family] = value.slice(separator + 1);
      index += 1;
    } else if (argument === "--runtime-status") {
      runtimeStatus = takeValue(argv, index, argument);
      index += 1;
    } else if (argument === "--bench-status") {
      benchStatus = takeValue(argv, index, argument);
      index += 1;
    } else if (argument === "--output") {
      outputPath = takeValue(argv, index, argument);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (rootDir === undefined) throw new Error("--root is required");
  if (expectedFamilies.length === 0) throw new Error("--families is required");
  if (sourceSha === undefined) throw new Error("--source-sha is required");
  if (harnessSha === undefined) throw new Error("--harness-sha is required");

  const seen = new Set();
  for (const family of expectedFamilies) {
    validateFamily(family, "expected family");
    if (seen.has(family))
      throw new Error(`Duplicate expected family: ${family}`);
    seen.add(family);
  }
  for (const [family, status] of Object.entries(familyStatuses)) {
    validateFamily(family, "status family");
    if (!seen.has(family))
      throw new Error(`Status supplied for unexpected family: ${family}`);
    if (!JOB_STATUSES.has(status))
      throw new Error(`Unsupported job status for ${family}: ${status}`);
  }
  if (runtimeStatus !== undefined && !JOB_STATUSES.has(runtimeStatus)) {
    throw new Error(`Unsupported runtime status: ${runtimeStatus}`);
  }
  if (benchStatus !== undefined && !JOB_STATUSES.has(benchStatus)) {
    throw new Error(`Unsupported benchmark matrix status: ${benchStatus}`);
  }
  return {
    rootDir,
    expectedFamilies,
    sourceSha: validateExpectedSha(sourceSha, "--source-sha"),
    harnessSha: validateExpectedSha(harnessSha, "--harness-sha"),
    familyStatuses,
    runtimeStatus,
    benchStatus,
    outputPath,
  };
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const result = await buildUnifiedReport(options);
  if (options.outputPath === "-") {
    process.stdout.write(result.markdown);
  } else {
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, result.markdown, "utf8");
  }
  if (!result.passed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(`benchmark-unified-report: ${errorMessage(error)}\n`);
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
  });
}
