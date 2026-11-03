import { describe, expect, it } from 'vitest';

import {
  minimumSamplesForPercentileResolution,
  percentileResolutionWarnings,
  summarize,
} from './metrics';

describe('percentile evidence resolution', () => {
  it('distinguishes a mathematical low-sample percentile from tail resolution', () => {
    expect(summarize([1, 2, 100])).toMatchObject({ p95Ms: 100, p99Ms: 100 });
    expect(minimumSamplesForPercentileResolution(0.95)).toBe(20);
    expect(minimumSamplesForPercentileResolution(0.99)).toBe(100);
    expect(summarize(Array.from({ length: 20 }, (_, index) => index + 1)).p95Ms).toBe(19);
    expect(summarize(Array.from({ length: 100 }, (_, index) => index + 1)).p99Ms).toBe(99);
  });
  it.each([
    [
      3,
      [
        'bench.workload.p95_evidence_low',
        'bench.metrics.p95_unresolved:min_samples=20',
        'bench.workload.p99_evidence_low',
        'bench.metrics.p99_unresolved:min_samples=100',
      ],
    ],
    [20, ['bench.workload.p99_evidence_low', 'bench.metrics.p99_unresolved:min_samples=100']],
    [99, ['bench.workload.p99_evidence_low', 'bench.metrics.p99_unresolved:min_samples=100']],
    [100, []],
  ] as const)('marks the two percentile resolutions separately at n=%i', (count, expected) => {
    expect(percentileResolutionWarnings(count)).toEqual(expected);
  });
});
