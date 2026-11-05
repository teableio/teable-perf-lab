import { renderOperationExplanationCard } from '../impact/render';
import { parseTeaBenchImpactGraph, type TeaBenchImpactGraph } from '../impact/schema';
import { parseTeaBenchReport, type ReportMetric, type TeaBenchReport } from './schema';
import type { DeclaredBusinessTopology } from './topology';

const verdictLabel = {
  pass: '通过',
  fail: '失败',
  skipped: '跳过',
  unsupported: '不支持',
  inconclusive: '证据不足',
  unknown: '未知',
  ['not-executed']: '未执行',
  ['not-run']: '未运行',
  ['not-compared']: '未比较',
} as const;

const evidenceLabel = {
  observed: '实测记录',
  ['deterministic-test-data']: '确定性格式测试数据',
  ['legacy-unknown']: '历史迁移数据（细节未知）',
} as const;

const gapLabel = {
  ['not-applicable']: '不适用',
  ['not-planned']: '未纳入计划',
  ['not-executed']: '未执行',
  skipped: '跳过',
  unsupported: '不支持',
} as const;

const operationExplanation: Readonly<Record<string, string>> = {
  ['query-core']: '读取表中的记录，检验基础筛选、排序或分页。',
  ['query-structured']: '按结构化条件查询记录，检验条件组合与结果集合。',
  ['write-create']: '新增业务记录；写入确认与后续计算排空分别记录。',
  ['write-update']: '修改已有业务记录，观察字段、关联和计算结果的变化。',
  ['write-delete']: '删除业务记录；删除后的行数和关联状态由正确性检查确认。',
  ['flush-computed']: '等待待处理的公式、查找、汇总等计算任务完成。',
  ['sample-setup']: '为一个独立样本准备并导入相同测试数据；不计入业务操作耗时。',
};

const referenceOperationLabel: Readonly<Record<string, string>> = {
  ['query-project-budget']: '查询项目预算与预算储备金',
  ['query-time-cost']: '查询工时记录与成本',
  ['create-work-items']: '新增两个工作项',
  ['flush-after-create']: '等待新增工作项后的计算完成',
  ['update-work-estimate']: '修改工作项的预估工时',
  ['flush-after-estimate']: '等待预估工时公式更新完成',
  ['query-updated-work']: '核对修改后的预估工时与计划投入',
  ['clear-time-membership']: '清空一个工作项关联的工时记录',
  ['flush-after-clear-membership']: '等待清空关联后的汇总更新完成',
  ['query-cleared-membership']: '核对清空关联后的汇总工时',
  ['restore-time-membership']: '恢复一个工作项的三条工时关联',
  ['flush-after-restore-membership']: '等待恢复关联后的汇总更新完成',
  ['query-restored-membership']: '核对恢复关联后的汇总工时',
  ['clear-account-active']: '清空全部账户的启用状态',
  ['flush-after-clear-active']: '等待账户状态变更处理完成',
  ['restore-account-active']: '把全部账户恢复为启用',
  ['flush-after-restore-active']: '等待账户启用状态恢复完成',
  ['cycle-project-status']: '轮换四个项目的业务状态',
  ['flush-after-project-status']: '等待项目状态变更处理完成',
  ['flush-after-rejected-budget']: '确认无效预算被拒绝后的计算队列为空',
  ['delete-time-entry']: '删除一条工时记录',
  ['flush-after-delete']: '等待删除工时记录后的计算完成',
};

const referenceOperationContext: Readonly<Record<string, string>> = {
  ['query-project-budget']: '项目属于账户；本操作读取项目预算，并核对由预算公式得到的 10% 储备金。',
  ['query-time-cost']: '工时记录表示某个工作项的一次投入；本操作读取工时，并核对按小时计算的成本。',
  ['create-work-items']: '工作项表示项目内可执行的任务；新增记录后用行数凭据确认创建结果。',
  ['update-work-estimate']: '把工作项预估从 8 调整为 10，并核对计划投入公式从 16 更新为 20。',
  ['clear-time-membership']:
    '暂时移除工作项到工时记录的关联，用于验证关联清空和汇总值从 6 变为 0。',
  ['restore-time-membership']: '重新关联三条各 2 小时的工时记录，用于验证汇总值从 0 恢复为 6。',
  ['delete-time-entry']: '删除是本场景最后一次写入；随后排空计算，并核对最终工时记录数为 1,199。',
};

const invariantDescription = (description: string, table: string | null, field: string | null) => {
  const tableLabel = table ?? '相关表';
  if (description.startsWith('row-count ')) return `${tableLabel} 的记录数符合预期`;
  if (description.startsWith('unique-primary ')) return `${tableLabel} 的主字段值非空且没有重复`;
  if (description.startsWith('link-count '))
    return `${tableLabel}${field ? `“${field}”` : ''}的关联数量符合预期`;
  if (description.startsWith('computed-not-null '))
    return `${tableLabel}${field ? `“${field}”` : ''}的计算结果均已生成`;
  return description;
};

const methodExplanation: Readonly<Record<string, string>> = {
  ['exact-json']: '把实际结果与预先写明的 JSON 值逐项比较。',
  ['normalized-exact-json']: '先做稳定化处理，再与预先写明的 JSON 值逐项比较。',
  ['exact-row-count']: '确认实际记录数与预期数字完全一致。',
  ['row-count']: '确认实际记录数与预期数字一致。',
  ['exact-field-values']: '确认指定记录的字段值与预期值完全一致。',
  ['set-uniqueness']: '确认结果集合没有重复项。',
  ['exact-link-count']: '确认关联记录数量与预期完全一致。',
  ['computed-non-null-scan']: '确认指定计算字段没有意外空值。',
  ['full-recompute-at-sequence-position']:
    '在指定步骤进行完整重算，并与增量计算结果比较；两条路径使用同一计算引擎。',
  ['fresh-runtime-full-recompute']:
    '在全新运行环境中完整重算，并与增量计算结果比较；两条路径使用同一计算引擎。',
  ['exact-record-id-sequence']: '确认记录标识及顺序与预期完全一致。',
  ['exact-query-values-ordered']: '确认查询结果的每个字段值及行顺序都与预期完全一致。',
  ['exact-query-values-multiset']: '确认查询结果包含与预期相同的各行，不要求行顺序。',
  ['expected-domain-error-and-unchanged-state']:
    '确认无效操作返回预期业务错误，并且数据状态没有被意外修改。',
  ['legacy-unknown']: '历史报告没有记录具体检查方法。',
};

const warningExplanation: Readonly<Record<string, string>> = {
  ['bench.workload.percentile_evidence_low']:
    '成功样本太少，百分位只能作数学描述，不能支持性能通过。',
  ['bench.workload.p95_evidence_low']:
    'p95 少于 20 个成功样本，最近秩仍落在最大样本，不能作为 p95 性能证据。',
  ['bench.workload.p99_evidence_low']:
    'p99 少于 100 个成功样本，仅为描述性数学估计，不参与性能通过判定。',
  ['bench.computation.hybrid_inline_and_flush']:
    '写入可能同步完成部分计算，显式排空只记录剩余异步工作；两段需一起理解。',
};

const explainWarning = (code: string, message: string): string => {
  const exact = warningExplanation[code];
  if (exact) return exact;
  if (code.startsWith('bench.metrics.p95_unresolved'))
    return 'p95 未达到至少 20 个样本的最低分辨率。';
  if (code.startsWith('bench.metrics.p99_unresolved'))
    return 'p99 未达到至少 100 个样本的最低分辨率。';
  return message;
};

const escapeHtml = (value: unknown): string =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const json = (value: unknown): string => escapeHtml(JSON.stringify(value));

const metric = (value: ReportMetric): string =>
  value.value === null
    ? `缺失（${escapeHtml(value.missingReason)}）`
    : `${escapeHtml(value.value.toLocaleString('zh-CN', { maximumFractionDigits: 4, useGrouping: false }))} ${escapeHtml(value.unit)}`;

const statusClass = (status: string): string =>
  status === 'pass' ? 'status-pass' : status === 'fail' ? 'status-fail' : 'status-neutral';

const rows = (values: ReadonlyArray<ReadonlyArray<unknown>>): string =>
  values
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${typeof cell === 'string' ? cell : escapeHtml(cell)}</td>`).join('')}</tr>`
    )
    .join('');

const referencePhaseStart: Readonly<Record<string, string>> = Object.fromEntries([
  ['query-project-budget', '初始读取：预算与工时成本'],
  ['create-work-items', '工作项写入：新增、修改与计算核对'],
  ['clear-time-membership', '关联变化：清空、恢复与汇总核对'],
  ['clear-account-active', '账户与项目：状态变更及错误拒绝'],
  ['delete-time-entry', '清理与最终一致性'],
]);

const renderWorkflow = (topology: DeclaredBusinessTopology | undefined): string => {
  const tables = topology?.tables ?? [];
  const links = topology?.links ?? [];
  const names = new Map(tables.map((table) => [table.id, table.name]));
  const tableX = (index: number): number => 45 + index * 180;
  const businessLinks = links
    .map(
      (link, index) =>
        `<tr><td data-label="图中编号"><span class="relation-key">${index + 1}</span></td><td data-label="来源表">${escapeHtml(names.get(link.from) ?? link.from)}</td><td data-label="证据">声明 link 字段方向</td><td data-label="目标表">${escapeHtml(names.get(link.to) ?? link.to)}</td><td data-label="声明字段">${escapeHtml(link.label)}</td></tr>`
    )
    .join('');
  const tableNodes = tables
    .map(
      (table, index) =>
        `<g><rect x="${tableX(index)}" y="46" width="150" height="56" rx="6" fill="#fff" stroke="#aebdb7" stroke-width="2" class="topology-node"/><text x="${tableX(index) + 75}" y="79" text-anchor="middle" class="chart-label">${escapeHtml(table.name)}</text></g>`
    )
    .join('');
  const tableEdges = links
    .map((link, index) => {
      const from = tables.findIndex((table) => table.id === link.from);
      const to = tables.findIndex((table) => table.id === link.to);
      if (from < 0 || to < 0) return '';
      const sourceX = tableX(from) + 99;
      const targetX = tableX(to) + 51;
      const laneY = 122 + index * 24;
      const keyX = (sourceX + targetX) / 2;
      const relationNumber = index + 1;
      return `<path d="M ${sourceX} 102 V ${laneY} H ${targetX} V 108" class="topology-edge"/><g aria-label="关系 ${relationNumber}；完整声明见下方关系表"><circle cx="${keyX}" cy="${laneY}" r="10" class="topology-edge-key"/><text x="${keyX}" y="${laneY}" dy=".35em" text-anchor="middle" class="chart-note">${relationNumber}</text></g>`;
    })
    .join('');
  const topologyHeight = Math.max(135, 114 + links.length * 24);
  const topologySvg = tables.length
    ? `<div class="topology-scroll"><svg class="topology-graph" viewBox="0 0 ${Math.max(260, tables.length * 180 + 50)} ${topologyHeight}" role="img" aria-label=".tea 结构声明的业务表关系；箭头编号对应下方完整关系表" aria-describedby="business-relations-caption"><title>已声明的业务表关系</title><desc>表节点和编号箭头仅取自哈希校验通过的 .tea 链接声明；完整字段关系见下方表格。</desc><defs><marker id="topology-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#176b55"/></marker></defs>${tableEdges}${tableNodes}</svg></div>`
    : '<p>未提供可验证的 .tea 关联结构；不绘制业务拓扑。数据规模仍见页首。</p>';
  return `<section id="workflow" class="workflow" aria-labelledby="workflow-title"><div class="section-heading"><div><h2 id="workflow-title">业务数据与操作流程</h2><p>沿业务对象读写，等待计算完成，再用预先声明的期望核对实测结果。</p></div><ul class="legend" aria-label="证据图例"><li><span class="mark declared"></span>声明 declared：manifest / schema</li><li><span class="mark observed"></span>观察 observed：runner 凭据</li><li><span class="mark estimated"></span>估计 estimated：复杂度推导</li><li><span class="mark unknown"></span>未知 unknown：没有足够证据</li></ul></div><figure class="business-flow"><figcaption><strong>业务对象关系（声明 declared）</strong></figcaption>${topologySvg}<div class="chart-text-fallback"><table class="relation-table"><caption id="business-relations-caption">业务表关系（文字版）</caption><thead><tr><th scope="col">图中编号</th><th scope="col">来源表</th><th scope="col">证据</th><th scope="col">目标表</th><th scope="col">声明字段</th></tr></thead><tbody>${businessLinks || '<tr><td colspan="5">未知：没有可验证的 .tea 结构</td></tr>'}</tbody></table></div></figure><figure class="lifecycle-flow"><figcaption><strong>操作生命周期（声明的执行计划，不是计算单元格传播图）</strong></figcaption><ol class="lifecycle-strip"><li><strong>准备</strong><span>导入固定数据</span></li><li><strong>查询 / 新增 / 修改 / 删除</strong><span>执行业务操作</span></li><li><strong>排空计算</strong><span>等待剩余计算完成</span></li><li><strong>期望 vs 实际</strong><span>确定性核对</span></li><li><strong>报告</strong><span>保留 runner 凭据</span></li></ol></figure><div class="flow-fallback" aria-label="流程图的中文文字版"><h3>流程文字版</h3><ol>${topology?.links.map((link) => `<li>业务关系：${escapeHtml(names.get(link.from) ?? link.from)} →（声明 declared）${escapeHtml(names.get(link.to) ?? link.to)}；${escapeHtml(link.label)}。</li>`).join('') ?? '<li>业务关系：未知 unknown，未绘制。</li>'}<li>运行计划：准备 →（声明 declared）查询/新增/修改/删除 →（声明 declared）排空计算 →（声明 declared）比较期望与实际 →（声明 declared）生成报告。</li><li>实测结果标为观察 observed；估计 estimated 只作复杂度解释；未知 unknown 不作结论。</li></ol></div></section>`;
};

const svgText = (value: string): string => escapeHtml(value);

const renderBarFigure = (input: {
  title: string;
  description: string;
  rows: ReadonlyArray<{ label: string; value: number | null; valueLabel: string; note?: string }>;
  evidence: string;
}): string => {
  const values = input.rows.flatMap((row) => (row.value === null ? [] : [row.value]));
  const rowHeight = 34;
  const max = Math.max(...values, 0);
  const scaleMax = max === 0 ? 1 : max;
  const width = 760;
  const labelWidth = 225;
  const barWidth = 390;
  const height = Math.max(64, input.rows.length * rowHeight + 28);
  const shapes = input.rows
    .map((row, index) => {
      const y = 28 + index * rowHeight;
      const bar = row.value === null ? 0 : (row.value / scaleMax) * barWidth;
      return `<g data-chart-label="${escapeHtml(row.label)}">${row.value === null ? `<text x="0" y="${y + 17}" class="chart-label">${svgText(row.label)}</text><text x="${labelWidth}" y="${y + 17}" class="chart-unknown">未知</text>` : `<text x="0" y="${y + 17}" class="chart-label">${svgText(row.label)}</text><rect x="${labelWidth}" y="${y + 4}" width="${Math.max(bar, row.value > 0 ? 2 : 0)}" height="14" rx="2" class="chart-bar"></rect><text x="${labelWidth + barWidth + 12}" y="${y + 17}" class="chart-value">${svgText(row.valueLabel)}</text>`}${row.note ? `<text x="${labelWidth}" y="${y + 30}" class="chart-note">${svgText(row.note)}</text>` : ''}</g>`;
    })
    .join('');
  const tableRows = input.rows
    .map(
      (row) =>
        `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${row.value === null ? '未知（没有可用测量）' : escapeHtml(row.valueLabel)}</td><td>${escapeHtml(row.note ?? input.evidence)}</td></tr>`
    )
    .join('');
  return `<figure class="chart-figure" data-chart-scale-max="${max}"><figcaption><strong>${escapeHtml(input.title)}</strong><span>${escapeHtml(input.description)}</span></figcaption><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(input.title)}。${escapeHtml(input.description)}。证据：${escapeHtml(input.evidence)}。表格提供同一数据的文字表示。"><title>${escapeHtml(input.title)}</title><desc>${escapeHtml(input.description)}；证据：${escapeHtml(input.evidence)}。</desc>${shapes}</svg><div class="chart-text-fallback"><table><caption>${escapeHtml(input.title)}（文字数据）</caption><thead><tr><th scope="col">项目</th><th scope="col">数值</th><th scope="col">证据说明</th></tr></thead><tbody>${tableRows}</tbody></table></div></figure>`;
};

const renderTimingCharts = (report: TeaBenchReport): string => {
  const operations = report.executions.flatMap((execution) => execution.operations);
  const groups = (['measurement', 'drain'] as const).map((phase) => {
    const rows = operations
      .filter((operation) => operation.phase === phase)
      .map((operation) => {
        const samples = operation.rawSamples.values.length;
        const value = samples > 0 ? operation.statistics.p50.value : null;
        const label = referenceOperationLabel[operation.key] ?? operation.title;
        const note =
          samples === 1
            ? `单个观察样本；p50/p95/p99 都是该样本，不构成分布证据；尝试 ${operation.attempted}、成功 ${operation.success}、失败 ${operation.errors}`
            : `n=${samples} 个观察样本；${samples < 20 ? 'p95 最近秩落在最大样本，分辨率不足' : 'p95 达到最低样本数'}；${samples < 100 ? 'p99 仅作数学描述，未达到最低分辨率' : 'p99 达到最低样本数'}；尝试 ${operation.attempted}、成功 ${operation.success}、失败 ${operation.errors}`;
        return {
          label,
          value,
          valueLabel:
            value === null
              ? `未知 · n=0 · 尝试 ${operation.attempted}、成功 ${operation.success}、失败 ${operation.errors}`
              : `${value} ms · n=${samples}`,
          note: value === null ? `${note}；没有可用数值，不按 0 绘制` : note,
        };
      });
    return rows.length
      ? renderBarFigure({
          title: phase === 'measurement' ? '测量操作耗时' : '计算排空耗时',
          description: '条长表示操作 p50 耗时（毫秒）；每张图仅在自身组内共享刻度。',
          rows,
          evidence: '观察 observed；原始成功样本数同时标示。',
        })
      : '';
  });
  return groups.join('');
};

const renderWorkCharts = (report: TeaBenchReport): string => {
  const operations = report.executions.flatMap((execution) => execution.operations);
  const metrics = [
    ['rowsRead', '读取行数'],
    ['rowsReturned', '返回行数'],
    ['rowsWritten', '写入行数'],
    ['processed', '处理任务数（不是记录数）'],
  ] as const;
  return `<section class="chart-section" aria-labelledby="work-chart-title"><h3 id="work-chart-title">操作工作量</h3><p>每种工作量使用各自刻度，不能跨图比较条长；所有值均为 runner 观察记录，processed 表示任务数而非记录数。</p>${metrics
    .map(([key, title]) =>
      renderBarFigure({
        title,
        description: '本图独立刻度。',
        evidence: '观察 observed。',
        rows: operations.map((operation) => ({
          label: referenceOperationLabel[operation.key] ?? operation.title,
          value: operation.work[key],
          valueLabel: String(operation.work[key]),
        })),
      })
    )
    .join('')}</section>`;
};

const renderPhaseEventChart = (report: TeaBenchReport): string => {
  const counts = new Map<string, number>();
  for (const event of report.runtime.phaseEvents) {
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  }
  const rows = ['setup', 'sample-setup', 'warmup', 'measurement', 'drain'].map((kind) => ({
    label: kind,
    value: counts.get(kind) ?? 0,
    valueLabel: `${counts.get(kind) ?? 0} 个事件`,
  }));
  return renderBarFigure({
    title: '运行阶段事件数',
    description: '每条表示 phaseEvents 中该阶段事件的数量，不表示阶段持续时间。',
    rows,
    evidence: '观察 observed 的运行事件计数；不是耗时。',
  });
};

const renderCoverageChart = (report: TeaBenchReport): string =>
  renderBarFigure({
    title: '覆盖计数（独立项目，不是漏斗）',
    description: '每个计数单独阅读，不代表阶段转化率。0/0 保留真实的零计数，不计算百分比。',
    evidence: 'suite receipt 汇总计数；只描述该报告范围。',
    rows: [
      ['requested', '请求'],
      ['applicable', '适用'],
      ['planned', '计划'],
      ['executed', '执行'],
      ['pass', '通过'],
      ['fail', '失败'],
      ['skipped', '跳过'],
      ['unsupported', '不支持'],
    ].map(([key, label]) => ({
      label,
      value: report.catalogue[key as keyof typeof report.catalogue] as number,
      valueLabel: String(report.catalogue[key as keyof typeof report.catalogue]),
    })),
  });

const renderPerformance = (
  report: TeaBenchReport,
  impact: TeaBenchImpactGraph | undefined
): string => {
  const operationRows = report.executions.flatMap((execution) =>
    execution.operations.map((operation) => {
      const count = operation.rawSamples.values.length;
      const operationLabel = referenceOperationLabel[operation.key] ?? operation.title;
      const purpose = referenceOperationContext[operation.key];
      return [
        `${escapeHtml(operationLabel)}<span class="help">原始操作键：<code>${escapeHtml(operation.key)}</code></span>`,
        `<code>${escapeHtml(operation.kind)}</code><span class="help">${escapeHtml(operationExplanation[operation.kind] ?? '报告未提供该自定义操作的通俗说明。')}${purpose ? ` ${escapeHtml(purpose)}` : ''}</span>`,
        escapeHtml(operation.phase),
        String(count),
        metric(operation.statistics.p50),
        metric(operation.statistics.p95),
        count < 20
          ? '<strong class="status-neutral">样本不足，不能判定 p95 性能通过</strong>'
          : '达到最近秩最低分辨率，但仍不代表生产置信保证',
      ];
    })
  );
  const comparison =
    report.comparison === null
      ? '<p>没有提供可比较的基线，因此本报告不作性能升降结论。</p>'
      : `<p>基线比较：<strong class="${statusClass(report.comparison.verdict)}">${escapeHtml(verdictLabel[report.comparison.verdict])}</strong>。环境兼容性：${escapeHtml(report.comparison.environmentCompatibility.status)}。</p>`;
  // eslint-disable-next-line sonarjs/cognitive-complexity -- renders the complete discriminated step evidence surface
  const impactSections = (() => {
    if (!impact) return '';
    const groups: Array<{ phase: string; cards: string[] }> = [];
    let currentPhase = '初始读取';
    const checks = new Map(
      report.executions.flatMap((execution) =>
        execution.correctness.map((check) => [check.checkId, check] as const)
      )
    );
    for (const step of impact.steps) {
      const graph = step.operationId ? impact.graphs[step.operationId] : undefined;
      const operation = report.executions
        .flatMap((execution) => execution.operations)
        .find((candidate) => candidate.operationId === step.operationId);
      const status = step.statuses.includes('fail')
        ? 'fail'
        : step.statuses.length > 0
          ? step.statuses.every((value) => value === 'pass')
            ? 'pass'
            : 'unknown'
          : operation
            ? operation.errors > 0
              ? 'fail'
              : operation.success > 0
                ? 'pass'
                : 'not-run'
            : 'unknown';
      currentPhase = referencePhaseStart[step.key] ?? currentPhase;
      const phase = currentPhase;
      const card =
        graph && operation
          ? `<section class="operation-impact">${renderOperationExplanationCard(graph, { status, stepNumber: step.order + 1, stepOrder: step.order })}<details class="sample-detail"><summary>查看性能样本摘要</summary><p>成功样本 ${operation.rawSamples.values.length} 个；p50 ${metric(operation.statistics.p50)}；p95 ${metric(operation.statistics.p95)}。低样本不支持性能通过。</p></details></section>`
          : `<article class="operation-card" data-step-order="${step.order}" aria-labelledby="step-${step.order}"><div class="operation-heading"><span class="step-index">步骤 ${step.order + 1}</span><strong class="status ${statusClass(status)}">${escapeHtml(verdictLabel[status as keyof typeof verdictLabel] ?? status)}</strong></div><h3 id="step-${step.order}">${escapeHtml(step.title)}</h3><p class="operation-purpose">${escapeHtml(step.description)}</p><dl class="operation-brief"><div><dt>目标</dt><dd>${escapeHtml(step.kind)}</dd></div><div><dt>预期</dt><dd>${step.checkId && checks.has(step.checkId) ? escapeHtml(invariantDescription(checks.get(step.checkId)!.description, checks.get(step.checkId)!.table, checks.get(step.checkId)!.field)) : '执行 manifest 声明的操作'}</dd></div></dl><details class="evidence-detail"><summary>展开完整检查凭据</summary><div class="detail-body"><p>原始步骤键：<code>${escapeHtml(step.key)}</code>；检查 ID：<code>${escapeHtml(step.checkId ?? '未知')}</code></p><p>方法：<code>${escapeHtml(step.method ?? '未知')}</code>；runner 判定：${escapeHtml(step.statuses.join('、') || '未知')}。</p><p>状态检查链：${step.chain.map(escapeHtml).join(' → ')}；此检查验证此前操作序列后的状态，不单独证明某一步计算造成了哪些单元格变化。</p>${step.checkId && checks.has(step.checkId) ? `<p>预期：<code>${json(checks.get(step.checkId)!.expected)}</code>；实际：<code>${json(checks.get(step.checkId)!.actual)}</code></p>` : ''}</div></details></article>`;
      const previous = groups.at(-1);
      if (previous?.phase === phase) previous.cards.push(card);
      else groups.push({ phase, cards: [card] });
    }
    return groups
      .map(
        ({ phase, cards }, index) =>
          `<section class="operation-phase" data-step-count="${cards.length}" aria-labelledby="phase-${index}"><div class="phase-heading"><h3 id="phase-${index}">${escapeHtml(phase)}</h3><span>${cards.length} 个步骤</span></div><div class="operation-list">${cards.join('')}</div></section>`
      )
      .join('');
  })();
  return `<section id="performance" aria-labelledby="performance-title">
<h2 id="performance-title">性能数据（与正确性分开）</h2>
${comparison}
<section class="chart-section" aria-labelledby="timing-chart-title"><h3 id="timing-chart-title">运行计数与耗时图</h3><p>耗时条表示观察样本 p50；n=1 时 p50/p95/p99 都等于该样本，不构成分布证据。n&lt;20 的 p95 仍落在最大样本；n&lt;100 的 p99 仅作数学描述。各工作量指标与阶段事件分别按每图独立刻度。缺失测量显示未知且不画数值条；尝试、成功、失败、n 亦显示于图注或原值表中。</p>${renderTimingCharts(report)}${renderWorkCharts(report)}${renderPhaseEventChart(report)}</section>
<details class="technical-detail"><summary>查看各操作性能表</summary><div class="detail-body"><div class="table-wrap"><table><caption>各操作的样本与耗时摘要</caption><thead><tr><th scope="col">操作</th><th scope="col">含义</th><th scope="col">阶段</th><th scope="col">成功样本</th><th scope="col">p50</th><th scope="col">p95</th><th scope="col">证据解释</th></tr></thead><tbody>${rows(operationRows)}</tbody></table></div></div></details>${impact ? `<div class="operations-heading"><h2>${impact.steps.length} 步操作时间线</h2><p>按 manifest 顺序分阶段展示。每张卡默认只显示目的、目标、预期和状态；完整关系、检查 ID、原始键与证据按需展开。</p></div><aside class="read-guide" aria-label="如何阅读操作卡"><strong>如何读：</strong><span>声明 = 执行前写明</span><span>观察 = runner 记录</span><span>估计 = 复杂度推导</span><span>未知 = 不作结论</span></aside>${impactSections}` : ''}
</section>`;
};

const renderCorrectness = (report: TeaBenchReport): string => {
  const checkRows = report.executions.flatMap((execution) =>
    execution.correctness.map((check) => [
      `${escapeHtml(invariantDescription(check.description, check.table, check.field))}<span class="help">原始检查说明：<code>${escapeHtml(check.description)}</code><br>检查 ID：<code>${escapeHtml(check.checkId)}</code></span>`,
      `<strong class="${statusClass(check.status)}">${escapeHtml(verdictLabel[check.status])}</strong>`,
      escapeHtml(methodExplanation[check.method] ?? '按报告记录的自定义方法检查。'),
      `<code>${json(check.expected)}</code>`,
      `<code>${json(check.actual)}</code>`,
      check.unknownReason ? escapeHtml(check.unknownReason) : '—',
    ])
  );
  return `<section id="correctness" aria-labelledby="correctness-title">
<h2 id="correctness-title">正确性凭据</h2>
<p>这些检查回答“结果是否符合事先写明的预期”。“预期”是执行前声明的值或条件（由 manifest 作者提供）；“实际”是本次运行读取到的值或统计。所有状态都由 runner 的确定性代码比较生成，不调用 AI，也不是模型判断。“通过”表示两者按所列方法相符，不代表覆盖全部行为。</p>
${checkRows.length === 0 ? '<p>本报告没有正确性检查记录。</p>' : `<details class="technical-detail"><summary>查看全部 ${checkRows.length} 项预期 / 实际凭据</summary><div class="detail-body"><div class="table-wrap"><table><caption>逐项正确性检查</caption><thead><tr><th scope="col">检查内容</th><th scope="col">状态</th><th scope="col">怎么检查</th><th scope="col">预期</th><th scope="col">实际</th><th scope="col">说明</th></tr></thead><tbody>${rows(checkRows)}</tbody></table></div></div></details>`}
</section>`;
};

const renderCoverage = (report: TeaBenchReport): string => {
  const gapRows = report.catalogue.gaps.map((gap) => [
    gap.scenarioId ? `<code>${escapeHtml(gap.scenarioId)}</code>` : '未指定场景',
    escapeHtml(gapLabel[gap.kind]),
    escapeHtml(gap.reason),
  ]);
  return `<section id="coverage" aria-labelledby="coverage-title">
<h2 id="coverage-title">覆盖范围与缺口</h2>
<p>覆盖数字由测试批次的实际凭据汇总，不代表所有 Teable 功能。目录中“存在”也不等于本次“执行”。</p>
<ul class="facts"><li>请求：${report.catalogue.requested}</li><li>适用：${report.catalogue.applicable}</li><li>计划：${report.catalogue.planned}</li><li>执行：${report.catalogue.executed}</li><li>通过：${report.catalogue.pass}</li><li>失败：${report.catalogue.fail}</li><li>跳过：${report.catalogue.skipped}</li><li>不支持：${report.catalogue.unsupported}</li></ul>${renderCoverageChart(report)}
${gapRows.length === 0 ? '<p>本报告没有记录覆盖缺口。</p>' : `<div class="table-wrap"><table><caption>未覆盖或未执行的项目</caption><thead><tr><th scope="col">场景</th><th scope="col">类型</th><th scope="col">原因</th></tr></thead><tbody>${rows(gapRows)}</tbody></table></div>`}
</section>`;
};

const renderLimitations = (report: TeaBenchReport): string => {
  const limitations = [
    ...report.limitations,
    ...(report.comparison?.limitations ?? []),
    ...report.conclusions.flatMap((conclusion) => conclusion.limitations),
  ];
  return `<section id="limitations" aria-labelledby="limitations-title">
<h2 id="limitations-title">警告与局限</h2>
<div class="warning"><strong>必须保留的解释边界：</strong>本报告只描述列出的 headless core/database 场景。PGlite 是进程内、单写者后端；它可用于语义与本地回归检查，但其耗时不能代表生产 PostgreSQL、HTTP 服务、多用户并发或部署容量。完整重算与增量计算使用同一 Teable 计算引擎，因此一致性不是独立的公式语义证明。</div>
<h3>已记录局限</h3>${limitations.length === 0 ? '<p>没有额外记录项；上述固定边界仍然适用。</p>' : `<ul>${limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`}
<h3>运行警告</h3>${report.warnings.length === 0 ? '<p>没有运行警告。</p>' : `<ul>${report.warnings.map((warning) => `<li><strong>${escapeHtml(warning.severity)}</strong> / <code>${escapeHtml(warning.code)}</code>：${escapeHtml(explainWarning(warning.code, warning.message))}</li>`).join('')}</ul>`}
</section>`;
};

const renderProvenance = (report: TeaBenchReport): string => {
  const commandItems = report.provenance.reproducibility.commands
    .map(
      (command) =>
        `<li><strong>${escapeHtml(command.label)}</strong>${command.cwd ? `（工作目录：<code>${escapeHtml(command.cwd)}</code>）` : ''}<pre><code>${escapeHtml(command.argv.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(' '))}</code></pre></li>`
    )
    .join('');
  const artifactItems = report.executions
    .flatMap((execution) => execution.artifacts)
    .map(
      (artifact) =>
        `<li>${escapeHtml(artifact.kind)}：<code>${escapeHtml(artifact.path)}</code>；SHA-256 <code>${escapeHtml(artifact.sha256)}</code></li>`
    )
    .join('');
  return `<section id="provenance" aria-labelledby="provenance-title">
<h2 id="provenance-title">环境、来源与复现</h2>
<dl class="details"><div><dt>后端</dt><dd>${escapeHtml(report.provenance.backend.kind)} ${escapeHtml(report.provenance.backend.version)}</dd></div><div><dt>PostgreSQL</dt><dd>${report.provenance.postgres ? escapeHtml(report.provenance.postgres.version) : '未采集或不适用'}</dd></div><div><dt>主机</dt><dd>${escapeHtml(report.provenance.host.os)} / ${escapeHtml(report.provenance.host.arch)} / ${escapeHtml(report.provenance.host.cpu)}；${report.provenance.host.logicalCpuCount} 逻辑 CPU</dd></div><div><dt>提交</dt><dd>${report.provenance.commit.sha ? `<code>${escapeHtml(report.provenance.commit.sha)}</code>` : `未知：${escapeHtml(report.provenance.commit.shaMissingReason ?? '未说明')}`}</dd></div><div><dt>工作区</dt><dd>${report.provenance.commit.dirty === false ? '干净' : report.provenance.commit.dirty === true ? '有未提交修改' : `未知：${escapeHtml(report.provenance.commit.dirtyReason ?? '未说明')}`}</dd></div><div><dt>运行时间</dt><dd><time datetime="${escapeHtml(report.runtime.startedAt)}">${escapeHtml(report.runtime.startedAt)}</time> 至 <time datetime="${escapeHtml(report.runtime.completedAt)}">${escapeHtml(report.runtime.completedAt)}</time></dd></div><div><dt>数据哈希</dt><dd><code>${escapeHtml(report.provenance.dataHash ?? '未知')}</code></dd></div><div><dt>测试归档哈希</dt><dd><code>${escapeHtml(report.provenance.fixtureHash ?? '未知')}</code></dd></div></dl>
<h3>复现命令</h3><ol>${commandItems}</ol>
<h3>产物</h3>${artifactItems ? `<ul>${artifactItems}</ul>` : '<p>规范报告没有记录附加产物路径。当前 HTML 文件的位置由 <code>report render-html --out</code> 指定；请以 CLI 成功输出或运行文档中的路径为准。</p>'}
</section>`;
};

export function renderTeaBenchReportHtml(
  input: unknown,
  impactInput?: unknown,
  topology?: DeclaredBusinessTopology
): string {
  const report = parseTeaBenchReport(input);
  const impact = impactInput === undefined ? undefined : parseTeaBenchImpactGraph(impactInput);
  if (impact && impact.executionId !== report.ids.executionId) {
    throw new Error('Impact graph executionId does not match the canonical report');
  }
  const rowCounts = Object.entries(report.dataset.rowCounts)
    .map(([table, count]) => `<li><strong>${escapeHtml(table)}</strong>：${count} 行</li>`)
    .join('');
  const exclusions = report.scope.exclusions
    .map(
      (exclusion) =>
        `<li><strong>${escapeHtml(exclusion.subject)}</strong>：${escapeHtml(exclusion.reason)}</li>`
    )
    .join('');
  const conclusions = report.conclusions
    .map(
      (conclusion) =>
        `<li>${escapeHtml(conclusion.statement)} <span class="help">置信度：${escapeHtml(conclusion.confidence)}</span></li>`
    )
    .join('');
  const identifiers = [
    ['完整场景目录 ID', report.ids.catalogueId],
    ['完整场景 ID', report.ids.scenarioId],
    ['完整执行 ID', report.ids.executionId],
    ...report.executions.flatMap((execution) => [
      ['完整运行 ID', execution.runId],
      ['完整物化 case ID', execution.caseId],
    ]),
  ];
  const identifierRows = identifiers
    .map(
      ([label, value]) =>
        `<tr><th scope="row">${escapeHtml(label)}</th><td><code>${escapeHtml(value)}</code></td></tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(report.scope.title)}｜Teable 基准报告</title>
<style>
:root{color-scheme:light;--ink:#17221f;--muted:#56635f;--line:#d8e0dc;--panel:#f3f7f5;--soft:#e8f2ef;--accent:#176b55;--observed:#2459a9;--estimated:#9a5c12;--pass:#176b46;--fail:#a12525;--warn:#7a520b}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:#fff;font:16px/1.58 system-ui,-apple-system,"Segoe UI",sans-serif}.skip{position:absolute;left:-9999px}.skip:focus{left:1rem;top:1rem;background:#fff;padding:.65rem 1rem;z-index:2;outline:3px solid var(--accent)}.wrap{width:min(1120px,calc(100% - 2rem));margin:auto}.report-header{background:#edf5f2;padding:2rem 0 1.75rem}.report-kind{margin:0 0 .65rem;color:var(--accent);font-weight:700}.report-header h1{max-width:24ch;font-size:clamp(1.85rem,4vw,3.1rem);line-height:1.08;letter-spacing:-.025em;margin:0 0 .75rem}.report-description{max-width:72ch;margin:0;color:#35433e;font-size:1.05rem}.hero-grid{display:grid;grid-template-columns:1.3fr 1fr;gap:2rem;align-items:end}.hero-verdicts,.hero-counts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem;margin-top:1.5rem}.hero-fact{background:#fff;padding:.85rem 1rem;border-left:4px solid var(--line)}.hero-fact span{display:block;color:var(--muted);font-size:.85rem}.hero-fact strong{display:block;font-size:1.12rem}.not-claimed{margin:0;background:#fff;padding:1rem;border-left:5px solid var(--warn)}nav{position:sticky;top:0;z-index:1;background:rgba(255,255,255,.97);border-bottom:1px solid var(--line)}nav ul,.facts{display:flex;flex-wrap:wrap;gap:.35rem 1.1rem;padding:.65rem 0;margin:0;list-style:none}nav a{color:var(--accent);font-weight:650;text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:3px solid #74b7a5;outline-offset:3px}main{padding:0 0 4rem}main>section{padding-top:2rem}h2{font-size:1.55rem;line-height:1.2;margin:0 0 .75rem}h3{line-height:1.25}h4{margin-bottom:.3rem}.callout,.warning{border-left:5px solid var(--accent);padding:1rem;background:var(--panel)}.warning{border-left-color:var(--warn);background:#fff8e8}.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.75rem;margin:1.25rem 0}.card{padding:1rem;background:var(--panel);border-top:4px solid var(--line)}.card strong{display:block;font-size:1.15rem}.status{font-size:.85rem}.status-pass{color:var(--pass)}.status-fail{color:var(--fail)}.status-neutral{color:var(--warn)}.help{display:block;color:var(--muted);font-size:.9rem}.section-heading{display:flex;justify-content:space-between;gap:2rem;align-items:start}.section-heading>div{max-width:60ch}.legend{display:grid;grid-template-columns:repeat(2,max-content);gap:.45rem 1rem;list-style:none;padding:0;margin:0;font-size:.86rem}.mark{display:inline-block;width:.7rem;height:.7rem;margin-right:.35rem;border-radius:50%}.declared{background:var(--accent)}.observed{background:var(--observed)}.estimated{background:var(--estimated)}.unknown{background:#7d8582}.flow-figure{margin:1.25rem 0 0;background:var(--panel);padding:1rem}.flow-figure svg{display:block;width:100%;height:auto}.business-row rect,.lifecycle-row rect{fill:#fff;stroke:#aebdb7;stroke-width:1.5}.business-row text,.lifecycle-row text{text-anchor:middle;font-weight:700;fill:var(--ink)}.svg-note{font-size:13px;font-weight:400!important;fill:var(--muted)!important}.business-row path{stroke:var(--accent);stroke-width:2;marker-end:url(#arrow-declared)}.lifecycle-row path{stroke:var(--observed);stroke-width:2;marker-end:url(#arrow-observed)}.edge-label{font-size:12px;font-weight:500!important;fill:var(--accent)!important}.observed-text{fill:var(--observed)!important}.flow-figure figcaption{color:var(--muted);font-size:.9rem}.flow-fallback{background:#fff;border-left:4px solid var(--accent);padding:.8rem 1rem;margin-top:1rem}.flow-fallback h3{margin:.1rem 0}.flow-fallback ol{margin:.5rem 0;padding-left:1.25rem}.read-guide{display:flex;gap:.55rem 1.25rem;flex-wrap:wrap;padding:.8rem 1rem;background:#edf5f2;margin:1rem 0 1.5rem}.operations-heading{margin-top:2.5rem}.operation-phase{margin:2rem 0}.phase-heading{display:flex;align-items:baseline;justify-content:space-between;border-bottom:2px solid var(--accent);margin-bottom:.8rem}.phase-heading h3{margin:0 0 .4rem}.phase-heading span{color:var(--muted);font-size:.9rem}.operation-list{display:grid;gap:.75rem}.operation-card{border:1px solid var(--line);border-left:5px solid var(--accent);padding:1rem 1.1rem;background:#fff}.operation-heading{display:flex;justify-content:space-between;align-items:center}.step-index{color:var(--muted);font-size:.85rem}.operation-card h3{font-size:1.1rem;margin:.3rem 0}.operation-purpose{margin:.2rem 0 .75rem;max-width:76ch}.operation-brief{display:grid;grid-template-columns:1fr 2fr;gap:.4rem 1rem;margin:.6rem 0}.operation-brief>div{display:grid;grid-template-columns:3.2rem 1fr}.operation-brief dt{font-weight:700;color:var(--muted)}.operation-brief dd{margin:0}.evidence-detail,.technical-detail,.sample-detail,.nested-detail{margin-top:.8rem}.evidence-detail>summary,.technical-detail>summary,.sample-detail>summary,.nested-detail>summary{cursor:pointer;color:var(--accent);font-weight:700}.detail-body{padding:.5rem 0}.nested-detail svg{max-width:100%;height:auto}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.93rem}caption{text-align:left;font-weight:700;padding:.5rem 0}th,td{border:1px solid var(--line);padding:.65rem;text-align:left;vertical-align:top}th{background:var(--panel)}code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#f0f3f8;padding:.75rem}.details>div{display:grid;grid-template-columns:minmax(8rem,12rem) 1fr;border-bottom:1px solid var(--line);padding:.45rem}.details dt{font-weight:700}.details dd{margin:0}@media(max-width:760px){.hero-grid{grid-template-columns:1fr}.hero-verdicts,.hero-counts,.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.section-heading{display:block}.legend{margin-top:1rem}.operation-brief{grid-template-columns:1fr}.flow-figure{overflow-x:auto}.flow-figure svg{min-width:700px}}@media(max-width:560px){.wrap{width:min(100% - 1.25rem,1120px)}.report-header{padding-top:1.35rem}.hero-verdicts,.hero-counts,.summary{grid-template-columns:1fr 1fr}.details>div{grid-template-columns:1fr}.details dd{margin-top:.2rem}.legend{grid-template-columns:1fr}.operation-card{padding:.85rem}.operation-brief>div{grid-template-columns:3rem 1fr}nav{position:static}}@media print{nav,.skip{display:none}.wrap{width:100%}body{font-size:11pt}.operation-card{break-inside:avoid}details>.detail-body{display:block!important}}
.business-flow,.lifecycle-flow{margin:1.25rem 0;padding:1.1rem;background:var(--panel)}.business-links{display:flex;gap:.75rem;list-style:none;padding:0;flex-wrap:wrap;margin:.85rem 0 0}.business-links li{background:#fff;padding:.8rem 1rem;flex:1;min-width:250px;border-bottom:3px solid var(--accent)}.business-links strong{font-size:1.05rem}.flow-arrow{display:inline-flex;align-items:center;gap:.4rem;padding:0 .6rem;color:var(--accent);font-weight:700}.flow-arrow small{font-size:.75rem}.lifecycle-strip{display:flex;list-style:none;padding:0;gap:1rem;margin:1rem 0 0;counter-reset:stage}.lifecycle-strip li{position:relative;flex:1;background:#fff;padding:.8rem;border-top:3px solid var(--observed);counter-increment:stage}.lifecycle-strip li:not(:last-child):after{content:"→ 声明";position:absolute;right:-.95rem;top:-1.5rem;font-size:.7rem;color:var(--accent)}.lifecycle-strip strong,.lifecycle-strip span{display:block}.lifecycle-strip span{font-size:.85rem;color:var(--muted)}@media(max-width:760px){.lifecycle-strip{display:grid;grid-template-columns:1fr}.lifecycle-strip li:not(:last-child):after{content:"↓ 声明";top:auto;bottom:-1.1rem;right:1rem}.business-links{display:grid;grid-template-columns:1fr}}
.chart-axis-label{font-size:11px;fill:var(--muted)}.chart-figure svg{overflow:visible}.chart-text-fallback caption{caption-side:top}
.topology-scroll{max-width:100%;overflow-x:auto;margin:.75rem 0}.topology-graph{display:block;width:100%;min-width:620px;height:auto}.topology-graph .chart-label{font-size:16px;fill:var(--ink)}.topology-edge{fill:none;stroke:var(--accent);stroke-width:2;marker-end:url(#topology-arrow)}.topology-edge-key{fill:#fff;stroke:var(--accent);stroke-width:1.5}.chart-note{font-size:13px;font-weight:700;fill:var(--accent)}.relation-table{table-layout:fixed}.relation-table th:first-child{width:12%}.relation-table th:last-child{width:40%}.relation-table th,.relation-table td,.flow-fallback{overflow-wrap:anywhere}.relation-key{display:inline-block;min-width:1.5rem;text-align:center;font-weight:700;color:var(--accent)}@media(max-width:560px){.business-flow{padding:.75rem}.relation-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.relation-table,.relation-table tbody,.relation-table tr,.relation-table td{display:block;width:100%}.relation-table tr{margin:.75rem 0;border:1px solid var(--line);background:#fff}.relation-table td{border:0;padding:.45rem .65rem}.relation-table td[data-label]:before{content:attr(data-label);display:block;font-size:.8rem;font-weight:700;color:var(--muted)}}
@media(max-width:560px){.chart-text-fallback{max-width:100%;overflow-x:auto}.relation-table caption{display:block;width:100%;text-align:left}}
</style>
</head>
<body>
<a class="skip" href="#main">跳到主要内容</a>
<header class="report-header"><div class="wrap hero-grid"><div><p class="report-kind">Teable headless 基准报告 · ${escapeHtml(evidenceLabel[report.evidenceKind])}</p><h1>${report.dataset.name === 'reference-business-operations' ? '从账户到工时：业务操作验证' : escapeHtml(report.scope.title)}</h1><p class="report-description">${report.dataset.name === 'reference-business-operations' ? '在四张关联表上读取预算与成本，新增和修改工作项、清空并恢复关联，删除工时后核对计算结果。' : escapeHtml(report.scope.description)}</p><div class="hero-verdicts"><div class="hero-fact"><span>正确性</span><strong class="${statusClass(report.verdicts.oracle)}">${escapeHtml(verdictLabel[report.verdicts.oracle])}</strong></div><div class="hero-fact"><span>执行状态</span><strong class="${statusClass(report.verdicts.execution)}">${escapeHtml(verdictLabel[report.verdicts.execution])}</strong></div><div class="hero-fact"><span>性能结论</span><strong class="${statusClass(report.verdicts.performance)}">${escapeHtml(verdictLabel[report.verdicts.performance])}</strong></div><div class="hero-fact"><span>业务步骤</span><strong>${impact ? `${impact.steps.length} 步` : '未提供步骤 sidecar'}</strong></div></div></div><div><div class="hero-counts" aria-label="数据规模">${Object.entries(
    report.dataset.rowCounts
  )
    .map(
      ([table, count]) =>
        `<div class="hero-fact"><span>${escapeHtml(table)}</span><strong>${count.toLocaleString('zh-CN')} 行</strong></div>`
    )
    .join(
      ''
    )}</div><p class="not-claimed"><strong>不作出的结论</strong><br>不代表生产 PostgreSQL、HTTP 服务、多用户并发或部署容量；也不代表覆盖全部 Teable 行为。</p></div></div></header>
<nav aria-label="报告章节"><div class="wrap"><ul><li><a href="#summary">结论</a></li>${report.dataset.name === 'reference-business-operations' ? '<li><a href="#workflow">流程图</a></li>' : ''}<li><a href="#correctness">正确性</a></li><li><a href="#performance">操作与性能</a></li><li><a href="#scope">范围</a></li><li><a href="#limitations">局限</a></li><li><a href="#provenance">复现</a></li></ul></div></nav>
<main id="main" class="wrap">
<section id="summary" aria-labelledby="summary-title"><h2 id="summary-title">运行结论</h2><p class="callout"><strong>先看正确性，再单独看性能。</strong>“正确性通过”只说明本报告列出的预期检查通过；不自动表示性能通过，也不代表覆盖全部 Teable 行为。</p>${conclusions ? `<details class="technical-detail"><summary>查看证据支持的结论</summary><div class="detail-body"><ul>${conclusions}</ul></div></details>` : ''}</section>
${renderWorkflow(topology)}
${renderCorrectness(report)}
${renderPerformance(report, impact)}
<section id="scope" aria-labelledby="scope-title"><h2 id="scope-title">测了什么、没有测什么</h2><p>${escapeHtml(report.dataset.name)}：${escapeHtml(report.dataset.description)}</p>${report.dataset.name === 'reference-business-operations' ? '<p class="callout"><strong>业务背景：</strong>这是确定性合成数据，不是客户数据。四张关联表表示账户、账户下的项目、项目内可执行的工作项，以及记录某个工作项实际投入的工时记录。</p>' : ''}<details class="technical-detail"><summary>查看数据规模、纳入范围与明确排除</summary><div class="detail-body"><h3>数据规模</h3><ul>${rowCounts}</ul><h3>纳入范围</h3><ul>${report.scope.included.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul><h3>明确排除</h3>${exclusions ? `<ul>${exclusions}</ul>` : '<p>没有额外排除项；固定的 headless/PGlite 边界仍适用。</p>'}</div></details></section>
${renderCoverage(report)}
${renderLimitations(report)}
<details class="technical-detail"><summary>查看环境、来源与复现</summary><div class="detail-body">${renderProvenance(report)}</div></details>
<section id="appendix" aria-labelledby="appendix-title"><h2 id="appendix-title">技术附录：完整标识符</h2><details class="technical-detail"><summary>查看完整标识符</summary><div class="detail-body"><p>以下完整值用于机器关联和复核，正文不以缩写代替原始标识。</p><div class="table-wrap"><table><caption>报告与执行标识</caption><tbody>${identifierRows}</tbody></table></div></div></details><details class="technical-detail"><summary>查看规范报告原始 JSON</summary><div class="detail-body"><pre><code>${escapeHtml(JSON.stringify(report, null, 2))}</code></pre></div></details></section>
</main>
</body>
</html>\n`;
}
