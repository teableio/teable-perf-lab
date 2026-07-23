#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { readArtifactPayloads } from "./perf-artifact-read-model.mjs";
import { loadRegisteredCases } from "./run-plan.mjs";

const TRACE_CASE_BUDGET_MS = 15_000;
const TRACE_JOB_BUDGET_MS = 60_000;

const assertArray = (value, label) => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
};

const assertRecord = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
};

const nonEmptyString = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
};

const parseCaseFilter = (value, label) =>
  nonEmptyString(value, label)
    .split(",")
    .map((caseId) => nonEmptyString(caseId, `${label}[]`));

const resultIdentity = (caseId, engine) => `${caseId}\u0000${engine}`;

const expectedResultIdentities = (executePlan, caseContracts) => {
  const contractByCaseId = new Map(
    assertArray(caseContracts, "caseContracts").map((contract, index) => {
      assertRecord(contract, `caseContracts[${index}]`);
      return [
        nonEmptyString(contract.id, `caseContracts[${index}].id`),
        contract,
      ];
    }),
  );
  const identities = new Map();
  for (const [index, planInput] of assertArray(
    executePlan,
    "executePlan",
  ).entries()) {
    const plan = assertRecord(planInput, `executePlan[${index}]`);
    const engine = nonEmptyString(plan.engine, `executePlan[${index}].engine`);
    for (const caseId of parseCaseFilter(
      plan.caseFilter,
      `executePlan[${index}].caseFilter`,
    )) {
      const identity = resultIdentity(caseId, engine);
      if (identities.has(identity)) {
        throw new Error(
          `executePlan assigns ${caseId}/${engine} more than once.`,
        );
      }
      const contract = contractByCaseId.get(caseId) ?? {};
      identities.set(identity, {
        caseId,
        engine,
        routingRequired: contract.routingEvidence !== "not-applicable",
        skipExpected: Array.isArray(contract.expectedSkipEngines)
          ? contract.expectedSkipEngines.includes(engine)
          : false,
      });
    }
  }
  if (identities.size === 0) {
    throw new Error("executePlan must select at least one result.");
  }
  return identities;
};

const findRoutingMismatches = (value, path = "details", mismatches = []) => {
  if (!value || typeof value !== "object") {
    return mismatches;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      findRoutingMismatches(entry, `${path}[${index}]`, mismatches),
    );
    return mismatches;
  }
  for (const field of [
    "routeMatched",
    "engineMatched",
    "featureMatched",
  ]) {
    if (field in value && value[field] !== true) {
      mismatches.push({ path: `${path}.${field}`, actual: value[field] });
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      !["routeMatched", "engineMatched", "featureMatched"].includes(key)
    ) {
      findRoutingMismatches(entry, `${path}.${key}`, mismatches);
    }
  }
  return mismatches;
};

const findRoutingAssertions = (value) => {
  if (!value || typeof value !== "object") {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (total, entry) => total + findRoutingAssertions(entry),
      0,
    );
  }
  const current = [
    "routeMatched",
    "engineMatched",
    "featureMatched",
  ].some((field) => field in value)
    ? 1
    : 0;
  return (
    current +
    Object.values(value).reduce(
      (total, entry) => total + findRoutingAssertions(entry),
      0,
    )
  );
};

const traceEvidenceIssues = (traceInput) => {
  const trace = assertRecord(traceInput, "payload trace evidence");
  const refs = assertArray(trace.refs, "payload trace evidence refs");
  const savedTraces = assertArray(
    trace.savedTraces,
    "payload trace evidence savedTraces",
  );
  const traceIdentity = (entry, label) =>
    `${nonEmptyString(entry?.traceId, `${label}.traceId`)}\u0000${nonEmptyString(
      entry?.stepId,
      `${label}.stepId`,
    )}`;
  const identityCounts = (entries, label) => {
    const counts = new Map();
    for (const [index, entry] of entries.entries()) {
      const identity = traceIdentity(entry, `${label}[${index}]`);
      counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
    return counts;
  };
  const refIdentities = identityCounts(refs, "payload trace evidence refs");
  const savedTraceIdentities = identityCounts(
    savedTraces,
    "payload trace evidence savedTraces",
  );
  const statusCounts = { saved: 0, failed: 0, skipped: 0 };
  for (const savedTrace of savedTraces) {
    const status = ["missing", "error"].includes(savedTrace?.status)
      ? "failed"
      : savedTrace?.status;
    if (!(status in statusCounts)) {
      return [{ field: "savedTraces.status", actual: status }];
    }
    statusCounts[status] += 1;
  }
  const checks = [
    ["enabled", trace.enabled, true],
    ["traceRefCount", trace.traceRefCount, refs.length],
    [
      "uniqueTraceCount",
      trace.uniqueTraceCount,
      new Set(refs.map(({ traceId }) => traceId)).size,
    ],
    ["savedTraces.length", savedTraces.length, trace.traceRefCount],
    ["savedTraceCount", trace.savedTraceCount, statusCounts.saved],
    ["failedTraceCount", trace.failedTraceCount, statusCounts.failed],
    ["skippedTraceCount", trace.skippedTraceCount, statusCounts.skipped],
    [
      "traceFetchCaseBudgetMs",
      trace.traceFetchCaseBudgetMs,
      TRACE_CASE_BUDGET_MS,
    ],
    [
      "traceFetchJobBudgetMs",
      trace.traceFetchJobBudgetMs,
      TRACE_JOB_BUDGET_MS,
    ],
  ];
  const issues = checks.flatMap(([field, actual, expected]) =>
    actual === expected ? [] : [{ field, actual, expected }],
  );
  if (
    refIdentities.size !== savedTraceIdentities.size ||
    [...refIdentities].some(
      ([identity, count]) => savedTraceIdentities.get(identity) !== count,
    )
  ) {
    issues.push({
      field: "traceIdentityMultiset",
      actual: Object.fromEntries(savedTraceIdentities),
      expected: Object.fromEntries(refIdentities),
    });
  }
  const nonNegativeFields = [
    "selectedTraceCount",
    "missingFetchCount",
    "wastedFetchMs",
    "traceFetchRecoveryProbeCount",
  ];
  for (const field of nonNegativeFields) {
    if (!Number.isFinite(trace[field]) || trace[field] < 0) {
      issues.push({ field, actual: trace[field], minimum: 0 });
    }
  }
  if (
    Number.isFinite(trace.selectedTraceCount) &&
    trace.selectedTraceCount > trace.uniqueTraceCount
  ) {
    issues.push({
      field: "selectedTraceCount",
      actual: trace.selectedTraceCount,
      maximum: trace.uniqueTraceCount,
    });
  }
  if (
    Number.isFinite(trace.missingFetchCount) &&
    Number.isFinite(trace.failedTraceCount) &&
    trace.missingFetchCount < trace.failedTraceCount
  ) {
    issues.push({
      field: "missingFetchCount",
      actual: trace.missingFetchCount,
      minimum: trace.failedTraceCount,
    });
  }
  if (
    trace.missingFetchCount > 0 &&
    trace.wastedFetchMs <= 0 &&
    !["hard-outage", "exporter-outage"].includes(
      trace.traceFetchBreakerState,
    )
  ) {
    issues.push({
      field: "wastedFetchMs",
      actual: trace.wastedFetchMs,
      minimum: 1,
    });
  }
  if (typeof trace.traceFetchRecoverySucceeded !== "boolean") {
    issues.push({
      field: "traceFetchRecoverySucceeded",
      actual: trace.traceFetchRecoverySucceeded,
      expected: "boolean",
    });
  }
  const allowedBreakerStates = new Set([
    "closed",
    "partial-loss",
    "hard-outage",
    "case-budget",
    "job-budget",
    "recovered",
    "exporter-outage",
  ]);
  if (!allowedBreakerStates.has(trace.traceFetchBreakerState)) {
    issues.push({
      field: "traceFetchBreakerState",
      actual: trace.traceFetchBreakerState,
    });
  }
  if (
    [
      "partial-loss",
      "hard-outage",
      "case-budget",
      "job-budget",
      "exporter-outage",
    ].includes(trace.traceFetchBreakerState) &&
    (typeof trace.traceFetchBreakerReason !== "string" ||
      trace.traceFetchBreakerReason.length === 0)
  ) {
    issues.push({
      field: "traceFetchBreakerReason",
      actual: trace.traceFetchBreakerReason,
    });
  }
  if (
    !Number.isFinite(trace.traceFetchWaitMs) ||
    trace.traceFetchWaitMs < 0 ||
    trace.traceFetchWaitMs > TRACE_CASE_BUDGET_MS
  ) {
    issues.push({
      field: "traceFetchWaitMs",
      actual: trace.traceFetchWaitMs,
      maximum: TRACE_CASE_BUDGET_MS,
    });
  }
  if (
    !Number.isFinite(trace.traceFetchJobWaitMs) ||
    trace.traceFetchJobWaitMs < 0 ||
    trace.traceFetchJobWaitMs > TRACE_JOB_BUDGET_MS
  ) {
    issues.push({
      field: "traceFetchJobWaitMs",
      actual: trace.traceFetchJobWaitMs,
      maximum: TRACE_JOB_BUDGET_MS,
    });
  }
  if (trace.traceFetchBreakerState === "tail-error") {
    issues.push({
      field: "traceFetchBreakerState",
      actual: trace.traceFetchBreakerState,
    });
  }
  return issues;
};

export const evaluateFullRunResultAcceptance = ({
  executePlan,
  payloadEntries,
  jobConclusions,
  caseContracts = [],
}) => {
  const expected = expectedResultIdentities(executePlan, caseContracts);
  const conclusions = assertRecord(jobConclusions, "jobConclusions");
  const failures = [];
  for (const phase of ["resolveInputs", "seed", "execute"]) {
    if (conclusions[phase] !== "success") {
      failures.push({
        code: "job-conclusion",
        phase,
        actual: conclusions[phase],
        expected: "success",
      });
    }
  }

  const actual = new Map();
  for (const [index, entryInput] of assertArray(
    payloadEntries,
    "payloadEntries",
  ).entries()) {
    const entry = assertRecord(entryInput, `payloadEntries[${index}]`);
    const payload = assertRecord(
      entry.payload,
      `payloadEntries[${index}].payload`,
    );
    const caseId = nonEmptyString(
      payload.caseId,
      `payloadEntries[${index}].payload.caseId`,
    );
    const engine = nonEmptyString(
      payload.engine,
      `payloadEntries[${index}].payload.engine`,
    );
    const identity = resultIdentity(caseId, engine);
    const entries = actual.get(identity) ?? [];
    entries.push({ entry, payload, caseId, engine });
    actual.set(identity, entries);
  }

  const displayIdentity = (identity) => identity.replace("\u0000", "/");
  const missing = [...expected.keys()]
    .filter((identity) => !actual.has(identity))
    .map(displayIdentity)
    .sort();
  if (missing.length > 0) {
    failures.push({ code: "result-identity-missing", identities: missing });
  }
  const unexpected = [...actual.keys()]
    .filter((identity) => !expected.has(identity))
    .map(displayIdentity)
    .sort();
  if (unexpected.length > 0) {
    failures.push({
      code: "result-identity-unexpected",
      identities: unexpected,
    });
  }
  const duplicates = [...actual]
    .filter(([, entries]) => entries.length > 1)
    .map(([identity]) => displayIdentity(identity))
    .sort();
  if (duplicates.length > 0) {
    failures.push({
      code: "result-identity-duplicate",
      identities: duplicates,
    });
  }

  const failedResults = [];
  const unexpectedSkips = [];
  const missingRoutingEvidence = [];
  const routingMismatches = [];
  const traceIssues = [];
  for (const [identity, entries] of actual) {
    if (!expected.has(identity) || entries.length !== 1) {
      continue;
    }
    const [{ payload, caseId, engine }] = entries;
    const contract = expected.get(identity);
    if (payload.result === "skipped" && !contract.skipExpected) {
      unexpectedSkips.push({ caseId, engine });
    } else if (!["pass", "skipped"].includes(payload.result)) {
      failedResults.push({ caseId, engine, result: payload.result });
    }
    const mismatches = findRoutingMismatches(payload.details);
    if (mismatches.length > 0) {
      routingMismatches.push({ caseId, engine, mismatches });
    } else if (
      payload.result !== "skipped" &&
      contract.routingRequired &&
      findRoutingAssertions(payload.details) === 0
    ) {
      missingRoutingEvidence.push({ caseId, engine });
    }
    let issues;
    try {
      issues = traceEvidenceIssues(
        payload.details?.observability?.traces,
      );
    } catch (error) {
      issues = [
        {
          field: "traceEvidence",
          message: error instanceof Error ? error.message : String(error),
        },
      ];
    }
    if (issues.length > 0) {
      traceIssues.push({ caseId, engine, issues });
    }
  }
  if (failedResults.length > 0) {
    failures.push({ code: "result-failed", results: failedResults });
  }
  if (unexpectedSkips.length > 0) {
    failures.push({ code: "result-unexpected-skip", results: unexpectedSkips });
  }
  if (missingRoutingEvidence.length > 0) {
    failures.push({
      code: "routing-evidence-missing",
      results: missingRoutingEvidence,
    });
  }
  if (routingMismatches.length > 0) {
    failures.push({
      code: "routing-mismatch",
      results: routingMismatches,
    });
  }
  if (traceIssues.length > 0) {
    failures.push({
      code: "trace-evidence-incomplete",
      results: traceIssues,
    });
  }

  return {
    passed: failures.length === 0,
    expectedResults: expected.size,
    observedResults: payloadEntries.length,
    failures,
  };
};

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const main = async () => {
  const caseContracts = await loadRegisteredCases();
  const evaluation = evaluateFullRunResultAcceptance({
    executePlan: JSON.parse(requiredEnv("PERF_LAB_EXECUTE_PLAN")),
    payloadEntries: await readArtifactPayloads({
      artifactDir: requiredEnv("PERF_LAB_ARTIFACT_DIR"),
      includeSeed: false,
      allowEmpty: true,
    }),
    jobConclusions: {
      resolveInputs: requiredEnv("PERF_LAB_RESOLVE_INPUTS_RESULT"),
      seed: requiredEnv("PERF_LAB_SEED_RESULT"),
      execute: requiredEnv("PERF_LAB_EXECUTE_RESULT"),
    },
    caseContracts,
  });
  console.log(JSON.stringify(evaluation, null, 2));
  if (!evaluation.passed) {
    process.exitCode = 1;
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.stack || error.message : error,
    );
    process.exitCode = 1;
  });
}
