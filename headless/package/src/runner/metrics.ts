import { BenchError } from '../errors';

const requireFiniteSamples = (samples: ReadonlyArray<number>, context: string): void => {
  if (samples.some((sample) => !Number.isFinite(sample))) {
    throw new BenchError('bench.metrics.invalid_sample', `${context} samples must all be finite`);
  }
};

export function percentile(sorted: ReadonlyArray<number>, p: number): number {
  const index = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[index]!;
}
/** Minimum n for nearest-rank p to select below the sample maximum. */
export function minimumSamplesForPercentileResolution(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new BenchError(
      'bench.metrics.percentile_invalid',
      'Percentile must be between zero and one'
    );
  }
  return Math.ceil(1 / (1 - p) - 1e-10);
}
/** Rank-resolution warnings, not a claim of statistical confidence above either minimum. */
export function percentileResolutionWarnings(sampleCount: number): ReadonlyArray<string> {
  const warnings: string[] = [];
  if (sampleCount < minimumSamplesForPercentileResolution(0.95)) {
    warnings.push('bench.workload.p95_evidence_low', 'bench.metrics.p95_unresolved:min_samples=20');
  }
  if (sampleCount < minimumSamplesForPercentileResolution(0.99)) {
    warnings.push(
      'bench.workload.p99_evidence_low',
      'bench.metrics.p99_unresolved:min_samples=100'
    );
  }
  return warnings;
}

export function summarize(samples: ReadonlyArray<number>): {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
} {
  if (samples.length === 0) {
    throw new BenchError('bench.metrics.empty_samples', 'Cannot summarize an empty sample set');
  }
  requireFiniteSamples(samples, 'Latency');

  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, sample) => sum + sample, 0);

  return {
    count: sorted.length,
    minMs: sorted[0]!,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1]!,
    meanMs: total / sorted.length,
  };
}
