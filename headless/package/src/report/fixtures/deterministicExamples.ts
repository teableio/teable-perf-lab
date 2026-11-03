import { writeFile } from 'node:fs/promises';
import { canonicalJson } from '../../case/canonicalJson';
import { exportTeaBenchReportRows } from '../exportTeable';
import { renderTeaBenchReportMarkdown } from '../renderMarkdown';
import { deterministicTestReport } from './deterministicReport';

/** 确定性测试数据，不是实际测量：JSON、中文 Markdown、离线 Teable rows 的完整示例。 */
export const deterministicTestExamples = {
  label: 'deterministic-test-data-only',
  json: canonicalJson(deterministicTestReport),
  markdown: renderTeaBenchReportMarkdown(deterministicTestReport),
  rows: exportTeaBenchReportRows(deterministicTestReport),
};

if (process.argv[1]?.endsWith('/deterministicExamples.ts')) {
  await Promise.all([
    writeFile(
      new URL('./deterministic-report.json', import.meta.url),
      `${deterministicTestExamples.json}\n`
    ),
    writeFile(
      new URL('./deterministic-report.example.md', import.meta.url),
      `${deterministicTestExamples.markdown}\n`
    ),
    writeFile(
      new URL('./deterministic-rows.json', import.meta.url),
      `${JSON.stringify(deterministicTestExamples.rows, null, 2)}\n`
    ),
  ]);
  process.stdout.write(`${JSON.stringify(deterministicTestExamples, null, 2)}\n`);
}
