import type { CiBenchSummary } from './ciRunner';

const verdictIcon = (verdict: string | null | undefined): string =>
  verdict === 'pass' ? '✅' : verdict === 'fail' ? '❌' : '⚠️';
const formatMs = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `${value.toFixed(2)} ms`;
const cell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
const formatScore = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : value.toFixed(1);

export function renderCiSummaryMarkdown(summary: CiBenchSummary): string {
  const lines = [
    '## V2 Headless Benchmark',
    '',
    `**${verdictIcon(summary.verdict)} ${summary.verdict}** · backend=${summary.backend} · suite score=${formatScore(summary.score)} · rules=${summary.coverage.executedRuleIds.length}/${summary.coverage.requestedRuleIds.length}`,
    '',
    '| Rule | Case | Correctness | Performance | p95 | Budget | Score |',
    '| --- | --- | --- | --- | ---: | ---: | ---: |',
  ];
  for (const item of summary.cases.toSorted((left, right) =>
    left.ruleId.localeCompare(right.ruleId)
  )) {
    const source = item.sourceFullScaleScenarioId === null ? '' : ' *(bounded)*';
    lines.push(
      `| ${cell(item.ruleId)} | ${cell(item.title)}${source} | ${verdictIcon(item.correctnessVerdict)} ${item.correctnessVerdict} | ${verdictIcon(item.performanceVerdict)} ${item.performanceVerdict ?? 'not-compared'} | ${formatMs(item.caseP95Ms)} | ${formatMs(item.caseBudgetMs)} | ${formatScore(item.score)} |`
    );
  }
  for (const item of summary.cases.toSorted((left, right) =>
    left.ruleId.localeCompare(right.ruleId)
  )) {
    if ((item.operations ?? []).length === 0) continue;
    lines.push(
      '',
      `<details><summary>${cell(item.ruleId)} operations</summary>`,
      '',
      '| Operation | p95 | Budget | Score | Result |',
      '| --- | ---: | ---: | ---: | --- |'
    );
    for (const operation of item.operations) {
      lines.push(
        `| ${cell(operation.key)} | ${formatMs(operation.p95Ms)} | ${formatMs(operation.budgetMs)} | ${formatScore(operation.score)} | ${verdictIcon(operation.verdict)} ${operation.verdict} |`
      );
    }
    lines.push('', '</details>');
  }
  lines.push(
    '',
    '<details><summary>Coverage and exclusions</summary>',
    '',
    `- Requested rules: ${summary.coverage.requestedRuleIds.join(', ')}`,
    `- Executed rules: ${summary.coverage.executedRuleIds.join(', ')}`
  );
  for (const item of summary.cases.filter((entry) => entry.exclusionEvidence !== null)) {
    lines.push(`- ${item.ruleId}: ${cell(item.exclusionEvidence!)}`);
  }
  lines.push('', '</details>', '');
  return lines.join('\n');
}
