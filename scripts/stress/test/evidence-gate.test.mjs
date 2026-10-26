import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyHumanVerdict,
  assertPreRunEstimate,
  buildEvidenceKey,
  deriveCapacity,
  deriveCorrectness,
  evaluateCostAnomaly,
  evaluateCostCoverage,
  findDuplicateKeys,
  planBundleGate,
  reconcileLadderTotals,
} from "../evidence-gate.mjs";

const RUN_ID = "lst_20261024T040013Z_C0";
const SCENARIO = "C0-loadtest-1024040040";

function baseBundle(overrides = {}) {
  const {
    run,
    registry,
    scenarios,
    metrics,
    correctness,
    resources,
    costs,
    reports,
    ...rest
  } = overrides;
  return {
    run: {
      runId: RUN_ID,
      rowKind: "summary",
      testType: "load",
      environmentBaseline: "5 pods, 4C16G, pool 10",
      cleanupStatus: "verified",
      dbPhysicalCount: 1,
      specVersion: "v1",
      environment: "loadtest",
      codeVersion: "fixture-sha",
      ...run,
    },
    registry: { sloP95Ms: 1000, maxErrorRatePct: 1, ...registry },
    scenarios: scenarios || [
      {
        scenarioId: "C0",
        operationKey: "list",
        targetRps: 20,
        p95: 120,
        p99: 300,
        errorRate: 0,
        correctness: "pass",
      },
    ],
    metrics: metrics || [{ metric: "p95", value: 120 }],
    correctness: correctness || [
      {
        checkKey: "write-readback",
        status: "pass",
        delta: 0,
        tolerance: 0,
        verifier: "psql",
      },
    ],
    resources: resources || [
      {
        resourceId: "rds-1",
        deletionVerified: true,
        cleanupStatus: "verified",
        receiptJson: '{"code":"DBInstanceNotFound"}',
        deletionEvidenceCode: "DBInstanceNotFound",
        deletedAtSource: "per-resource-receipt",
      },
    ],
    costs: costs || [
      {
        costComponent: "db",
        actualAmount: 1.2,
        currency: "USD",
        estAmount: 1.2,
        estimatedAt: "2026-10-24T03:00:00Z",
      },
      {
        costComponent: "loadgen",
        actualAmount: 0.63,
        currency: "USD",
        estAmount: 0.63,
        estimatedAt: "2026-10-24T03:00:00Z",
      },
      {
        costComponent: "appnode",
        actualAmount: 0,
        currency: "USD",
        estAmount: 0,
        estimatedAt: "2026-10-24T03:00:00Z",
      },
      {
        costComponent: "ops",
        actualAmount: 0,
        currency: "USD",
        estAmount: 0,
        estimatedAt: "2026-10-24T03:00:00Z",
      },
    ],
    reports: reports || [{ reportKey: "r1", dataHash: "abc" }],
    ...rest,
  };
}

function completeV2Bundle() {
  const bundle = baseBundle();
  bundle.run.schemaVersion = "stress-evidence-v2";
  bundle.run.specVersion = "v1";
  bundle.run.environment = "staging";
  bundle.run.codeVersion = "abc1234";
  bundle.run.startTime = "2026-10-24T04:00:00Z";
  bundle.run.endTime = "2026-10-24T04:30:00Z";
  bundle.run.windowStart = "2026-10-24T04:10:00Z";
  bundle.run.windowEnd = "2026-10-24T04:20:00Z";
  bundle.registry.specVersion = "v1";
  bundle.scenarios = [{ ...bundle.scenarios[0], specVersion: "v1" }];
  bundle.metrics = [
    {
      metric: "p95",
      value: 120,
      operationKey: "list",
      scenario: "C0",
      collectionStatus: "observed",
      source: "signoz",
      queryReceipt: "p95 over 5m",
      specVersion: "v1",
    },
    {
      metric: "http_req_failed",
      value: 0,
      operationKey: "list",
      scenario: "C0",
      collectionStatus: "observed",
      source: "k6",
      queryReceipt: "failed requests over the run",
      specVersion: "v1",
    },
    {
      metric: "teable.database.client.pool.waiting",
      value: 0,
      operationKey: "list",
      scenario: "C0",
      collectionStatus: "observed",
      source: "signoz",
      queryReceipt: "max over 5m",
      specVersion: "v1",
    },
    {
      metric: "k6.dropped_iterations",
      value: 0,
      requests: 60000,
      scenario: "C0",
      operationKey: "list",
      collectionStatus: "observed",
      source: "k6",
      queryReceipt: "dropped iterations over the run",
      specVersion: "v1",
    },
  ];
  bundle.costs = bundle.costs.map((cost) => ({ ...cost, currency: "CNY" }));
  bundle.correctness = [
    {
      ...bundle.correctness[0],
      observed: "0 rows differ",
      sampleRef: "rec_sample_fixture",
      permissionCheck: true,
      operationKey: "list",
      scenario: "C0",
      specVersion: "v1",
    },
  ];
  bundle.reports = [
    {
      reportKey: "r1",
      reportVersion: "v1",
      queryReceipt: "rows read from 压测场景结果",
      sourceTables: "压测运行,压测场景结果",
      dataHash: "abc",
      generatedAt: "2026-10-24T04:20:00Z",
      uri: "https://staging.example/reports/r1",
      status: "ok",
    },
  ];
  return bundle;
}

function codes(plan) {
  return plan.blockers.map((item) => item.code);
}

test("v1 keys stay byte-identical to the drifted staging rows", () => {
  assert.equal(
    buildEvidenceKey(
      "result",
      {
        runId: RUN_ID,
        scenarioId: SCENARIO,
        mode: "byodb",
        repeat: 1,
        operationKey: "s20nc:20rps:typecast=false",
      },
      { format: "v1" },
    ),
    "lst:lst_20261024T040013Z_C0:scenario:C0-loadtest-1024040040:mode=byodb:repeat=1:op=s20nc%3A20rps%3Atypecast%3Dfalse",
  );
  assert.equal(
    buildEvidenceKey(
      "cost",
      {
        runId: RUN_ID,
        scenarioId: SCENARIO,
        component: "db",
        mode: "byodb",
        repeat: 1,
      },
      { format: "v1" },
    ),
    "lst:lst_20261024T040013Z_C0:byodb-cost:C0-loadtest-1024040040:db:mode=byodb:repeat=1",
  );
  assert.equal(
    buildEvidenceKey(
      "resource",
      { runId: RUN_ID, resourceKey: "sg-005fe9b004e86bb05" },
      { format: "v1" },
    ),
    "lst:lst_20261024T040013Z_C0:resource:sg-005fe9b004e86bb05",
  );
  assert.equal(
    buildEvidenceKey("run", { runId: RUN_ID }, { format: "v1" }),
    "lst:lst_20261024T040013Z_C0",
  );
});

test("v2 keys are canonical and dimension-free", () => {
  assert.equal(
    buildEvidenceKey("result", {
      runId: RUN_ID,
      scenarioId: "C0",
      mode: "byodb",
      repeat: 2,
      operationKey: "list",
    }),
    "lst:lst_20261024T040013Z_C0:scenario:C0:byodb:2:list",
  );
  assert.equal(
    buildEvidenceKey("metric", {
      runId: RUN_ID,
      metricKey: "max_sustainable_rps",
      scenarioId: "C0",
      windowStart: "2026-10-24T04:19:14Z",
      dbRole: "tenant",
    }),
    `lst:lst_20261024T040013Z_C0:metric:max_sustainable_rps:C0:${Date.parse("2026-10-24T04:19:14Z")}:db=tenant`,
  );
  assert.throws(
    () =>
      buildEvidenceKey("result", {
        runId: RUN_ID,
        scenarioId: "C0",
        mode: "byodb",
      }),
    /repeat is required/,
  );
});

test("duplicate evidence keys are reported, missing keys are not dropped", () => {
  const { duplicates, missing } = findDuplicateKeys([
    { table: "t", key: "lst:r:scenario:C0:byodb:1" },
    { table: "t", key: "lst:r:scenario:C0:byodb:1" },
    { table: "t", key: null },
  ]);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].kind, "result");
  assert.equal(missing.length, 1);
});

test("clean evidence passes the gate", () => {
  const plan = planBundleGate(baseBundle());
  assert.equal(plan.verdict, "pass", JSON.stringify(plan.blockers));
  assert.equal(plan.gate, "pass");
});

test("complete canonical v2 evidence passes", () => {
  const plan = planBundleGate(completeV2Bundle());
  assert.equal(plan.verdict, "pass", JSON.stringify(plan.blockers));
  assert.deepEqual(plan.blockers, []);
});

test("canonical v2 refuses pass without observed metric coverage and receipts", () => {
  const missingReceipt = completeV2Bundle();
  missingReceipt.metrics[0].queryReceipt = "";
  const receiptPlan = planBundleGate(missingReceipt);
  assert.equal(receiptPlan.verdict, "inconclusive");
  assert.ok(codes(receiptPlan).includes("METRIC_QUERY_RECEIPT_MISSING"));

  const noData = completeV2Bundle();
  noData.metrics[1].collectionStatus = "no_data";
  const noDataPlan = planBundleGate(noData);
  assert.equal(noDataPlan.verdict, "inconclusive");
  assert.ok(codes(noDataPlan).includes("METRIC_NOT_OBSERVED"));

  const missingPool = completeV2Bundle();
  missingPool.metrics = missingPool.metrics.filter(
    (metric) => metric.metric !== "teable.database.client.pool.waiting",
  );
  const coveragePlan = planBundleGate(missingPool);
  assert.equal(coveragePlan.verdict, "inconclusive");
  assert.ok(codes(coveragePlan).includes("METRIC_COVERAGE_MISSING"));
});

test("canonical v2 refuses pass without report artifacts and full cost coverage", () => {
  const noReport = completeV2Bundle();
  noReport.reports = [];
  const absentPlan = planBundleGate(noReport);
  assert.equal(absentPlan.verdict, "inconclusive");
  assert.ok(codes(absentPlan).includes("REPORT_ROWS_MISSING"));

  const incompleteReport = completeV2Bundle();
  incompleteReport.reports[0].queryReceipt = "";
  const reportPlan = planBundleGate(incompleteReport);
  assert.equal(reportPlan.verdict, "inconclusive");
  assert.ok(codes(reportPlan).includes("REPORT_EVIDENCE_INCOMPLETE"));

  const partialCost = completeV2Bundle();
  partialCost.costs[2].actualAmount = null;
  const costPlan = planBundleGate(partialCost);
  assert.equal(costPlan.verdict, "inconclusive");
  assert.ok(codes(costPlan).includes("COST_COVERAGE_PARTIAL"));
});

test("canonical v2 refuses pass without sampled, permission-isolated correctness", () => {
  const noSample = completeV2Bundle();
  delete noSample.correctness[0].sampleRef;
  const samplePlan = planBundleGate(noSample);
  assert.equal(samplePlan.verdict, "inconclusive");
  assert.ok(codes(samplePlan).includes("CORRECTNESS_SAMPLE_MISSING"));

  const noObserved = completeV2Bundle();
  delete noObserved.correctness[0].observed;
  const observedPlan = planBundleGate(noObserved);
  assert.equal(observedPlan.verdict, "inconclusive");
  assert.ok(codes(observedPlan).includes("CORRECTNESS_OBSERVED_MISSING"));

  const noPermission = completeV2Bundle();
  noPermission.correctness[0].permissionCheck = false;
  const permissionPlan = planBundleGate(noPermission);
  assert.equal(permissionPlan.verdict, "inconclusive");
  assert.ok(
    codes(permissionPlan).includes("CORRECTNESS_PERMISSION_UNVERIFIED"),
  );
});

test("canonical v2 requires matching registry, run, and scenario spec versions", () => {
  const missingRegistry = completeV2Bundle();
  delete missingRegistry.registry.specVersion;
  const missingPlan = planBundleGate(missingRegistry);
  assert.equal(missingPlan.verdict, "inconclusive");
  assert.ok(codes(missingPlan).includes("SPEC_VERSION_MISSING"));

  const mismatch = completeV2Bundle();
  mismatch.scenarios[0].specVersion = "v2";
  const mismatchPlan = planBundleGate(mismatch);
  assert.equal(mismatchPlan.verdict, "inconclusive");
  assert.ok(codes(mismatchPlan).includes("SPEC_VERSION_MISMATCH"));
});

test("canonical v2 requires explicit environment and code attribution", () => {
  const bundle = completeV2Bundle();
  delete bundle.run.environment;
  delete bundle.run.codeVersion;
  const plan = planBundleGate(bundle);
  assert.equal(plan.verdict, "inconclusive");
  assert.ok(codes(plan).includes("ENVIRONMENT_MISSING"));
  assert.ok(codes(plan).includes("CODE_VERSION_MISSING"));
});

test("canonical v2 enforces run and nested window ordering", () => {
  const runOrder = completeV2Bundle();
  runOrder.run.endTime = runOrder.run.startTime;
  const runPlan = planBundleGate(runOrder);
  assert.equal(runPlan.verdict, "inconclusive");
  assert.ok(codes(runPlan).includes("RUN_TIME_ORDER_INVALID"));

  const outside = completeV2Bundle();
  outside.run.windowStart = "2026-10-24T03:50:00Z";
  const outsidePlan = planBundleGate(outside);
  assert.equal(outsidePlan.verdict, "inconclusive");
  assert.ok(codes(outsidePlan).includes("WINDOW_OUTSIDE_RUN"));

  const metricWindow = completeV2Bundle();
  metricWindow.metrics[0].windowStart = "2026-10-24T04:00:00Z";
  metricWindow.metrics[0].windowEnd = "2026-10-24T04:05:00Z";
  const metricPlan = planBundleGate(metricWindow);
  assert.equal(metricPlan.verdict, "inconclusive");
  assert.ok(codes(metricPlan).includes("METRIC_WINDOW_INVALID"));
});

test("canonical v2 requires per-resource receipt, evidence code, and source", () => {
  const noSource = completeV2Bundle();
  delete noSource.resources[0].deletedAtSource;
  const sourcePlan = planBundleGate(noSource);
  assert.equal(sourcePlan.verdict, "fail");
  assert.ok(
    codes(sourcePlan).includes("RESOURCE_DELETED_AT_SOURCE_UNVERIFIED"),
  );

  const noCode = completeV2Bundle();
  delete noCode.resources[0].deletionEvidenceCode;
  const codePlan = planBundleGate(noCode);
  assert.equal(codePlan.verdict, "fail");
  assert.ok(codes(codePlan).includes("RESOURCE_EVIDENCE_CODE_MISSING"));
});

test("scenario-scoped rows must carry the run spec version", () => {
  const missingMetricSpec = completeV2Bundle();
  delete missingMetricSpec.metrics[0].specVersion;
  const missingPlan = planBundleGate(missingMetricSpec);
  assert.equal(missingPlan.verdict, "inconclusive");
  assert.ok(codes(missingPlan).includes("SPEC_VERSION_MISSING"));

  const mismatchedCheckSpec = completeV2Bundle();
  mismatchedCheckSpec.correctness[0].specVersion = "v2";
  const mismatchPlan = planBundleGate(mismatchedCheckSpec);
  assert.equal(mismatchPlan.verdict, "inconclusive");
  assert.ok(codes(mismatchPlan).includes("SPEC_VERSION_MISMATCH"));
});

test("every scenario grain needs its own metrics and correctness", () => {
  const bundle = completeV2Bundle();
  bundle.scenarios.push({
    scenarioId: "C1",
    specVersion: "v1",
    operationKey: "list",
    targetRps: 10,
    p95: 100,
    p99: 200,
    errorRate: 0,
    correctness: "pass",
  });
  const plan = planBundleGate(bundle);
  assert.equal(plan.verdict, "inconclusive");
  assert.ok(codes(plan).includes("GRAIN_METRIC_MISSING"));
  assert.ok(codes(plan).includes("GRAIN_CORRECTNESS_MISSING"));
});

test("canonical step rows need result and metric rows too", () => {
  const bundle = completeV2Bundle();
  bundle.run.rowKind = "step";
  bundle.scenarios = [];
  const plan = planBundleGate(bundle);
  assert.equal(plan.verdict, "inconclusive");
  assert.ok(codes(plan).includes("RESULT_ROWS_MISSING"));
});

test("a guardrail breach is aborted, even with the s5-style numbers", () => {
  const plan = planBundleGate(
    baseBundle({
      scenarios: [
        {
          scenarioId: SCENARIO,
          operationKey: "update",
          targetRps: 5,
          p95: 15600,
          p99: 16376.35,
          errorRate: 0,
          correctness: "pass",
        },
      ],
      metrics: [
        {
          metric: "http_req_duration.p99",
          value: 16376.35,
          overThreshold: true,
          guardrail: true,
        },
      ],
      guardrails: [
        { rule: "p99Ms", breached: true, value: 16376.35, threshold: 2000 },
      ],
    }),
  );
  assert.equal(plan.verdict, "aborted");
  assert.ok(plan.blockers.some((item) => item.code === "GUARDRAIL_BREACH"));
});

test("error rate and P99 breaches fail a step without guardrail evidence", () => {
  const plan = planBundleGate(
    baseBundle({
      scenarios: [
        {
          scenarioId: "C0",
          operationKey: "list",
          p95: 120,
          p99: 300,
          errorRate: 21.1,
        },
      ],
      metrics: [{ metric: "p95", value: 120 }],
    }),
  );
  assert.equal(plan.verdict, "fail");
  assert.ok(plan.blockers.some((item) => item.code === "ERROR_RATE_EXCEEDED"));

  const slow = planBundleGate(
    baseBundle({
      scenarios: [
        {
          scenarioId: "C0",
          operationKey: "list",
          p95: 2100,
          p99: 2600,
          errorRate: 0,
        },
      ],
    }),
  );
  assert.equal(slow.verdict, "aborted");
});

test("missing environment baseline, v2 ratio, or correctness tolerance downgrades to inconclusive", () => {
  const noBaseline = planBundleGate(
    baseBundle({ run: { environmentBaseline: "" } }),
  );
  assert.equal(noBaseline.verdict, "inconclusive");

  const v2 = planBundleGate(
    baseBundle({
      registry: { expectsV2: true },
      run: { v2RatioPerEndpoint: null },
    }),
  );
  assert.equal(v2.verdict, "inconclusive");
  assert.ok(v2.blockers.some((item) => item.code === "V2_RATIO_MISSING"));

  const tolerance = planBundleGate(
    baseBundle({
      correctness: [
        {
          checkKey: "write-read-20rps",
          status: "pass",
          delta: null,
          tolerance: null,
          verifier: "psql",
        },
      ],
    }),
  );
  assert.equal(tolerance.verdict, "inconclusive");
  assert.ok(
    tolerance.blockers.some(
      (item) => item.code === "CORRECTNESS_TOLERANCE_MISSING",
    ),
  );
});

test("a summary cannot report correctness=pass when a child is partial", () => {
  const plan = planBundleGate(
    baseBundle({
      scenarios: [
        {
          scenarioId: "C0",
          operationKey: "list",
          p95: 120,
          p99: 300,
          errorRate: 0,
          correctness: "partial",
        },
      ],
      ladder: [{ targetRps: 20, repeats: ["pass"], correctness: "partial" }],
    }),
  );
  assert.equal(plan.verdict, "inconclusive");
  assert.equal(
    deriveCorrectness(
      [],
      [{ correctness: "partial" }, { correctness: "pass" }],
    ),
    "partial",
  );
});

test("cleanup needs per-resource receipts", () => {
  const batch = planBundleGate(
    baseBundle({
      resources: [
        {
          resourceId: "rds-1",
          deletionVerified: true,
          cleanupStatus: "verified",
          receiptJson: '{"note":"deleted"}',
          deletedAtSource: "batch",
        },
      ],
    }),
  );
  assert.equal(batch.verdict, "fail");
  assert.ok(
    batch.blockers.some((item) => item.code === "RESOURCE_BATCH_DELETED_AT"),
  );

  const noReceipt = planBundleGate(
    baseBundle({
      resources: [
        {
          resourceId: "rds-1",
          deletionVerified: true,
          cleanupStatus: "verified",
        },
      ],
    }),
  );
  assert.equal(noReceipt.verdict, "fail");
  assert.ok(
    noReceipt.blockers.some((item) => item.code === "RESOURCE_RECEIPT_MISSING"),
  );
});

test("capacity is a lower bound until a failing step with repeats exists", () => {
  const open = deriveCapacity([
    { targetRps: 10, repeats: ["pass", "pass", "pass"] },
    { targetRps: 20, repeats: ["pass", "pass", "pass"] },
  ]);
  assert.equal(open.maxPassingRps, 20);
  assert.equal(open.maxSustainableRps, null);
  assert.equal(open.capacityBound, "lower");

  const closed = deriveCapacity([
    { targetRps: 10, repeats: ["pass", "pass", "pass"] },
    { targetRps: 20, repeats: ["pass", "pass", "pass"] },
    { targetRps: 30, repeats: ["fail", "fail", "pass"] },
  ]);
  assert.equal(closed.maxPassingRps, 20);
  assert.equal(closed.maxSustainableRps, 20);
  assert.equal(closed.capacityBound, "point");
  assert.deepEqual(closed.interval, [20, 30]);

  const singleRepeat = deriveCapacity([
    { targetRps: 20, repeats: ["pass"] },
    { targetRps: 30, repeats: ["fail"] },
  ]);
  assert.equal(singleRepeat.maxSustainableRps, null);
  assert.equal(singleRepeat.capacityBound, "lower");
});

test("a breakpoint umbrella with only passing steps is capacity_only", () => {
  const plan = planBundleGate(
    baseBundle({
      run: { testType: "breakpoint", profile: "breakpoint" },
      scenarios: [
        {
          scenarioId: "C0",
          operationKey: "list",
          targetRps: 20,
          p95: 120,
          p99: 300,
          errorRate: 0,
        },
      ],
      ladder: [{ targetRps: 20, repeats: ["pass", "pass", "pass"] }],
    }),
  );
  assert.equal(plan.verdict, "capacity_only");
  assert.equal(plan.capacity.maxPassingRps, 20);
  assert.equal(plan.capacity.maxSustainableRps, null);
});

test("humans can downgrade but never upgrade the derived verdict", () => {
  assert.equal(
    applyHumanVerdict("pass", "inconclusive").verdict,
    "inconclusive",
  );
  assert.equal(applyHumanVerdict("inconclusive", "fail").verdict, "fail");
  assert.throws(() => applyHumanVerdict("fail", "pass"), /upgrade rejected/);
  assert.throws(() => applyHumanVerdict("aborted", "fail"), /upgrade rejected/);
});

test("cost coverage is full only when every component is numeric and convertible", () => {
  const partial = evaluateCostCoverage(
    [
      { costComponent: "db", actualAmount: 1.2, currency: "USD" },
      { costComponent: "loadgen", actualAmount: 0.63, currency: "USD" },
      { costComponent: "appnode", actualAmount: null, currency: "USD" },
      { costComponent: "ops", actualAmount: null, currency: "USD" },
    ],
    { fx: { rates: { "USD:CNY": 7.2 } } },
  );
  assert.equal(partial.coverage, "partial");
  assert.equal(partial.actualRunCost, null);

  const full = evaluateCostCoverage(
    [
      {
        costComponent: "db",
        actualAmount: 1.2,
        currency: "USD",
        fxRate: 7.2,
        fxAsOf: "2026-10-24T03:00:00Z",
      },
      {
        costComponent: "loadgen",
        actualAmount: 0.63,
        currency: "USD",
        fxRate: 7.2,
        fxAsOf: "2026-10-24T03:00:00Z",
      },
      {
        costComponent: "appnode",
        actualAmount: 0,
        currency: "USD",
        fxRate: 7.2,
        fxAsOf: "2026-10-24T03:00:00Z",
      },
      {
        costComponent: "ops",
        actualAmount: 0,
        currency: "USD",
        fxRate: 7.2,
        fxAsOf: "2026-10-24T03:00:00Z",
      },
    ],
    { fx: { rates: { "USD:CNY": 7.2 } } },
  );
  assert.equal(full.coverage, "full");
  assert.ok(Math.abs(full.actualRunCost - 1.83 * 7.2) < 1e-9);

  const noFx = evaluateCostCoverage(
    [
      { costComponent: "db", actualAmount: 1.2, currency: "USD" },
      { costComponent: "loadgen", actualAmount: 0.63, currency: "USD" },
      { costComponent: "appnode", actualAmount: 0, currency: "USD" },
      { costComponent: "ops", actualAmount: 0, currency: "USD" },
    ],
    { baseCurrency: "CNY" },
  );
  assert.equal(noFx.coverage, "partial");
});

test("cost anomaly only applies to full coverage; estimates must be pre-run", () => {
  assert.equal(
    evaluateCostAnomaly({
      coverage: "partial",
      actualRunCost: 10,
      estRunCost: 1,
    }),
    null,
  );
  assert.equal(
    evaluateCostAnomaly({ coverage: "full", actualRunCost: 2, estRunCost: 1 }),
    true,
  );
  assert.deepEqual(
    assertPreRunEstimate({
      estAmount: 2,
      estimatedAt: "2026-10-24T08:00:00Z",
      runStartTime: "2026-10-24T04:00:00Z",
    }),
    { ok: false, code: "EST_BACKFILLED" },
  );
  assert.equal(
    assertPreRunEstimate({
      estAmount: 2,
      estimatedAt: "2026-10-24T03:00:00Z",
      runStartTime: "2026-10-24T04:00:00Z",
    }).ok,
    true,
  );
});

test("ladder totals reconcile and reject the umbrella total", () => {
  const report = reconcileLadderTotals({
    umbrellaTotal: 76498,
    ladderSummaryTotal: 54001,
    steps: [
      { requests: 7681 },
      { requests: 1804 },
      { requests: 18000 },
      { requests: 36001 },
    ],
  });
  assert.equal(report.stepTotalSum, 63486);
  assert.equal(report.admissibleTotal, 63486);
  assert.equal(report.differences.umbrellaMinusSteps, 13012);
  assert.equal(report.differences.summaryMinusSteps, -9485);
  assert.equal(report.issues.length, 2);
});
