import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertBudgetMeasurement,
  BenchBudgetsSchema,
  budgetsFromRuns,
  policyForCase,
  type CalibrationRun,
} from './ci/budgets';
import type { CiBenchSummary } from './ci/ciRunner';
import { renderCiSummaryMarkdown } from './ci/renderSummary';
import { runHttpBench, type HttpBenchRun } from './httpBench/runner';
import {
  evaluatePerformancePolicy,
  type BenchPerformanceEvaluation,
} from './runner/performancePolicy';

const HTTP_MEASUREMENT_PROTOCOL = {
  version: 1,
  warmupStrategy: 'unmeasured-full-suite-rounds-in-shared-runtime',
  timingScope: 'http-request-only',
  statistic: 'nearest-rank-p95',
} as const;
const HTTP_WARMUP = 1;
const HTTP_REPETITIONS = 1;

const connectionString = process.env.PRISMA_DATABASE_URL;
if (!connectionString) throw new Error('PRISMA_DATABASE_URL is required for the HTTP benchmark');
const samples = Number(process.env.TEABLE_BENCH_SAMPLES ?? 20);
if (!Number.isInteger(samples) || samples < 20)
  throw new Error('HTTP CI requires at least 20 samples');
const calibrationMultiplier = process.env.TEABLE_BENCH_CALIBRATE;
const calibrating = calibrationMultiplier !== undefined && calibrationMultiplier !== '';
const outDir = resolve(process.env.TEABLE_BENCH_OUT_DIR ?? '/tmp/teable-headless-http-bench');
const budgetsPath =
  process.env.TEABLE_BENCH_HTTP_BUDGETS ??
  fileURLToPath(new URL('../budgets/http.budgets.json', import.meta.url));

function createHttpSummary(
  run: HttpBenchRun,
  performance: BenchPerformanceEvaluation | undefined
): CiBenchSummary {
  const verdict =
    run.correctness === 'fail' || performance?.verdict === 'fail'
      ? 'fail'
      : (performance?.verdict ?? 'inconclusive');
  return {
    schema: 'tea-bench-ci/1',
    backend: run.backend,
    score: performance?.score ?? null,
    verdict,
    coverage: { requestedRuleIds: ['HTTP-CRUD-CSV'], executedRuleIds: ['HTTP-CRUD-CSV'] },
    cases: [
      {
        scenarioId: run.caseId,
        ruleId: 'HTTP-CRUD-CSV',
        title: 'V2 headless HTTP CRUD / CSV import',
        correctnessVerdict: run.correctness,
        performanceVerdict: performance?.verdict ?? 'not-compared',
        score: performance?.score ?? null,
        caseP95Ms: performance?.case.observedP95Ms ?? null,
        caseBudgetMs: performance?.case.maxP95Ms ?? null,
        operations:
          performance?.operations.map((operation) => ({
            key: operation.key,
            p95Ms: operation.observedP95Ms,
            budgetMs: operation.maxP95Ms,
            score: operation.score,
            verdict: operation.verdict,
          })) ??
          run.operations.map((operation) => ({
            key: operation.key,
            p95Ms: operation.p95Ms,
            budgetMs: null,
            score: null,
            verdict: 'inconclusive' as const,
          })),
        runPath: resolve(outDir, 'http.run.json'),
        sourceFullScaleScenarioId: null,
        exclusionEvidence:
          'Loopback headless HTTP; not Nest authentication, permissions, or production capacity.',
        dimensions: run.dimensions,
      },
    ],
  };
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const run = await runHttpBench({
    backend: 'postgres',
    connectionString,
    samples,
    warmup: HTTP_WARMUP,
  });
  await writeFile(resolve(outDir, 'http.run.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  const calibrationRun: CalibrationRun = {
    caseId: run.caseId,
    backend: run.backend,
    dimensions: { ...run.dimensions, scenarioId: run.caseId, ruleId: 'HTTP-CRUD-CSV' },
    measurementProtocol: HTTP_MEASUREMENT_PROTOCOL,
    warmup: HTTP_WARMUP,
    samples,
    repetitions: HTTP_REPETITIONS,
    operations: run.operations,
    verdict: run.correctness,
    oracle: { status: run.correctness, checks: [], warnings: [] },
  };
  let performance;
  if (calibrating) {
    const budgets = budgetsFromRuns({
      runs: [calibrationRun],
      headroom: Number(calibrationMultiplier),
      source: process.env.TEABLE_BENCH_CALIBRATE_SOURCE ?? 'headless HTTP benchmark',
    });
    await writeFile(budgetsPath, `${JSON.stringify(budgets, null, 2)}\n`, 'utf8');
  } else {
    const budgets = BenchBudgetsSchema.parse(
      JSON.parse(await readFile(budgetsPath, 'utf8')) as unknown
    );
    assertBudgetMeasurement(budgets, {
      measurementProtocol: HTTP_MEASUREMENT_PROTOCOL,
      warmup: HTTP_WARMUP,
      samples,
      repetitions: HTTP_REPETITIONS,
    });
    const policy = policyForCase(budgets, run.caseId);
    const calibrated = budgets.cases[run.caseId];
    if (calibrated && calibrated.caseId !== run.caseId) {
      throw new Error(`bench.budgets.workload_changed: ${run.caseId}`);
    }
    if (!policy) throw new Error(`bench.budgets.case_missing: ${run.caseId}`);
    performance = evaluatePerformancePolicy({ operations: run.operations, policy });
  }
  const summary = createHttpSummary(run, performance);
  await writeFile(resolve(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(resolve(outDir, 'summary.md'), renderCiSummaryMarkdown(summary), 'utf8');
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (calibrating ? run.correctness !== 'pass' : summary.verdict !== 'pass') process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
