import { describe, expect, it } from 'vitest';

import type { BenchCaseManifest } from '../case/manifest';
import { deterministicTestReport } from '../report/fixtures/deterministicReport';
import { renderTeaBenchReportHtml } from '../report/renderHtml';
import type { BenchRunReport } from '../runner/BenchRunner';
import { buildTeaBenchImpactGraph } from './build';
import { explainOperation } from './explain';
import { exportTeaBenchImpactRows } from './rows';

const structure = {
  tables: [
    {
      id: 'tblImpactRecords0',
      name: 'Records',
      fields: [
        { id: 'fldImpactAmount000', name: 'Amount' },
        { id: 'fldImpactDouble000', name: 'Doubled' },
      ],
    },
  ],
};

const manifest = {
  workload: [
    {
      key: 'list-records',
      kind: 'query-core',
      table: 'Records',
      query: { projection: ['Amount'], limit: 2 },
    },
    {
      key: 'flush-computed',
      kind: 'flush-computed',
    },
    {
      key: 'checkpoint',
      kind: 'checkpoint',
      check: {
        checkId: 'check',
        description: 'check',
        obligationIds: [],
        kind: 'row-count',
        table: 'Records',
        expected: 2,
      },
    },
  ],
} as unknown as BenchCaseManifest;

const run = {
  oracle: { status: 'pass', checks: [], warnings: [] },
  operations: [
    {
      key: 'list-records',
      kind: 'query-core',
      processed: 0,
      observation: {
        recordIds: ['recObserved000001'],
        recordRelation: 'returned',
        fieldNames: ['Amount'],
        truncated: false,
      },
    },
    {
      key: 'flush-computed',
      kind: 'flush-computed',
      processed: 3,
      observation: { recordIds: [], recordRelation: 'none', fieldNames: [], truncated: false },
    },
  ],
  complexity: {
    assessments: {
      ['list-records']: {
        breakdown: {
          paths: [
            {
              mode: 'sameRecord',
              fromFieldId: 'fldImpactAmount000',
              toFieldId: 'fldImpactDouble000',
              fromTableId: 'tblImpactRecords0',
              toTableId: 'tblImpactRecords0',
            },
          ],
        },
      },
    },
  },
} as unknown as BenchRunReport;

describe('tea-bench-impact-graph/1', () => {
  it('labels declared, estimated, observed, and unknown evidence without cell values', () => {
    const sidecar = buildTeaBenchImpactGraph({
      report: deterministicTestReport,
      run,
      manifest,
      structure,
    });
    const list = sidecar.graphs.op_list_records!;
    const flush = sidecar.graphs.op_flush_computed!;

    expect(sidecar.schema).toBe('tea-bench-impact-graph/1');
    expect(Object.keys(sidecar.graphs)).toEqual(['op_list_records', 'op_flush_computed']);
    expect(list.evidence).toEqual(
      expect.arrayContaining(['declared', 'estimated', 'observed', 'unknown'])
    );
    expect(list.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ evidence: 'declared', relation: 'declares-query-source' }),
        expect.objectContaining({ evidence: 'estimated', relation: 'estimated-sameRecord-path' }),
        expect.objectContaining({
          evidence: 'observed',
          relation: 'observed-query-returned-record',
        }),
      ])
    );
    expect(JSON.stringify(sidecar)).not.toContain('cellValue');
    expect(JSON.stringify(sidecar)).not.toContain('pass/fail 由 AI');
    expect(flush.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: 'processed-task-count', label: '处理任务 3' }),
      ])
    );
    expect(flush.explanation.actual.map((item) => item.description).join(' ')).toContain(
      '不是记录'
    );
    expect(flush.notes.join(' ')).toContain('表、记录和单元格未观察');
  });

  it('exports table-ready operation, node, and edge rows', () => {
    const rows = exportTeaBenchImpactRows(
      buildTeaBenchImpactGraph({ report: deterministicTestReport, run, manifest, structure })
    );
    expect(rows.operationRows).toHaveLength(2);
    expect(rows.nodeRows.some((row) => row.recordId === 'recObserved000001')).toBe(true);
    expect(rows.edgeRows.some((row) => row.evidence === 'estimated')).toBe(true);
  });
  it('renders every manifest step in reconciled phase groups with collapsed evidence', () => {
    const sidecar = buildTeaBenchImpactGraph({
      report: deterministicTestReport,
      run,
      manifest,
      structure,
    });
    const graph = sidecar.graphs.op_list_records!;
    graph.explanation.title = '<img src=x onerror=alert(1)>';
    const html = renderTeaBenchReportHtml(deterministicTestReport, sidecar);
    const renderedSteps = [...html.matchAll(/class="step-index">步骤 (\d+)</g)].map((match) =>
      Number(match[1])
    );
    const groupedStepTotal = [...html.matchAll(/data-step-count="(\d+)"/g)].reduce(
      (sum, match) => sum + Number(match[1]),
      0
    );

    expect(sidecar.steps.map((step) => step.key)).toEqual([
      'list-records',
      'flush-computed',
      'checkpoint',
    ]);
    expect(renderedSteps).toEqual([1, 2, 3]);
    expect(groupedStepTotal).toBe(sidecar.steps.length);
    expect(html).toContain('展开完整关系与凭据');
    expect(html).toContain('展开完整检查凭据');
    expect(html).toContain('正在读取或修改什么（声明）');
    expect(html).toContain('预期结果（manifest 声明）');
    expect(html).toContain('实际凭据（runner 确定性代码）');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html.indexOf('原始操作键：<code>list-records')).toBeLessThan(
      html.indexOf('原始步骤键：<code>checkpoint')
    );
  });
  it('explains the exact project query and Active null-to-true sequence without AI inference', () => {
    const projectQuery = explainOperation({
      step: {
        key: 'query-project-budget',
        kind: 'query-core',
        table: 'Projects',
        query: { limit: 3, includeTotal: true },
      },
      manifest: { title: 'reference-business-operations' } as BenchCaseManifest,
      run,
      checks: [],
    });
    expect(projectQuery.action).toContain('Budget > 9999');
    expect(projectQuery.action).toContain('Title 升序');
    expect(projectQuery.action).toContain('Title、Budget、Budget Reserve');
    expect(projectQuery.action).toContain('limit=3');
    expect(projectQuery.action).toContain('includeTotal=true');

    const restoreActive = explainOperation({
      step: {
        key: 'restore-account-active',
        kind: 'write-update',
        table: 'Accounts',
        field: 'Active',
        rows: 20,
        batchSize: 20,
        typecast: false,
        value: { kind: 'literal', value: true },
      },
      manifest: { title: 'reference-business-operations' } as BenchCaseManifest,
      run,
      checks: [],
    });
    expect(restoreActive.valueTransition).toContain('20 条 Accounts.Active');
    expect(restoreActive.valueTransition).toContain('null 不等于 false');
    expect(restoreActive.valueTransition).toContain('没有声明 Active 的下游计算依赖');
    expect(restoreActive.valueTransition).toContain('reference/restore-active');
    expect(restoreActive.notObserved.join(' ')).toContain('不能推出实际受影响行数');
  });
});
