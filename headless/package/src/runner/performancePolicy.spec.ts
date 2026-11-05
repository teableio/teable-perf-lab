import { describe, expect, it } from 'vitest';

import type { BenchOperationMeasurement } from './BenchRunner';
import { evaluatePerformancePolicy } from './performancePolicy';

const operation = (key: string, samplesMs: ReadonlyArray<number>): BenchOperationMeasurement => ({
  key,
  kind: 'query-core',
  samplesMs,
  count: samplesMs.length,
  minMs: Math.min(...samplesMs),
  p50Ms: samplesMs[Math.ceil(samplesMs.length * 0.5) - 1] ?? null,
  p95Ms: samplesMs[Math.ceil(samplesMs.length * 0.95) - 1] ?? null,
  p99Ms: samplesMs[Math.ceil(samplesMs.length * 0.99) - 1] ?? null,
  maxMs: Math.max(...samplesMs),
  meanMs: samplesMs.reduce((sum, sample) => sum + sample, 0) / samplesMs.length,
  rowsRead: 0,
  rowsWritten: 0,
  rowsReturned: 0,
  processed: 0,
  errors: 0,
  warnings: [],
});

const samples = (value: number): number[] => Array.from({ length: 20 }, () => value);

const policy = {
  modelVersion: 'tea-bench-budget/1' as const,
  source: 'measured on the fixed CI runner',
  maxP95Ms: 30,
  operations: {
    query: { maxP95Ms: 12, weight: 1 },
    drain: { maxP95Ms: 20, weight: 2 },
  },
};

describe('evaluatePerformancePolicy', () => {
  it('scores the observed case and every configured operation against measured budgets', () => {
    const result = evaluatePerformancePolicy({
      operations: [operation('query', samples(10)), operation('drain', samples(15))],
      policy,
    });

    expect(result.verdict).toBe('pass');
    expect(result.case).toMatchObject({ observedP95Ms: 25, maxP95Ms: 30, score: 120 });
    expect(result.operations).toEqual([
      expect.objectContaining({ key: 'query', observedP95Ms: 10, maxP95Ms: 12, score: 120 }),
      expect.objectContaining({
        key: 'drain',
        observedP95Ms: 15,
        maxP95Ms: 20,
        score: 133.33333333333331,
      }),
    ]);
    expect(result.score).toBeCloseTo(Math.cbrt(120 * 133.33333333333331 ** 2));
  });

  it('fails when one operation exceeds its budget even if the total case stays under budget', () => {
    const result = evaluatePerformancePolicy({
      operations: [operation('query', samples(13)), operation('drain', samples(15))],
      policy,
    });

    expect(result.case.verdict).toBe('pass');
    expect(result.operations[0]?.verdict).toBe('fail');
    expect(result.verdict).toBe('fail');
  });

  it('is inconclusive rather than passing with fewer than 20 independent samples', () => {
    const result = evaluatePerformancePolicy({
      operations: [operation('query', [10, 11, 12]), operation('drain', [15, 16, 17])],
      policy,
    });

    expect(result.verdict).toBe('inconclusive');
    expect(result.warnings).toContain('bench.performance.p95_unresolved:min_samples=20');
  });

  it('rejects incomplete operation budgets so new workload steps cannot bypass the gate', () => {
    const result = evaluatePerformancePolicy({
      operations: [operation('query', samples(10)), operation('new-step', samples(1))],
      policy,
    });

    expect(result.verdict).toBe('fail');
    expect(result.warnings).toContain('bench.performance.operation_budget_missing:new-step');
  });
});
