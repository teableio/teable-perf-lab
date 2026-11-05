import { describe, expect, it } from 'vitest';

import type { BenchOperationObservation } from './BenchRunner';
import {
  executeMeasured,
  executeMeasuredReplacingRelation,
  finalizeMeasurement,
  finalizeMeasurementReplacingWarnings,
  makeMeasurements,
  mergeObservation,
  mergeObservationReplacingRelation,
  recordMeasuredResult,
  RecordedBenchFailure,
  RecordedOperationFailure,
} from './operationMeasurements';

const cases = [
  { key: 'first', kind: 'query-core' as const },
  { key: 'second', kind: 'write-update' as const },
];

const observation = (
  recordIds: ReadonlyArray<string>,
  recordRelation: BenchOperationObservation['recordRelation'] = 'returned',
  fieldNames: ReadonlyArray<string> = []
): BenchOperationObservation => ({
  recordIds,
  recordRelation,
  fieldNames,
  truncated: false,
});

describe('standalone operation measurements', () => {
  it('initializes every declared operation in declaration order', () => {
    const measurements = makeMeasurements(cases);
    expect([...measurements.keys()]).toEqual(['first', 'second']);
    expect(measurements.get('first')).toMatchObject({ samplesMs: [], errors: 0, warnings: [] });
  });

  it('records only measured successful results', () => {
    const measurements = makeMeasurements(cases);
    const first = measurements.get('first')!;
    recordMeasuredResult(first, false, {
      latencyMs: 9,
      rowsRead: 100,
      observation: observation(['a']),
    });
    expect(first).toMatchObject({ samplesMs: [], rowsRead: 0, errors: 0 });
    recordMeasuredResult(first, true, {
      latencyMs: 4,
      rowsRead: 2,
      rowsWritten: 3,
      rowsReturned: 1,
      processed: 5,
      observation: observation(['a', 'b'], 'returned', ['Amount']),
    });
    expect(first).toMatchObject({
      samplesMs: [4],
      rowsRead: 2,
      rowsWritten: 3,
      rowsReturned: 1,
      processed: 5,
      observation: observation(['a', 'b'], 'returned', ['Amount']),
    });
  });

  it('preserves or replaces the incoming relation according to the track contract', () => {
    const current = observation(['a'], 'command-target', ['A']);
    const incoming = observation(['b'], 'none', ['B']);
    expect(mergeObservation(current, incoming)).toMatchObject({
      recordIds: ['a', 'b'],
      recordRelation: 'command-target',
      fieldNames: ['A', 'B'],
    });
    expect(mergeObservationReplacingRelation(current, incoming)).toMatchObject({
      recordIds: ['a', 'b'],
      recordRelation: 'none',
      fieldNames: ['A', 'B'],
    });
  });

  it('retains the existing truncation rule based on input lengths', () => {
    const merged = mergeObservation(
      observation(Array.from({ length: 60 }, (_, index) => `same-${index}`)),
      observation(Array.from({ length: 60 }, (_, index) => `same-${index}`))
    );
    expect(merged).toMatchObject({ recordIds: expect.any(Array), truncated: true });
    expect(merged?.recordIds).toHaveLength(60);
  });

  it('finalizes empty operations and warns at percentile resolution limits', () => {
    const measurements = makeMeasurements(cases);
    const empty = finalizeMeasurement(measurements.get('first')!);
    expect(empty).toMatchObject({ count: 0, p95Ms: null, p99Ms: null });
    expect(empty.warnings).toContain('bench.workload.p95_evidence_low');
    expect(empty.warnings).toContain('bench.workload.p99_evidence_low');

    const first = measurements.get('second')!;
    first.warnings.push('custom-warning');
    recordMeasuredResult(first, true, { latencyMs: 10 });
    const finalized = finalizeMeasurement(first);
    expect(finalized.warnings).toEqual([
      'custom-warning',
      'bench.workload.p95_evidence_low',
      'bench.metrics.p95_unresolved:min_samples=20',
      'bench.workload.p99_evidence_low',
      'bench.metrics.p99_unresolved:min_samples=100',
    ]);
    expect(finalizeMeasurementReplacingWarnings(first).warnings).not.toContain('custom-warning');
  });

  it('returns data and records only successful measured samples', async () => {
    const measurements = makeMeasurements(cases);
    const errors: string[] = [];
    const result = await executeMeasured({
      key: 'first',
      measured: true,
      measurements,
      errors,
      action: async () => ({ data: 'value', latencyMs: 7, rowsRead: 1 }),
    });
    expect(result).toBe('value');
    expect(errors).toEqual([]);
    expect(measurements.get('first')).toMatchObject({ samplesMs: [7], rowsRead: 1 });
  });

  it('records warmup and measured failures without a successful sample', async () => {
    const measurements = makeMeasurements(cases);
    const errors: string[] = [];
    await expect(
      executeMeasured({
        key: 'first',
        measured: false,
        measurements,
        errors,
        action: async () => {
          throw new Error('warmup-failed');
        },
      })
    ).rejects.toBeInstanceOf(RecordedOperationFailure);
    expect(measurements.get('first')).toMatchObject({ samplesMs: [], errors: 1 });
    expect(errors).toEqual(['first: warmup-failed']);
  });

  it('uses the incoming relation only for the query track helper', async () => {
    const measurements = makeMeasurements(cases);
    const errors: string[] = [];
    await executeMeasuredReplacingRelation({
      key: 'first',
      measured: true,
      measurements,
      errors,
      action: async () => ({
        data: undefined,
        latencyMs: 1,
        observation: observation(['a'], 'none'),
      }),
    });
    expect(measurements.get('first')?.observation?.recordRelation).toBe('none');
  });

  it('lets cleanup markers share the recorded-failure hierarchy', () => {
    expect(new RecordedOperationFailure('key', new Error('cause'))).toBeInstanceOf(
      RecordedBenchFailure
    );
    expect(new RecordedBenchFailure('cleanup')).toBeInstanceOf(RecordedBenchFailure);
  });
});
