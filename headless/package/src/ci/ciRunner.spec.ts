import { describe, expect, it } from 'vitest';

import type { BenchRunReport } from '../runner/BenchRunner';
import { summarizeCiRuns } from './ciRunner';

describe('summarizeCiRuns', () => {
  const run = (
    scenarioId: string,
    performanceVerdict: BenchRunReport['performanceVerdict'],
    score: number | null,
    dimensions?: Readonly<Record<string, unknown>>
  ): BenchRunReport =>
    ({
      runId: `run-${scenarioId}`,
      caseId: scenarioId,
      title: scenarioId,
      verdict: 'pass',
      correctnessVerdict: 'pass',
      performanceVerdict,
      performance: score === null ? undefined : { score },
      operations: [],
      oracle: { status: 'pass', checks: [], warnings: [] },
      dimensions,
    }) as unknown as BenchRunReport;

  it('uses a geometric suite score and preserves per-case failures', () => {
    const summary = summarizeCiRuns([
      run('a', 'pass', 100),
      run('b', 'pass', 144),
      run('c', 'fail', 81),
    ]);

    expect(summary.score).toBeCloseTo(Math.cbrt(100 * 144 * 81));
    expect(summary.verdict).toBe('fail');
    expect(summary.cases[2]).toMatchObject({ scenarioId: 'c', performanceVerdict: 'fail' });
  });

  it('does not report a suite pass when one case lacks conclusive performance evidence', () => {
    const summary = summarizeCiRuns([run('a', 'pass', 100), run('b', 'inconclusive', null)]);

    expect(summary.score).toBeNull();
    expect(summary.verdict).toBe('inconclusive');
  });

  it('reports requested and executed rules with bounded-source evidence and dimensions', () => {
    const dimensions = {
      scenarioId: 'bounded',
      ruleId: 'R-PROP-004',
      ciScope: 'bounded',
      sourceFullScaleScenarioId: 'full-scale',
      ciSize: { rows: 100, graphDepth: 4, graphWidth: 8, fanout: 100 },
    };
    const summary = summarizeCiRuns(
      [run('bounded', 'pass', 100, dimensions)],
      [
        {
          scenarioId: 'bounded',
          ruleId: 'R-PROP-004',
          sourceFullScaleScenarioId: 'full-scale',
          exclusionEvidence: '不验证百万行容量',
        },
      ]
    );

    expect(summary.coverage).toEqual({
      requestedRuleIds: ['R-PROP-004'],
      executedRuleIds: ['R-PROP-004'],
    });
    expect(summary.cases[0]).toMatchObject({
      sourceFullScaleScenarioId: 'full-scale',
      exclusionEvidence: '不验证百万行容量',
      dimensions,
    });
  });

  it('does not pass a deliberately truncated requested rule set', () => {
    const summary = summarizeCiRuns(
      [run('a', 'pass', 100, { scenarioId: 'a', ruleId: 'R-QUERY-001' })],
      [{ scenarioId: 'a', ruleId: 'R-QUERY-001' }],
      ['R-QUERY-001', 'R-QUERY-002']
    );

    expect(summary.verdict).toBe('inconclusive');
    expect(summary.coverage).toEqual({
      requestedRuleIds: ['R-QUERY-001', 'R-QUERY-002'],
      executedRuleIds: ['R-QUERY-001'],
    });
  });

  it('reports observed p95 without claiming a performance pass during calibration', () => {
    const observed = {
      ...run('a', 'not-compared', null),
      operations: [{ key: 'update', p95Ms: 12.5 } as BenchRunReport['operations'][number]],
    } as BenchRunReport;
    const summary = summarizeCiRuns([observed]);
    expect(summary.verdict).toBe('inconclusive');
    expect(summary.cases[0]?.operations).toEqual([
      { key: 'update', p95Ms: 12.5, budgetMs: null, score: null, verdict: 'inconclusive' },
    ]);
  });

  it('does not report an empty run set as passing', () => {
    expect(summarizeCiRuns([])).toMatchObject({
      verdict: 'inconclusive',
      coverage: { requestedRuleIds: [], executedRuleIds: [] },
    });
  });
});
