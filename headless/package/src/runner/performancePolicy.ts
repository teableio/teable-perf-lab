import type { BenchOperationMeasurement } from './BenchRunner';
import { minimumSamplesForPercentileResolution } from './metrics';

export const PERFORMANCE_BUDGET_MODEL_VERSION = 'tea-bench-budget/1' as const;

export type BenchPerformanceBudget = {
  readonly maxP95Ms: number;
  readonly weight?: number;
};

export type BenchPerformancePolicy = {
  readonly modelVersion: typeof PERFORMANCE_BUDGET_MODEL_VERSION;
  readonly source: string;
  /** Maximum p95 for the sum of one complete workload sample. */
  readonly maxP95Ms: number;
  /** Every measured workload operation must have an explicit budget. */
  readonly operations: Readonly<Record<string, BenchPerformanceBudget>>;
};

export type BenchPerformanceReceipt = {
  readonly key: string;
  readonly observedP95Ms: number | null;
  readonly maxP95Ms: number;
  /** 100 means the observation exactly consumed its budget; larger is faster. */
  readonly score: number | null;
  readonly weight: number;
  readonly verdict: 'pass' | 'fail' | 'inconclusive';
};

export type BenchPerformanceEvaluation = {
  readonly modelVersion: typeof PERFORMANCE_BUDGET_MODEL_VERSION;
  readonly source: string;
  readonly minimumSamples: number;
  readonly sampleCount: number;
  readonly case: Omit<BenchPerformanceReceipt, 'key' | 'weight'>;
  readonly operations: ReadonlyArray<BenchPerformanceReceipt>;
  /** Weighted geometric mean of operation scores; no fast case can hide a failed case. */
  readonly score: number | null;
  readonly verdict: 'pass' | 'fail' | 'inconclusive';
  readonly warnings: ReadonlyArray<string>;
};

const score = (observedP95Ms: number, maxP95Ms: number): number =>
  observedP95Ms === 0 ? Number.MAX_SAFE_INTEGER : (maxP95Ms / observedP95Ms) * 100;

const validBudget = (value: number): boolean => Number.isFinite(value) && value > 0;

const weightedGeometricMean = (receipts: ReadonlyArray<BenchPerformanceReceipt>): number | null => {
  if (receipts.length === 0 || receipts.some((receipt) => receipt.score === null)) return null;
  const totalWeight = receipts.reduce((sum, receipt) => sum + receipt.weight, 0);
  if (totalWeight <= 0) return null;
  const logSum = receipts.reduce(
    (sum, receipt) => sum + Math.log(receipt.score!) * receipt.weight,
    0
  );
  return Math.exp(logSum / totalWeight);
};

const operationReceipt = (input: {
  operation: BenchOperationMeasurement;
  policy: BenchPerformancePolicy;
  resolved: boolean;
  warnings: string[];
}): BenchPerformanceReceipt => {
  const { operation, policy, resolved, warnings } = input;
  const budget = policy.operations[operation.key];
  if (!budget) warnings.push(`bench.performance.operation_budget_missing:${operation.key}`);
  else if (!validBudget(budget.maxP95Ms)) {
    warnings.push(`bench.performance.operation_budget_invalid:${operation.key}`);
  }
  const maxP95Ms = budget?.maxP95Ms ?? 0;
  const weight = budget?.weight ?? 1;
  const observedP95Ms = operation.p95Ms;
  const comparable =
    resolved &&
    budget !== undefined &&
    validBudget(maxP95Ms) &&
    Number.isFinite(weight) &&
    weight > 0 &&
    observedP95Ms !== null &&
    Number.isFinite(observedP95Ms) &&
    operation.errors === 0;
  return {
    key: operation.key,
    observedP95Ms,
    maxP95Ms,
    score: comparable ? score(observedP95Ms, maxP95Ms) : null,
    weight,
    verdict: !comparable ? 'inconclusive' : observedP95Ms > maxP95Ms ? 'fail' : 'pass',
  };
};

const caseP95 = (
  operations: ReadonlyArray<BenchOperationMeasurement>,
  sampleCount: number,
  resolved: boolean
): number | null => {
  if (!resolved) return null;
  const samples = Array.from({ length: sampleCount }, (_, sampleIndex) =>
    operations.reduce((sum, operation) => sum + (operation.samplesMs[sampleIndex] ?? Number.NaN), 0)
  )
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return samples.length === sampleCount && sampleCount > 0
    ? samples[Math.max(0, Math.ceil(sampleCount * 0.95) - 1)]!
    : null;
};

const finalVerdict = (input: {
  warnings: ReadonlyArray<string>;
  caseVerdict: BenchPerformanceReceipt['verdict'];
  operations: ReadonlyArray<BenchPerformanceReceipt>;
}): BenchPerformanceEvaluation['verdict'] => {
  const configurationFailure = input.warnings.some(
    (warning) =>
      warning.includes('budget_missing') ||
      warning.includes('budget_invalid') ||
      warning.includes('operation_missing')
  );
  if (configurationFailure) return 'fail';
  if (
    input.caseVerdict === 'fail' ||
    input.operations.some((operation) => operation.verdict === 'fail')
  ) {
    return 'fail';
  }
  return input.caseVerdict === 'inconclusive' ||
    input.operations.some((operation) => operation.verdict === 'inconclusive')
    ? 'inconclusive'
    : 'pass';
};

export function evaluatePerformancePolicy(input: {
  readonly operations: ReadonlyArray<BenchOperationMeasurement>;
  readonly policy: BenchPerformancePolicy;
}): BenchPerformanceEvaluation {
  const warnings: string[] = [];
  const minimumSamples = minimumSamplesForPercentileResolution(0.95);
  const sampleCount =
    input.operations.length === 0
      ? 0
      : Math.min(...input.operations.map((operation) => operation.samplesMs.length));
  const resolved = sampleCount >= minimumSamples;
  if (!resolved) warnings.push(`bench.performance.p95_unresolved:min_samples=${minimumSamples}`);

  if (!validBudget(input.policy.maxP95Ms)) {
    warnings.push('bench.performance.case_budget_invalid');
  }

  const operations = input.operations.map((operation) =>
    operationReceipt({ operation, policy: input.policy, resolved, warnings })
  );
  for (const key of Object.keys(input.policy.operations)) {
    if (!input.operations.some((operation) => operation.key === key)) {
      warnings.push(`bench.performance.operation_missing:${key}`);
    }
  }

  const observedCaseP95Ms = caseP95(input.operations, sampleCount, resolved);
  const comparableCase =
    resolved &&
    observedCaseP95Ms !== null &&
    validBudget(input.policy.maxP95Ms) &&
    warnings.length === 0;
  const caseVerdict = !comparableCase
    ? 'inconclusive'
    : observedCaseP95Ms > input.policy.maxP95Ms
      ? 'fail'
      : 'pass';
  const verdict = finalVerdict({ warnings, caseVerdict, operations });

  return {
    modelVersion: input.policy.modelVersion,
    source: input.policy.source,
    minimumSamples,
    sampleCount,
    case: {
      observedP95Ms: observedCaseP95Ms,
      maxP95Ms: input.policy.maxP95Ms,
      score: comparableCase ? score(observedCaseP95Ms, input.policy.maxP95Ms) : null,
      verdict: caseVerdict,
    },
    operations,
    score: weightedGeometricMean(operations),
    verdict,
    warnings,
  };
}
