import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  enumerateScenarioCatalogue,
  materializeCatalogueScenario,
  type Scenario,
} from '../catalogue';
import {
  BENCH_MEASUREMENT_PROTOCOL,
  readBenchMeasurementProtocol,
  runCase,
  type BenchRunReport,
} from '../runner/BenchRunner';
import {
  assertBudgetMeasurement,
  budgetsFromRuns,
  policyForCase,
  type BenchBudgets,
  type BenchManifestPerformancePolicy,
  BenchBudgetsSchema,
} from './budgets';
import { renderCiSummaryMarkdown } from './renderSummary';
import { selectCiScenarios } from './scenarios';
export type CiOperationSummary = {
  readonly key: string;
  readonly p95Ms: number | null;
  readonly budgetMs: number | null;
  readonly score: number | null;
  readonly verdict: 'pass' | 'fail' | 'inconclusive';
};

export type CiCaseSummary = {
  readonly scenarioId: string;
  readonly ruleId: string;
  readonly title: string;
  readonly correctnessVerdict: BenchRunReport['verdict'];
  readonly performanceVerdict: BenchRunReport['performanceVerdict'];
  readonly score: number | null;
  readonly caseP95Ms: number | null;
  readonly caseBudgetMs: number | null;
  readonly operations: ReadonlyArray<CiOperationSummary>;
  readonly runPath: string | null;
  readonly sourceFullScaleScenarioId: string | null;
  readonly exclusionEvidence: string | null;
  readonly dimensions: Readonly<Record<string, unknown>>;
};

export type CiBenchSummary = {
  readonly schema: 'tea-bench-ci/1';
  readonly backend: 'pglite' | 'postgres';
  readonly score: number | null;
  readonly verdict: 'pass' | 'fail' | 'inconclusive';
  readonly coverage: {
    readonly requestedRuleIds: ReadonlyArray<string>;
    readonly executedRuleIds: ReadonlyArray<string>;
  };
  readonly cases: ReadonlyArray<CiCaseSummary>;
};

const geometricMean = (values: ReadonlyArray<number | null>): number | null =>
  values.length > 0 && values.every((value): value is number => value !== null)
    ? Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length)
    : null;

export function summarizeCiRuns(
  runs: ReadonlyArray<BenchRunReport>,
  metadata: ReadonlyArray<{
    scenarioId: string;
    ruleId?: string;
    title?: string;
    runPath?: string;
    sourceFullScaleScenarioId?: string;
    exclusionEvidence?: string;
  }> = [],
  requestedRules?: ReadonlyArray<string>
): CiBenchSummary {
  const byScenario = new Map(metadata.map((entry) => [entry.scenarioId, entry]));
  const cases = runs.map((run): CiCaseSummary => {
    const meta = byScenario.get(String(run.dimensions?.scenarioId ?? run.caseId));
    const performance = run.performance;
    const budget = performance?.case?.maxP95Ms ?? null;
    return {
      scenarioId: meta?.scenarioId ?? String(run.dimensions?.scenarioId ?? run.caseId),
      ruleId: meta?.ruleId ?? String(run.dimensions?.ruleId ?? 'unknown'),
      title: meta?.title ?? run.title,
      correctnessVerdict: run.correctnessVerdict ?? run.verdict,
      performanceVerdict: run.performanceVerdict,
      score: performance?.score ?? null,
      caseP95Ms: performance?.case?.observedP95Ms ?? null,
      caseBudgetMs: budget,
      operations:
        performance?.operations?.map((operation) => ({
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
      runPath: meta?.runPath ?? null,
      sourceFullScaleScenarioId: meta?.sourceFullScaleScenarioId ?? null,
      exclusionEvidence: meta?.exclusionEvidence ?? null,
      dimensions: run.dimensions ?? {},
    };
  });
  const hasFailure = cases.some(
    (entry) => entry.correctnessVerdict === 'fail' || entry.performanceVerdict === 'fail'
  );
  const conclusive =
    cases.length > 0 &&
    cases.every(
      (entry) => entry.correctnessVerdict === 'pass' && entry.performanceVerdict === 'pass'
    );
  const requestedRuleIds = [
    ...new Set(
      requestedRules ??
        (metadata.length > 0
          ? metadata.flatMap((entry) => (entry.ruleId === undefined ? [] : [entry.ruleId]))
          : cases.map((entry) => entry.ruleId))
    ),
  ].sort();
  const executedRuleIds = [...new Set(cases.map((entry) => entry.ruleId))].sort();
  const completeCoverage =
    requestedRuleIds.length === executedRuleIds.length &&
    requestedRuleIds.every((ruleId, index) => ruleId === executedRuleIds[index]);
  return {
    schema: 'tea-bench-ci/1',
    backend: runs[0]?.backend ?? 'pglite',
    score: geometricMean(cases.map((entry) => entry.score)),
    verdict: hasFailure ? 'fail' : conclusive && completeCoverage ? 'pass' : 'inconclusive',
    coverage: { requestedRuleIds, executedRuleIds },
    cases,
  };
}

export type CiBenchInput = {
  readonly outDir: string;
  readonly connectionString: string;
  readonly samples?: number;
  readonly maxCases?: number;
  /** Restricts the gate to these behavior families; CI runs one leg per family. */
  readonly families?: ReadonlyArray<string>;
  /** Gate mode: checked-in calibrated budgets every case must match. */
  readonly budgetsPath?: string;
  /** Calibrate mode: write a new budget file from this run instead of gating. */
  readonly calibrate?: { readonly headroom: number; readonly source: string };
};

const readBudgets = async (path: string): Promise<BenchBudgets> =>
  BenchBudgetsSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);

type MaterializedManifest = {
  readonly run: { samples: number; warmup: number; repetitions: number };
  readonly dimensions?: Readonly<Record<string, unknown>>;
  readonly budgets?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
};

type BoundedVariantMetadata = {
  readonly sourceFullScaleScenarioId: string;
  readonly exclusionEvidence: string;
};

const boundedVariantMetadata = (scenario: Scenario): BoundedVariantMetadata | undefined => {
  const sourceFullScaleScenarioId = scenario.fixture.parameters.sourceFullScaleScenarioId;
  const exclusionEvidence = scenario.fixture.parameters.ciExclusionEvidence;
  if (typeof sourceFullScaleScenarioId !== 'string' || typeof exclusionEvidence !== 'string') {
    return undefined;
  }
  return { sourceFullScaleScenarioId, exclusionEvidence };
};

const prepareManifest = async (input: {
  manifestPath: string;
  manifest: MaterializedManifest;
  scenario: Scenario;
  policy?: BenchManifestPerformancePolicy;
}): Promise<void> => {
  const variant = boundedVariantMetadata(input.scenario);
  if (variant === undefined && input.policy === undefined) return;
  const dimensions =
    variant === undefined
      ? input.manifest.dimensions
      : {
          ...input.manifest.dimensions,
          ciScope: 'bounded',
          sourceFullScaleScenarioId: variant.sourceFullScaleScenarioId,
          ciExclusionEvidence: variant.exclusionEvidence,
          ciSize: input.scenario.size,
        };
  const budgets =
    input.policy === undefined
      ? input.manifest.budgets
      : { ...input.manifest.budgets, performance: input.policy };
  await writeFile(
    input.manifestPath,
    `${JSON.stringify({ ...input.manifest, dimensions, budgets }, null, 2)}\n`,
    'utf8'
  );
};

type RunMetadata = {
  scenarioId: string;
  ruleId: string;
  title: string;
  runPath: string;
  sourceFullScaleScenarioId?: string;
  exclusionEvidence?: string;
};

const runScenario = async (input: {
  scenario: Scenario;
  casesDir: string;
  runsDir: string;
  connectionString: string;
  samples?: number;
  budgets?: BenchBudgets;
}): Promise<{ run: BenchRunReport; metadata: RunMetadata }> => {
  const { scenario } = input;
  const materialized = await materializeCatalogueScenario({ scenario, outDir: input.casesDir });
  const generated = materialized.cases[0];
  if (!generated) throw new Error(`Scenario ${scenario.scenarioId} did not materialize a case`);
  const manifest = JSON.parse(
    await readFile(generated.manifestPath, 'utf8')
  ) as MaterializedManifest;
  const measurement = {
    measurementProtocol: BENCH_MEASUREMENT_PROTOCOL,
    samples: input.samples ?? Math.max(20, manifest.run.samples),
    warmup: manifest.run.warmup,
    repetitions: manifest.run.repetitions,
  };
  if (input.budgets) assertBudgetMeasurement(input.budgets, measurement);
  const policy = input.budgets ? policyForCase(input.budgets, scenario.scenarioId) : undefined;
  if (input.budgets && !policy) {
    throw new Error(
      `bench.budgets.case_missing: ${scenario.ruleId} (${scenario.scenarioId}) has no calibrated budget; run the calibration pass on this runner`
    );
  }
  const calibrated = input.budgets?.cases[scenario.scenarioId];
  if (calibrated && calibrated.caseId !== generated.caseId) {
    throw new Error(
      `bench.budgets.workload_changed: ${scenario.ruleId} expected ${calibrated.caseId}, received ${generated.caseId}; recalibration required`
    );
  }
  await prepareManifest({
    manifestPath: generated.manifestPath,
    manifest,
    scenario,
    ...(policy === undefined ? {} : { policy }),
  });
  const run = await runCase({
    manifestPath: generated.manifestPath,
    teaPath: generated.teaPath,
    backendOverride: 'postgres',
    connectionString: input.connectionString,
    samples: measurement.samples,
    warmup: measurement.warmup,
    repetitions: measurement.repetitions,
  });
  const runPath = resolve(input.runsDir, `${scenario.ruleId}.run.json`);
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  process.stderr.write(
    `${scenario.ruleId} ${run.correctnessVerdict} ${run.performanceVerdict ?? 'not-compared'} score=${
      run.performance?.score?.toFixed(1) ?? 'n/a'
    }\n`
  );
  const variant = boundedVariantMetadata(scenario);
  return {
    run,
    metadata: {
      scenarioId: scenario.scenarioId,
      ruleId: scenario.ruleId,
      title: scenario.title,
      runPath,
      ...(variant === undefined ? {} : variant),
    },
  };
};

const writeCalibration = async (
  input: CiBenchInput,
  runs: ReadonlyArray<BenchRunReport>
): Promise<void> => {
  if (!input.calibrate) return;
  const budgets = budgetsFromRuns({
    runs: runs.map((run) => ({
      ...run,
      measurementProtocol: readBenchMeasurementProtocol(run),
      repetitions: run.repetitions.length,
    })),
    headroom: input.calibrate.headroom,
    source: input.calibrate.source,
  });
  const path = input.budgetsPath ?? 'budgets/catalogue.budgets.json';
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(budgets, null, 2)}\n`, 'utf8');
};

export async function runCiBench(input: CiBenchInput): Promise<CiBenchSummary> {
  const outDir = resolve(input.outDir);
  const casesDir = resolve(outDir, 'cases');
  const runsDir = resolve(outDir, 'runs');
  await mkdir(casesDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  const budgets =
    input.calibrate === undefined
      ? await readBudgets(input.budgetsPath ?? 'budgets/catalogue.budgets.json')
      : undefined;
  const selectedScenarios = selectCiScenarios(
    enumerateScenarioCatalogue().scenarios,
    input.families
  );
  const scenarios = selectedScenarios.slice(0, input.maxCases ?? Number.POSITIVE_INFINITY);
  const results = [];
  for (const scenario of scenarios) {
    results.push(
      await runScenario({
        scenario,
        casesDir,
        runsDir,
        connectionString: input.connectionString,
        ...(input.samples === undefined ? {} : { samples: input.samples }),
        ...(budgets === undefined ? {} : { budgets }),
      })
    );
  }
  const runs = results.map((result) => result.run);
  const metadata = results.map((result) => result.metadata);
  if (input.calibrate && scenarios.length !== selectedScenarios.length) {
    throw new Error('bench.budgets.incomplete_calibration: all selected rules must run');
  }
  await writeCalibration(input, runs);
  const summary = summarizeCiRuns(
    runs,
    metadata,
    selectedScenarios.map((scenario) => scenario.ruleId)
  );
  await writeFile(resolve(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(resolve(outDir, 'summary.md'), renderCiSummaryMarkdown(summary), 'utf8');
  return summary;
}
