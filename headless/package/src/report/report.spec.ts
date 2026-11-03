import { describe, expect, it } from 'vitest';

import { mergeReportSuiteReceipts } from './coverage';
import { exportTeaBenchReportRows } from './exportTeable';
import { deterministicTestExamples } from './fixtures/deterministicExamples';
import { deterministicTestReport } from './fixtures/deterministicReport';
import { createReportIds } from './ids';
import { renderTeaBenchReportHtml } from './renderHtml';
import { renderTeaBenchReportMarkdown } from './renderMarkdown';
import { TeaBenchReportSchema } from './schema';

const chartFigure = (html: string, title: string): string => {
  const caption = `<figcaption><strong>${title}</strong>`;
  const captionIndex = html.indexOf(caption);
  if (captionIndex < 0) throw new Error(`Missing chart figure: ${title}`);
  const start = html.lastIndexOf('<figure class="chart-figure"', captionIndex);
  const end = html.indexOf('</figure>', captionIndex);
  if (start < 0 || end < 0) throw new Error(`Incomplete chart figure: ${title}`);
  return html.slice(start, end + '</figure>'.length);
};

describe('suite receipt merging', () => {
  it('deduplicates receipt identities and derives counts', () => {
    const receipts = deterministicTestReport.catalogue.suiteReceipts;
    const coverage = mergeReportSuiteReceipts([[receipts[0]!], receipts]);
    expect(coverage.requested).toBe(2);
    expect(coverage.executed).toBe(1);
    expect(coverage.unsupported).toBe(1);
    expect(coverage.gaps).toHaveLength(1);
    const conflicting = structuredClone(receipts[0]!);
    conflicting.suiteId = 'conflict';
    expect(() => mergeReportSuiteReceipts([receipts, [conflicting]])).toThrow('冲突');
  });

  it('retains labelled JSON, Markdown, and row examples', () => {
    expect(deterministicTestExamples.label).toBe('deterministic-test-data-only');
    expect(JSON.parse(deterministicTestExamples.json).schema).toBe('tea-bench-report/2');
    expect(deterministicTestExamples.markdown).toContain('确定性测试');
    expect(deterministicTestExamples.rows.runRows).toHaveLength(1);
  });
});
describe('tea-bench-report/2', () => {
  it('validates deterministic suite receipts with distinct identities', () => {
    const result = TeaBenchReportSchema.parse(structuredClone(deterministicTestReport));
    expect(result.ids.catalogueId).toBe('cat_deterministic_001');
    expect(result.executions[0]?.scenarioId).toBe('scn_deterministic_001');
    expect(result.executions[0]?.executionId).toBe('exe_deterministic_001');
    expect(result.catalogue.suiteReceipts[0]?.rules.executedCount).toBe(1);
  });

  it('requires a reason for every null metric', () => {
    const input = structuredClone(deterministicTestReport);
    Object.assign(input.executions[0]!.operations[1]!.statistics, {
      p95: { value: null, unit: 'ms' },
    });
    expect(TeaBenchReportSchema.safeParse(input).success).toBe(false);
  });

  it('rejects averaged percentiles, mismatched samples, and fabricated coverage counts', () => {
    const averaged = structuredClone(deterministicTestReport);
    Object.assign(averaged.executions[0]!.operations[0]!.statistics.p95, { value: 3 });
    expect(TeaBenchReportSchema.safeParse(averaged).success).toBe(false);
    const counts = structuredClone(deterministicTestReport);
    counts.executions[0]!.operations[0]!.success = 2;
    expect(TeaBenchReportSchema.safeParse(counts).success).toBe(false);
    const coverage = structuredClone(deterministicTestReport);
    coverage.catalogue.pass = 2;
    expect(TeaBenchReportSchema.safeParse(coverage).success).toBe(false);
  });

  it('rejects orphan execution references and tautological correctness evidence', () => {
    const orphan = structuredClone(deterministicTestReport);
    orphan.executions = [];
    expect(TeaBenchReportSchema.safeParse(orphan).success).toBe(false);
    const tautology = structuredClone(deterministicTestReport);
    Object.assign(tautology.executions[0]!.correctness[0]!, { expected: 'pass', actual: 'pass' });
    expect(TeaBenchReportSchema.safeParse(tautology).success).toBe(false);
  });

  it('does not claim immutable reproducibility for a dirty or unknown commit', () => {
    const dirty = structuredClone(deterministicTestReport);
    dirty.provenance.commit.dirty = true;
    dirty.provenance.reproducibility.state = 'dirty';
    expect(TeaBenchReportSchema.safeParse(dirty).success).toBe(false);
    dirty.provenance.reproducibility.immutable = false;
    expect(TeaBenchReportSchema.safeParse(dirty).success).toBe(true);
    const unknown = structuredClone(deterministicTestReport);
    Object.assign(unknown.provenance.commit, { dirty: null, dirtyReason: 'Git 元数据不可用' });
    Object.assign(unknown.provenance.reproducibility, { state: 'unknown', immutable: false });
    expect(TeaBenchReportSchema.safeParse(unknown).success).toBe(true);
  });

  it('accepts a query-only execution without a synthetic drain or Bootstrap', () => {
    const queryOnly = structuredClone(deterministicTestReport);
    queryOnly.executions[0]!.operations.pop();
    queryOnly.runtime.phaseEvents.pop();
    queryOnly.comparison = null;
    queryOnly.methods.pairedBootstrap = null;
    queryOnly.methods.pairedBootstrapMissingReason = '没有基线';
    expect(TeaBenchReportSchema.safeParse(queryOnly).success).toBe(true);
    const markdown = renderTeaBenchReportMarkdown(queryOnly);
    expect(markdown).toContain('未执行配对 Bootstrap：没有基线');
  });

  it('explains p95 and p99 evidence limits separately', () => {
    const input = structuredClone(deterministicTestReport);
    input.warnings.push(
      { code: 'bench.workload.p95_evidence_low', message: 'p95 low', severity: 'warning' },
      { code: 'bench.workload.p99_evidence_low', message: 'p99 low', severity: 'warning' }
    );
    const markdown = renderTeaBenchReportMarkdown(input);
    expect(markdown).toContain('p95 少于 20 个成功样本');
    expect(markdown).toContain('p99 少于 100 个成功样本');
  });

  it('creates stable sha256 identities from canonical JSON', () => {
    const first = createReportIds({
      catalogue: { b: 2, a: 1 },
      scenario: { x: 1 },
      execution: { time: 1 },
    });
    const second = createReportIds({
      catalogue: { a: 1, b: 2 },
      scenario: { x: 1 },
      execution: { time: 1 },
    });
    expect(first).toEqual(second);
    expect(first.catalogueId).toMatch(/^catalogue_[0-9a-f]{64}$/);
    expect(first.scenarioId).toMatch(/^scenario_[0-9a-f]{64}$/);
    expect(first.executionId).toMatch(/^execution_[0-9a-f]{64}$/);
  });
});

describe('Chinese Markdown renderer', () => {
  it('uses Chinese-first summaries and moves complete technical evidence to an appendix', () => {
    const input = structuredClone(deterministicTestReport);
    input.provenance.postgres = null;
    const markdown = renderTeaBenchReportMarkdown(input);
    const [summary, appendix] = markdown.split('## 详细证据附录');

    expect(summary).toContain('正确性判定：通过');
    expect(summary).toContain('执行状态：通过');
    expect(summary).toContain('性能判定：未比较');
    expect(summary).toContain('测试批次');
    expect(summary).toContain('证据记录');
    expect(summary).toContain('规则：计划 1，执行 1');
    expect(summary).toContain('来源：计划 1，执行 1');
    expect(summary).toContain('边：计划 1，执行 1');
    expect(summary).toContain('PostgreSQL：未采集 / 不适用');
    expect(summary).toContain('方法=精确 JSON 比对');
    expect(summary).not.toContain('Oracle');
    expect(summary).not.toContain('Catalogue');
    expect(summary).not.toContain('Scenario');
    expect(summary).not.toContain('Execution');
    expect(summary).not.toContain('Suite');
    expect(summary).not.toContain('Receipt');
    expect(summary).not.toContain('exact-json');
    expect(summary).toContain('## 最慢操作');
    expect(summary).toContain('## 复现命令与产物');

    expect(appendix).toContain('完整场景目录 ID');
    expect(appendix).toContain('scn_remote_unsupported');
    expect(appendix).toContain('完整执行 ID：<code>exe_deterministic_001</code>');
    expect(appendix).toContain('完整运行 ID <code>run_deterministic_001</code>');
    expect(appendix).toContain('原始方法名：<code>exact-json</code>');
  });

  it('aggregates unconfigured gaps while retaining each full detail in the appendix', () => {
    const input = structuredClone(deterministicTestReport);
    const skipped = structuredClone(input.catalogue.suiteReceipts[1]!);
    skipped.receiptId = 'receipt_suite_skipped';
    skipped.scenarioId = 'scn_unconfigured_long_identifier';
    skipped.execution = 'skipped';
    skipped.reason = '本次未配置';
    input.catalogue.suiteReceipts.push(skipped);
    input.catalogue.requested += 1;
    input.catalogue.applicable += 1;
    input.catalogue.skipped += 1;
    input.catalogue.gaps.push({
      scenarioId: skipped.scenarioId,
      kind: 'skipped',
      reason: skipped.reason,
    });
    input.scope.registry.scenarioIds.push(skipped.scenarioId);

    const markdown = renderTeaBenchReportMarkdown(input);
    const [summary, appendix] = markdown.split('## 详细证据附录');
    expect(summary).toContain('跳过：1 个场景');
    expect(summary).not.toContain('scn_unconfigured_long_identifier');
    expect(appendix).toContain('scn_unconfigured_long_identifier');
    expect(appendix).toContain('本次未配置');
  });

  it('explains benchmark terminology in Chinese', () => {
    const markdown = renderTeaBenchReportMarkdown(deterministicTestReport);
    expect(markdown).toContain('最近秩百分位（nearest-rank）');
    expect(markdown).toContain('进程内 PostgreSQL（PGlite）');
    expect(markdown).toContain('完整重算（full-recompute）');
    expect(markdown).toContain('混合内联与排空（hybrid inline/flush）');
    expect(markdown).toContain('排空（flush）');
    expect(markdown).toContain('测试批次证据记录（suite receipt）');
  });

  it('escapes untrusted Markdown and validates before rendering', () => {
    const input = structuredClone(deterministicTestReport);
    input.scope.title = '标题 | *不能强调* <tag>';
    expect(renderTeaBenchReportMarkdown(input)).toContain('标题 \\| \\*不能强调\\* &lt;tag&gt;');
    input.executions[0]!.operations[0]!.attempted = 99;
    expect(() => renderTeaBenchReportMarkdown(input)).toThrow();
  });
});
describe('standalone Chinese HTML renderer', () => {
  it('renders layered, accessible explanations without external resources', () => {
    const input = structuredClone(deterministicTestReport);
    input.executions[0]!.artifacts = [];
    const html = renderTeaBenchReportHtml(input);

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<main id="main"');
    expect(html).toContain('<caption>各操作的样本与耗时摘要</caption>');
    expect(html).toContain('先看正确性，再单独看性能');
    expect(html).toContain('正确性凭据');
    expect(html).toContain('覆盖范围与缺口');
    expect(html).toContain('环境、来源与复现');
    expect(html).toContain('PGlite 是进程内、单写者后端');
    expect(html).toContain('不能代表生产 PostgreSQL');
    expect(html).toContain('n&lt;20 的 p95 仍落在最大样本');
    expect(html).toContain('完整重算与增量计算使用同一 Teable 计算引擎');
    expect(html).not.toMatch(/<(?:script|link)\b/i);
    expect(html).toContain('等待待处理的公式、查找、汇总等计算任务完成');
    expect(html).toContain('技术附录：完整标识符');
    expect(html).toContain('cat_deterministic_001');
    expect(html).toContain('run_deterministic_001');
    expect(html).not.toMatch(/\b(?:src|href)="https?:/i);
    expect(html).toContain('HTML 文件的位置由 <code>report render-html --out</code> 指定');
  });

  it('labels one timing sample as descriptive evidence and missing timing as unknown', () => {
    const input = structuredClone(deterministicTestReport);
    const measured = input.executions[0]!.operations[0]!;
    measured.attempted = 1;
    measured.success = 1;
    measured.rawSamples.values = [37];
    for (const statistic of Object.values(measured.statistics)) statistic.value = 37;

    const html = renderTeaBenchReportHtml(input);
    const measuredFigure = chartFigure(html, '测量操作耗时');
    const missingFigure = chartFigure(html, '计算排空耗时');

    expect(measuredFigure).toContain('37 ms · n=1');
    expect(measuredFigure).toContain('单个观察样本；p50/p95/p99 都是该样本，不构成分布证据');
    expect(measuredFigure).not.toContain('p95 性能通过');
    expect(missingFigure).toContain('未知（没有可用测量）');
    expect(missingFigure).toContain('没有可用数值，不按 0 绘制');
    expect(missingFigure).not.toContain('<rect');
    expect(missingFigure).not.toContain('class="chart-value">0');
  });

  it('uses an independent scale for every work-count metric', () => {
    const input = structuredClone(deterministicTestReport);
    input.executions[0]!.operations[0]!.work = {
      rowsRead: 60,
      rowsReturned: 6,
      rowsWritten: 3,
      processed: 2,
    };

    const html = renderTeaBenchReportHtml(input);

    expect(chartFigure(html, '读取行数')).toContain('data-chart-scale-max="60"');
    expect(chartFigure(html, '返回行数')).toContain('data-chart-scale-max="6"');
    expect(chartFigure(html, '写入行数')).toContain('data-chart-scale-max="3"');
    expect(chartFigure(html, '处理任务数（不是记录数）')).toContain('data-chart-scale-max="2"');
    expect(html).toContain('每种工作量使用各自刻度，不能跨图比较条长');
  });

  it('renders phaseEvents as event counts rather than elapsed durations', () => {
    const html = renderTeaBenchReportHtml(deterministicTestReport);
    const figure = chartFigure(html, '运行阶段事件数');

    expect(figure).toContain('data-chart-scale-max="1"');
    expect(figure).toContain('每条表示 phaseEvents 中该阶段事件的数量，不表示阶段持续时间');
    expect(figure).toContain('观察 observed 的运行事件计数；不是耗时');
    expect(figure).toContain('1 个事件');
    expect(figure).not.toContain('1000');
    expect(figure).not.toContain(' ms');
  });

  it('keeps zero coverage as independent counts without percentages or a funnel', () => {
    const input = structuredClone(deterministicTestReport);
    Object.assign(input.catalogue, {
      requested: 0,
      applicable: 0,
      planned: 0,
      executed: 0,
      pass: 0,
      fail: 0,
      skipped: 0,
      unsupported: 0,
      suiteReceipts: [],
      gaps: [],
    });

    const figure = chartFigure(renderTeaBenchReportHtml(input), '覆盖计数（独立项目，不是漏斗）');

    expect(figure).toContain('data-chart-scale-max="0"');
    expect(figure).toContain('0/0 保留真实的零计数，不计算百分比');
    expect(figure).toContain('data-chart-label="请求"');
    expect(figure).toContain('<td>0</td>');
    expect(figure).not.toContain('%');
    expect(figure).not.toMatch(/转化率[^。]*\d/);
  });

  it('includes text-table fallbacks and escapes hostile chart labels in SVG and HTML', () => {
    const input = structuredClone(deterministicTestReport);
    input.executions[0]!.operations[0]!.title = '<img src=x onerror="boom"> & "读取"';
    const html = renderTeaBenchReportHtml(input);
    const figure = chartFigure(html, '测量操作耗时');

    expect(figure).toContain('<div class="chart-text-fallback"><table>');
    expect(figure).toContain('<caption>测量操作耗时（文字数据）</caption>');
    expect(figure).toContain(
      'data-chart-label="&lt;img src=x onerror=&quot;boom&quot;&gt; &amp; &quot;读取&quot;"'
    );
    expect(figure).toContain('&lt;img src=x onerror=&quot;boom&quot;&gt; &amp; &quot;读取&quot;');
    expect(figure).not.toContain('<img src=x');
  });

  it('renders a semantic lifecycle with an explicit topology fallback', () => {
    const input = structuredClone(deterministicTestReport);
    input.dataset.name = 'reference-business-operations';
    const html = renderTeaBenchReportHtml(input);

    expect(html).toContain('业务数据与操作流程');
    expect(html).toContain('流程图的中文文字版');
    expect(html).toContain('准备');
    expect(html).toContain('查询 / 新增 / 修改 / 删除');
    expect(html).toContain('期望 vs 实际');
    expect(html).toContain('声明 declared');
    expect(html).toContain('观察 observed');
    expect(html).toContain('估计 estimated');
    expect(html).toContain('未知 unknown');
    expect(html).toContain('未提供可验证的 .tea 关联结构；不绘制业务拓扑');
    expect(html).not.toContain('<title>已声明的业务表关系</title>');
    expect(html).not.toContain('表节点和箭头仅取自哈希校验通过的 .tea 链接声明');
  });

  it('keeps four-table topology keys in separate lanes and preserves full escaped relations', () => {
    const input = structuredClone(deterministicTestReport);
    input.dataset.name = 'reference-business-operations';
    const html = renderTeaBenchReportHtml(input, undefined, {
      tables: [
        { id: 'accounts', name: 'Accounts' },
        { id: 'projects', name: 'Projects' },
        { id: 'work-items', name: 'Work Items' },
        { id: 'time-entries', name: 'Time Entries' },
      ],
      links: [
        { from: 'accounts', to: 'projects', label: 'Projects.Account → Accounts (manyOne)' },
        { from: 'projects', to: 'work-items', label: '工作项.所属项目 → 项目（多对一）' },
        {
          from: 'work-items',
          to: 'time-entries',
          label: '工时记录.<script>alert("x")</script> → 工作项（多对多）',
        },
      ],
    });
    const figureStart = html.indexOf('<figure class="business-flow">');
    const figureEnd = html.indexOf('</figure>', figureStart);
    const figure = html.slice(figureStart, figureEnd);
    const svg = figure.match(/<svg[^>]*viewBox="0 0 (\d+) (\d+)"[^>]*>([\s\S]*?)<\/svg>/);

    expect(svg).not.toBeNull();
    const viewWidth = Number(svg![1]);
    const svgContent = svg![3]!;
    const nodes = [
      ...svgContent.matchAll(
        /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"[^>]*class="topology-node"/g
      ),
    ].map((match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
    }));
    expect(nodes).toEqual([
      { x: 45, y: 46, width: 150, height: 56 },
      { x: 225, y: 46, width: 150, height: 56 },
      { x: 405, y: 46, width: 150, height: 56 },
      { x: 585, y: 46, width: 150, height: 56 },
    ]);
    const lastNode = nodes.at(-1)!;
    expect(viewWidth).toBeGreaterThan(lastNode.x + lastNode.width);

    const keys = [
      ...svgContent.matchAll(/<circle cx="(\d+)" cy="(\d+)" r="(\d+)" class="topology-edge-key"/g),
    ].map((match) => ({
      cx: Number(match[1]),
      cy: Number(match[2]),
      radius: Number(match[3]),
    }));
    expect(keys).toHaveLength(3);
    const nodeBottom = Math.max(...nodes.map(({ y, height }) => y + height));
    expect(keys.map(({ cy }) => cy)).toEqual([122, 146, 170]);
    keys.forEach(({ cy, radius }) => {
      expect(cy - radius).toBeGreaterThan(nodeBottom);
    });
    const routes = [
      ...svgContent.matchAll(
        /<path d="M (\d+) 102 V (\d+) H (\d+) V 108" class="topology-edge"\/>/g
      ),
    ].map((match) => ({
      sourceX: Number(match[1]),
      laneY: Number(match[2]),
      targetX: Number(match[3]),
    }));
    expect(routes.map(({ laneY }) => laneY)).toEqual(keys.map(({ cy }) => cy));
    routes.forEach(({ sourceX, targetX }, index) => {
      const source = nodes[index]!;
      const target = nodes[index + 1]!;
      expect(sourceX).toBeGreaterThan(source.x);
      expect(sourceX).toBeLessThan(source.x + source.width);
      expect(targetX).toBeGreaterThan(target.x);
      expect(targetX).toBeLessThan(target.x + target.width);
    });
    expect(routes[0]!.targetX).not.toBe(routes[1]!.sourceX);
    expect(
      [...svgContent.matchAll(/class="chart-note">(\d+)<\/text>/g)].map((match) => match[1])
    ).toEqual(['1', '2', '3']);
    expect(svgContent).not.toContain('Projects.Account');
    expect(svgContent).not.toContain('工作项.所属项目');
    expect(figure).toContain(
      '<td data-label="声明字段">Projects.Account → Accounts (manyOne)</td>'
    );
    expect(figure).toContain('<td data-label="声明字段">工作项.所属项目 → 项目（多对一）</td>');
    expect(figure).toContain(
      '<td data-label="声明字段">工时记录.&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; → 工作项（多对多）</td>'
    );
    expect(figure).not.toContain('<script>alert');
  });

  it('translates known invariants and reference operations while preserving raw traceability', () => {
    const input = structuredClone(deterministicTestReport);
    input.dataset.name = 'reference-business-operations';
    input.dataset.description = '确定性合成配方；行数为配方请求值。';
    const execution = input.executions[0]!;
    execution.operations[0]!.key = 'clear-time-membership';
    execution.operations[0]!.title = 'clear-time-membership';
    execution.operations[0]!.kind = 'write-update';
    const rowCount = execution.correctness[0]!;
    rowCount.checkId = 'reference/row-count-projects';
    rowCount.description = 'row-count Projects';
    rowCount.table = 'Projects';
    rowCount.field = null;
    rowCount.expected = 80;
    rowCount.actual = 80;
    rowCount.method = 'exact-row-count';
    const unique = structuredClone(rowCount);
    unique.checkId = 'reference/unique-projects';
    unique.description = 'unique-primary Projects';
    unique.method = 'set-uniqueness';
    execution.correctness.push(unique);
    input.conclusions[0]!.evidenceRefs = ['reference/row-count-projects', 'op_list_records'];

    const html = renderTeaBenchReportHtml(input);

    expect(html).toContain('清空一个工作项关联的工时记录');
    expect(html).toContain('原始操作键：<code>clear-time-membership</code>');
    expect(html).toContain('关联清空和汇总值从 6 变为 0');
    expect(html).toContain('Projects 的记录数符合预期');
    expect(html).toContain('Projects 的主字段值非空且没有重复');
    expect(html).toContain('原始检查说明：<code>row-count Projects</code>');
    expect(html).toContain('检查 ID：<code>reference/row-count-projects</code>');
    expect(html).toContain('这是确定性合成数据，不是客户数据');
    expect(html).toContain('项目内可执行的工作项');
    expect(html).toContain('“预期”是执行前声明的值或条件');
  });

  it('escapes report content according to HTML text and attribute contexts', () => {
    const input = structuredClone(deterministicTestReport);
    input.scope.title = '董事会 <script>alert("x")</script> & 审阅';
    input.scope.description = '范围 "有限" <b>不是 HTML</b>';
    input.executions[0]!.correctness[0]!.expected = '<img src=x onerror=alert(1)>';
    const html = renderTeaBenchReportHtml(input);

    expect(html).toContain('董事会 &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; 审阅');
    expect(html).toContain('范围 &quot;有限&quot; &lt;b&gt;不是 HTML&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
  });

  it('validates canonical schema before rendering', () => {
    const input = structuredClone(deterministicTestReport);
    input.executions[0]!.operations[0]!.attempted = 99;
    expect(() => renderTeaBenchReportHtml(input)).toThrow();
  });
});

describe('Teable offline export', () => {
  it('exports idempotent per-scenario and per-execution rows with units and raw evidence', () => {
    const first = exportTeaBenchReportRows(deterministicTestReport);
    expect(exportTeaBenchReportRows(structuredClone(deterministicTestReport))).toEqual(first);
    expect(first.scenarioRows).toHaveLength(2);
    expect(first.runRows).toHaveLength(1);
    expect(first.operationRows).toHaveLength(2);
    expect(first.correctnessRows).toHaveLength(1);
    expect(first.artifactRows).toHaveLength(1);
    expect(first.operationRows[0]).toMatchObject({ p95: 4, p95Unit: 'ms', sampleUnit: 'ms' });
    expect(first.operationRows[1]).toMatchObject({
      p95: null,
      p95MissingReason: '该阶段没有成功样本',
    });
    expect(first.runRows[0]?.rowKey).toMatch(/^run_[0-9a-f]{64}$/);
    expect(JSON.parse(String(first.runRows[0]?.reportRawJson))).toMatchObject({
      schema: 'tea-bench-report/2',
      evidenceKind: 'deterministic-test-data',
    });
    expect(JSON.parse(String(first.correctnessRows[0]?.expectedJson))).toBe(2);
  });

  it('never merges unrelated scenario samples', () => {
    const input = structuredClone(deterministicTestReport);
    const second = structuredClone(input.executions[0]!);
    second.executionId = 'exe_second';
    second.scenarioId = 'scn_second';
    second.runId = 'run_second';
    input.executions.push(second);
    const rows = exportTeaBenchReportRows(input);
    expect(rows.runRows).toHaveLength(2);
    expect(rows.operationRows).toHaveLength(4);
    expect(rows.operationRows[0]?.rowKey).not.toBe(rows.operationRows[2]?.rowKey);
    expect(rows.operationRows[0]?.samplesJson).toBe('[1,2,4]');
    expect(rows.operationRows[2]?.samplesJson).toBe('[1,2,4]');
  });
});
