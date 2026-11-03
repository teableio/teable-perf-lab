import { describe, expect, it } from 'vitest';

import type { CiBenchSummary } from './ciRunner';
import { renderCiSummaryMarkdown } from './renderSummary';

const summary: CiBenchSummary = {
  schema: 'tea-bench-ci/1',
  backend: 'postgres',
  score: 303.9,
  verdict: 'pass',
  coverage: {
    requestedRuleIds: ['R-FORMULA-001', 'R-PROP-004'],
    executedRuleIds: ['R-FORMULA-001', 'R-PROP-004'],
  },
  cases: [
    {
      scenarioId: 'scn-1',
      ruleId: 'R-FORMULA-001',
      title: '公式源值传播',
      correctnessVerdict: 'pass',
      performanceVerdict: 'pass',
      score: 303.9,
      caseP95Ms: 12.345,
      caseBudgetMs: 100,
      operations: [{ key: 'update', p95Ms: 8, budgetMs: 20, score: 250, verdict: 'pass' }],
      runPath: null,
      sourceFullScaleScenarioId: null,
      exclusionEvidence: null,
      dimensions: {},
    },
    {
      scenarioId: 'scn-2',
      ruleId: 'R-PROP-004',
      title: '百万行传播（CI有界变体）',
      correctnessVerdict: 'pass',
      performanceVerdict: 'pass',
      score: 100,
      caseP95Ms: 100,
      caseBudgetMs: 200,
      operations: [],
      runPath: null,
      sourceFullScaleScenarioId: 'scn-full',
      exclusionEvidence: '不验证百万行容量',
      dimensions: {},
    },
  ],
};

describe('renderCiSummaryMarkdown', () => {
  it('renders a reviewable benchmark table and bounded exclusions', () => {
    const markdown = renderCiSummaryMarkdown(summary);
    expect(markdown).toContain(
      '| Rule | Case | Correctness | Performance | p95 | Budget | Score |'
    );
    expect(markdown).toContain('R-FORMULA-001');
    expect(markdown).toContain('12.35 ms');
    expect(markdown).toContain('R-PROP-004');
    expect(markdown).toContain('不验证百万行容量');
    expect(markdown).toContain('rules=2/2');
    const firstRow = markdown.indexOf('| R-FORMULA-001');
    const secondRow = markdown.indexOf('| R-PROP-004');
    const detail = markdown.indexOf('<details><summary>R-FORMULA-001 operations</summary>');
    expect(firstRow).toBeGreaterThan(0);
    expect(secondRow).toBeGreaterThan(firstRow);
    expect(detail).toBeGreaterThan(secondRow);
  });
});
