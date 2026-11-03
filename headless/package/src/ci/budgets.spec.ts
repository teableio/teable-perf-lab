import { describe, expect, it } from 'vitest';

import { BENCH_MEASUREMENT_PROTOCOL, type BenchOperationMeasurement } from '../runner/BenchRunner';
import {
  assertBudgetMeasurement,
  BenchBudgetsSchema,
  budgetsFromRuns,
  policyForCase,
  type CalibrationRun,
} from './budgets';

const operation = (key: string, p95Ms: number): BenchOperationMeasurement => ({
  key,
  kind: 'query-core',
  count: 1,
  minMs: p95Ms,
  samplesMs: Array.from({ length: 20 }, () => p95Ms),
  p50Ms: p95Ms,
  p95Ms,
  p99Ms: p95Ms,
  maxMs: p95Ms,
  meanMs: p95Ms,
  rowsRead: 0,
  rowsWritten: 0,
  rowsReturned: 0,
  processed: 0,
  errors: 0,
  warnings: [],
});

const run = (
  scenarioId: string,
  operations: ReadonlyArray<BenchOperationMeasurement>
): CalibrationRun => ({
  caseId: scenarioId,
  dimensions: { scenarioId, ruleId: 'R-QUERY-001' },
  backend: 'pglite',
  measurementProtocol: BENCH_MEASUREMENT_PROTOCOL,
  warmup: 1,
  samples: 20,
  repetitions: 1,
  operations,
  verdict: 'pass',
  oracle: { status: 'pass', checks: [], warnings: [] },
});

describe('budgetsFromRuns', () => {
  it('records measured p95 plus headroom, and the case budget as the sum of operation budgets', () => {
    const budgets = budgetsFromRuns({
      runs: [run('scn_a', [operation('query', 10), operation('drain', 20)])],
      headroom: 2,
      source: 'calibrated on the CI runner',
    });

    expect(budgets.cases.scn_a).toMatchObject({
      caseId: 'scn_a',
      ruleId: 'R-QUERY-001',
      maxP95Ms: 60,
      operations: { query: { maxP95Ms: 20 }, drain: { maxP95Ms: 40 } },
    });
    expect(budgets.headroom).toBe(2);
    expect(budgets.provenance.source).toBe('calibrated on the CI runner');
    expect(budgets.schema).toBe('tea-bench-budgets/2');
    expect(budgets.provenance).toMatchObject({
      measurementProtocol: BENCH_MEASUREMENT_PROTOCOL,
      warmup: 1,
      samples: 20,
      repetitions: 1,
    });
  });

  it('refuses a run whose percentile evidence is too weak to calibrate from', () => {
    expect(() =>
      budgetsFromRuns({
        runs: [run('scn_a', [{ ...operation('query', 10), samplesMs: [10, 11] }])],
        headroom: 2,
        source: 'calibrated',
      })
    ).toThrowError(/bench\.budgets\.weak_evidence/);
  });

  it('never calibrates a failed correctness run or an empty suite', () => {
    const failed = { ...run('scn_a', [operation('query', 10)]), verdict: 'fail' as const };
    expect(() => budgetsFromRuns({ runs: [failed], headroom: 2, source: 'CI' })).toThrowError(
      /bench\.budgets\.correctness_failed/
    );
    expect(() => budgetsFromRuns({ runs: [], headroom: 2, source: 'CI' })).toThrowError(
      /bench\.budgets\.weak_evidence/
    );
    expect(() =>
      budgetsFromRuns({
        runs: [{ ...run('scn_a', [operation('query', 10)]), samples: 1 }],
        headroom: 2,
        source: 'CI',
      })
    ).toThrowError(/bench\.budgets\.weak_evidence/);
  });
});

describe('measurement provenance', () => {
  const measurement = {
    measurementProtocol: BENCH_MEASUREMENT_PROTOCOL,
    warmup: 1,
    samples: 20,
    repetitions: 1,
  };

  it('accepts a budget calibrated with the current protocol and counts', () => {
    const budgets = budgetsFromRuns({
      runs: [run('scn_a', [operation('query', 10)])],
      headroom: 2,
      source: 'CI',
    });

    expect(() => assertBudgetMeasurement(budgets, measurement)).not.toThrow();
  });

  it.each([
    ['protocol', { measurementProtocol: { ...BENCH_MEASUREMENT_PROTOCOL, version: 1 } }],
    ['warmup', { warmup: 0 }],
    ['sample count', { samples: 21 }],
    ['repetitions', { repetitions: 2 }],
  ])('rejects stale %s evidence before it can be consumed', (_name, change) => {
    const budgets = budgetsFromRuns({
      runs: [run('scn_a', [operation('query', 10)])],
      headroom: 2,
      source: 'CI',
    });

    expect(() => assertBudgetMeasurement(budgets, { ...measurement, ...change })).toThrowError(
      /bench\.budgets\.measurement_protocol_changed/
    );
  });

  it('rejects the previous schema instead of treating it as compatible', () => {
    const budgets = budgetsFromRuns({
      runs: [run('scn_a', [operation('query', 10)])],
      headroom: 2,
      source: 'CI',
    });

    expect(() => BenchBudgetsSchema.parse({ ...budgets, schema: 'tea-bench-budgets/1' })).toThrow();
  });
});

describe('timing resolution floor', () => {
  it('gates sub-millisecond operations at the declared floor instead of their noisy p95', () => {
    const budgets = budgetsFromRuns({
      runs: [run('scn_a', [operation('page-size-limit', 0.27)])],
      headroom: 2,
      source: 'CI',
    });

    expect(budgets.cases.scn_a?.operations['page-size-limit']).toEqual({ maxP95Ms: 5 });
    expect(budgets.cases.scn_a?.maxP95Ms).toBe(5);
    expect(budgets.floorMs).toBe(5);
  });
});

describe('policyForCase', () => {
  it('returns a manifest policy whose budgets match the calibrated case', () => {
    const budgets = budgetsFromRuns({
      runs: [run('scn_a', [operation('query', 10), operation('drain', 20)])],
      headroom: 2,
      source: 'calibrated',
    });

    expect(policyForCase(budgets, 'scn_a')).toMatchObject({
      modelVersion: 'tea-bench-budget/1',
      maxP95Ms: 60,
      operations: { query: { maxP95Ms: 20 }, drain: { maxP95Ms: 40 } },
    });
    expect(policyForCase(budgets, 'scn_unknown')).toBeUndefined();
  });
});
