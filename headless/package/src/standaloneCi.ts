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
import { runCoreComputedChangesBench } from './coreComputedChanges/runner';
import { runCoreExtraBench } from './coreExtra/runner';
import { runCoreFanoutDeletionBench } from './coreFanoutDeletion/runner';
import { runCoreFieldTransitionsBench } from './coreFieldTransitions/runner';
import { runCoreOpsBench } from './coreOps/runner';
import { runCoreQueryCasesBench } from './coreQueryCases/runner';
import { runCoreRelationCasesBench } from './coreRelationCases/runner';
import { runCoreScaleBench } from './coreScale/runner';
import { runCoreTransitionsBench } from './coreTransitions/runner';
import { runCoreViewsBench } from './coreViews/runner';
import { runCoreVolumeCasesBench } from './coreVolumeCases/runner';
import type { HttpBenchRun } from './httpBench/runner';
import {
  evaluatePerformancePolicy,
  type BenchPerformanceEvaluation,
} from './runner/performancePolicy';

const STANDALONE_MEASUREMENT_PROTOCOL = {
  version: 1,
  warmupStrategy: 'unmeasured-full-suite-rounds-in-shared-runtime',
  timingScope: 'operation-only',
  statistic: 'nearest-rank-p95',
} as const;
const STANDALONE_WARMUP = 1;
const STANDALONE_REPETITIONS = 1;

const tracks = {
  ['core-operations']: {
    title: 'V2 Core schema, import and bulk operations',
    run: runCoreOpsBench,
  },
  ['core-extra']: {
    title: 'V2 Core record, table, and bulk field operations',
    run: runCoreExtraBench,
  },
  ['core-scale']: { title: 'V2 Core large data and computed fanout', run: runCoreScaleBench },
  ['core-transitions']: {
    title: 'V2 Core linked and conditional propagation transitions',
    run: runCoreTransitionsBench,
  },
  ['core-views']: { title: 'V2 Core view operations', run: runCoreViewsBench },
  ['core-computed-changes']: {
    title: 'V2 Core populated computed schema and relation changes',
    run: runCoreComputedChangesBench,
  },
  ['core-query-cases']: {
    title: 'V2 Core query boundaries and view defaults',
    run: runCoreQueryCasesBench,
  },
  ['core-relation-cases']: {
    title: 'Bidirectional relationship lifecycle',
    run: runCoreRelationCasesBench,
  },
  ['core-field-transitions']: {
    title: 'Mixed populated field transitions',
    run: runCoreFieldTransitionsBench,
  },
  ['core-fanout-deletion']: {
    title: 'Linked source deletion with 1000 dependents',
    run: runCoreFanoutDeletionBench,
  },
  ['core-volume-cases']: { title: 'Core CRUD with 10000 rows', run: runCoreVolumeCasesBench },
  ['core-scale-large']: {
    title: 'Core computed propagation with 100000 source rows and 10000 fanout',
    run: (input: Parameters<typeof runCoreScaleBench>[0]) =>
      runCoreScaleBench({ ...input, scale: 'large' }),
  },
  ['core-volume-large']: {
    title: 'Core CRUD with 100000 rows',
    run: (input: Parameters<typeof runCoreVolumeCasesBench>[0]) =>
      runCoreVolumeCasesBench({ ...input, profile: 'large' }),
  },
  ['core-fanout-large']: {
    title: 'Linked source deletion with 10000 dependents',
    run: (input: Parameters<typeof runCoreFanoutDeletionBench>[0]) =>
      runCoreFanoutDeletionBench({ ...input, fanout: 10000 }),
  },
} as const;

type TrackName = keyof typeof tracks;

function readConfiguration(): {
  trackName: TrackName;
  connectionString: string;
  samples: number;
  multiplier: string | undefined;
  calibrating: boolean;
  outDir: string;
  budgetPath: string;
} {
  const trackName = process.env.TEABLE_BENCH_TRACK;
  if (!trackName || !Object.hasOwn(tracks, trackName)) {
    throw new Error(`Unknown TEABLE_BENCH_TRACK: ${trackName}`);
  }
  const connectionString = process.env.PRISMA_DATABASE_URL;
  if (!connectionString) throw new Error('PRISMA_DATABASE_URL is required for standalone CI');
  const samples = Number(process.env.TEABLE_BENCH_SAMPLES ?? 20);
  if (!Number.isInteger(samples) || samples < 20)
    throw new Error('CI requires at least 20 samples');
  const multiplier = process.env.TEABLE_BENCH_CALIBRATE;
  return {
    trackName: trackName as TrackName,
    connectionString,
    samples,
    multiplier,
    calibrating: multiplier !== undefined && multiplier !== '',
    outDir: resolve(process.env.TEABLE_BENCH_OUT_DIR ?? '/tmp/teable-headless-bench'),
    budgetPath:
      process.env.TEABLE_BENCH_BUDGETS ??
      fileURLToPath(new URL(`../budgets/${trackName}.budgets.json`, import.meta.url)),
  };
}

async function main(): Promise<void> {
  const { trackName, connectionString, samples, multiplier, calibrating, outDir, budgetPath } =
    readConfiguration();
  await mkdir(outDir, { recursive: true });
  const run = await tracks[trackName].run({
    backend: 'postgres',
    connectionString,
    samples,
    warmup: STANDALONE_WARMUP,
  });
  const runPath = resolve(outDir, `${trackName}.run.json`);
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  const calibrationRun: CalibrationRun = {
    caseId: run.caseId,
    backend: run.backend,
    dimensions: { ...run.dimensions, scenarioId: run.caseId, ruleId: trackName },
    measurementProtocol: STANDALONE_MEASUREMENT_PROTOCOL,
    warmup: STANDALONE_WARMUP,
    samples,
    repetitions: STANDALONE_REPETITIONS,
    operations: run.operations,
    verdict: run.correctness,
    oracle: { status: run.correctness, checks: [], warnings: [] },
  };
  let performance: BenchPerformanceEvaluation | undefined;
  if (calibrating) {
    const budgets = budgetsFromRuns({
      runs: [calibrationRun],
      headroom: Number(multiplier),
      source: process.env.TEABLE_BENCH_CALIBRATE_SOURCE ?? `${trackName} CI benchmark`,
    });
    await mkdir(resolve(budgetPath, '..'), { recursive: true });
    await writeFile(budgetPath, `${JSON.stringify(budgets, null, 2)}\n`, 'utf8');
  } else {
    const budgets = BenchBudgetsSchema.parse(
      JSON.parse(await readFile(budgetPath, 'utf8')) as unknown
    );
    assertBudgetMeasurement(budgets, {
      measurementProtocol: STANDALONE_MEASUREMENT_PROTOCOL,
      warmup: STANDALONE_WARMUP,
      samples,
      repetitions: STANDALONE_REPETITIONS,
    });
    const calibrated = budgets.cases[run.caseId];
    if (!calibrated || calibrated.caseId !== run.caseId) {
      throw new Error(`bench.budgets.workload_changed: ${run.caseId}`);
    }
    const policy = policyForCase(budgets, run.caseId);
    if (!policy) throw new Error(`bench.budgets.case_missing: ${run.caseId}`);
    performance = evaluatePerformancePolicy({ operations: run.operations, policy });
  }
  const summary = makeSummary({
    run,
    trackName,
    title: tracks[trackName].title,
    runPath,
    performance,
  });
  await writeFile(resolve(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(resolve(outDir, 'summary.md'), renderCiSummaryMarkdown(summary), 'utf8');
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (calibrating ? run.correctness !== 'pass' : summary.verdict !== 'pass') process.exitCode = 1;
}

function makeSummary(input: {
  run: HttpBenchRun;
  trackName: string;
  title: string;
  runPath: string;
  performance?: BenchPerformanceEvaluation;
}): CiBenchSummary {
  const { run, trackName, title, runPath, performance } = input;
  const verdict =
    run.correctness === 'fail' || performance?.verdict === 'fail'
      ? 'fail'
      : (performance?.verdict ?? 'inconclusive');
  return {
    schema: 'tea-bench-ci/1',
    backend: run.backend,
    score: performance?.score ?? null,
    verdict,
    coverage: { requestedRuleIds: [trackName], executedRuleIds: [trackName] },
    cases: [
      {
        scenarioId: run.caseId,
        ruleId: trackName,
        title,
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
        runPath,
        sourceFullScaleScenarioId: null,
        exclusionEvidence:
          'Direct V2 core; excludes undo, redo, realtime, Nest, authentication and deployment capacity.',
        dimensions: run.dimensions,
      },
    ],
  };
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
