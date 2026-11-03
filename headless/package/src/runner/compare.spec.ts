import { describe, expect, it } from 'vitest';
import type { BenchRunReport } from './BenchRunner';
import { compareReports } from './compare';

function report(
  samplesMs: ReadonlyArray<number>,
  p95Ms: number | null,
  overrides: Partial<BenchRunReport> = {}
): BenchRunReport {
  const operation = {
    key: 'query',
    kind: 'query-core' as const,
    samplesMs,
    count: samplesMs.length,
    minMs: samplesMs.length === 0 ? null : Math.min(...samplesMs),
    p50Ms: p95Ms,
    p95Ms,
    p99Ms: p95Ms,
    maxMs: samplesMs.length === 0 ? null : Math.max(...samplesMs),
    meanMs:
      samplesMs.length === 0
        ? null
        : samplesMs.reduce((sum, sample) => sum + sample, 0) / samplesMs.length,
    rowsRead: 0,
    rowsWritten: 0,
    rowsReturned: 0,
    processed: 0,
    errors: 0,
    warnings: [],
  };
  return {
    specVersion: 1,
    generatorVersion: 'test/1',
    seed: { schema: 1, data: 2, query: 3, schedule: 4 },
    warmup: 0,
    samples: samplesMs.length,
    runId: 'baseline',
    caseId: 'sha256:case',
    title: 'case',
    backend: 'pglite',
    commit: 'unknown',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:00.000Z',
    manifestPath: 'case.manifest.json',
    teaPath: 'fixture.tea',
    environment: {
      node: 'test',
      platform: 'test',
      arch: 'test',
      runtime: 'node test',
      computationMode: 'hybrid-inline-and-flush',
    },
    complexity: { profile: {} as never, assessments: {}, warnings: [] },
    budgets: undefined,
    repetitions: [],
    operations: [operation],
    oracle: { status: 'pass', checks: [], warnings: [] },
    verdict: 'pass',
    errors: [],
    warnings: [],
    ...overrides,
  };
}

describe('compareReports', () => {
  it('keeps ordinary independent runs inconclusive even when sample counts match', () => {
    const baseline = report([10, 10, 10, 10], 10, { runId: 'baseline' });
    const candidate = report([10, 10, 10, 10], 10, { runId: 'candidate' });
    const result = compareReports({ baseline, candidate });
    expect(result.operations[0]).toMatchObject({
      baselineP95Ms: 10,
      candidateP95Ms: 10,
      effectRatio: 1,
      ciLow: null,
      ciHigh: null,
      verdict: 'inconclusive',
    });
    expect(result.warnings).toContain('bench.compare.pairing_evidence_missing:query');
    expect(result.verdict).toBe('inconclusive');
  });

  it('reports the descriptive p95 ratio without a regression threshold', () => {
    const baseline = report(Array(20).fill(100), 100, { runId: 'baseline' });
    const candidate = report(Array(20).fill(120), 120, { runId: 'candidate' });
    const result = compareReports({ baseline, candidate });
    expect(result.operations[0]).toMatchObject({ effectRatio: 1.2, verdict: 'inconclusive' });
    expect(result.verdict).toBe('inconclusive');
  });
  it('fails an explicit candidate p95 SLO independently of an unpaired baseline', () => {
    const baseline = report(Array(20).fill(100), 100);
    const candidate = report(Array(20).fill(120), 120, {
      budgets: { sloP95Ms: 110, sloSource: 'service objective' },
    });
    const result = compareReports({ baseline, candidate });
    expect(result.verdict).toBe('fail');
    expect(result.warnings).toContain('bench.compare.slo_p95_exceeded:query');
  });

  it('does not pass an SLO from a low-sample mathematical p95', () => {
    const baseline = report([100, 100], 100);
    const candidate = report([90, 90], 90, {
      budgets: { sloP95Ms: 110, sloSource: 'service objective' },
    });
    const result = compareReports({ baseline, candidate });
    expect(result.verdict).toBe('inconclusive');
    expect(result.warnings).toContain('bench.compare.percentile_evidence_low:query');
  });

  it('does not pass when either source report is inconclusive', () => {
    const passing = report([10, 10, 10, 10], 10);
    const inconclusive = report([10, 10, 10, 10], 10, { verdict: 'inconclusive' });

    const baselineInconclusive = compareReports({ baseline: inconclusive, candidate: passing });
    const candidateInconclusive = compareReports({ baseline: passing, candidate: inconclusive });

    expect(baselineInconclusive.verdict).toBe('inconclusive');
    expect(baselineInconclusive.warnings).toContain('bench.compare.baseline_inconclusive');
    expect(candidateInconclusive.verdict).toBe('inconclusive');
    expect(candidateInconclusive.warnings).toContain('bench.compare.candidate_inconclusive');
  });

  it('does not pass reports with a not-run oracle', () => {
    const baseline = report([10, 10, 10, 10], 10);
    const candidate = report([10, 10, 10, 10], 10, {
      oracle: { status: 'not-run', checks: [], warnings: [] },
    });

    const result = compareReports({ baseline, candidate });

    expect(result.verdict).toBe('inconclusive');
    expect(result.warnings).toContain('bench.compare.candidate_oracle_not-run');
  });

  it('treats backend mismatches as inconclusive', () => {
    const baseline = report([10, 10, 10, 10], 10, { backend: 'pglite' });
    const candidate = report([10, 10, 10, 10], 10, { backend: 'postgres' });

    const result = compareReports({ baseline, candidate });

    expect(result.verdict).toBe('inconclusive');
    expect(result.warnings).toContain('bench.compare.backend_mismatch');
  });

  it('emits null comparison metrics for insufficient samples', () => {
    const baseline = report([], null);
    const candidate = report([], null);

    const result = compareReports({ baseline, candidate });

    expect(result.verdict).toBe('inconclusive');
    expect(result.warnings).toContain('bench.compare.percentile_evidence_low:query');
    expect(result.operations[0]).toMatchObject({
      baselineP95Ms: null,
      candidateP95Ms: null,
      effectRatio: null,
      ciLow: null,
      ciHigh: null,
      verdict: 'inconclusive',
    });
    expect(JSON.stringify(result)).not.toContain('NaN');
  });

  it('does not compare samples when their latency summary is missing', () => {
    const baseline = report([10, 10, 10], null);
    const candidate = report([10, 10, 10], 10);

    const result = compareReports({ baseline, candidate });

    expect(result.verdict).toBe('inconclusive');
    expect(result.warnings).toContain('bench.compare.pairing_evidence_missing:query');
    expect(result.operations[0]?.effectRatio).toBeNull();
  });

  it('keeps unpaired comparisons inconclusive without non-finite metrics', () => {
    const baseline = report([10, 10, 10], 10);
    const candidate = report([10, 10, 10, 10], 10);

    const result = compareReports({ baseline, candidate });

    expect(result.verdict).toBe('inconclusive');
    expect(result.warnings).toContain('bench.compare.pairing_evidence_missing:query');
    expect(result.operations[0]).toMatchObject({
      effectRatio: 1,
      ciLow: null,
      ciHigh: null,
      verdict: 'inconclusive',
    });
  });

  it('does not compare operations with different kinds', () => {
    const baseline = report([10, 10, 10], 10);
    const candidate = report([10, 10, 10], 10, {
      operations: [
        {
          ...report([10, 10, 10], 10).operations[0]!,
          kind: 'flush-computed',
        },
      ],
    });

    const result = compareReports({ baseline, candidate });

    expect(result.operations).toEqual([]);
    expect(result.verdict).toBe('inconclusive');
    expect(result.warnings).toContain('bench.compare.operation_kind_mismatch:query');
  });
});
