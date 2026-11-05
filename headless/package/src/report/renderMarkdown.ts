import { sha256Hex } from '../case/canonicalJson';
import { parseTeaBenchReport, type ReportMetric, type TeaBenchReport } from './schema';

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  ['<']: '&lt;',
  ['>']: '&gt;',
  ['&']: '&amp;',
};

const escapeMarkdown = (value: string): string =>
  value
    .replaceAll('\\', '\\\\')
    .replace(/[<>&]/g, (character) => HTML_ESCAPES[character]!)
    .replace(/([`*_{}[\]()#+.!|-])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ');

const formatMetric = (metric: ReportMetric): string =>
  metric.value === null
    ? `缺失（${escapeMarkdown(metric.missingReason)}）`
    : `${metric.value.toLocaleString('zh-CN', { maximumFractionDigits: 4, useGrouping: false })} ${metric.unit}`;

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

const gapKindLabel = {
  ['not-applicable']: '不适用',
  unsupported: '不支持',
  skipped: '跳过',
  ['not-planned']: '未纳入计划',
  ['not-executed']: '未执行',
} as const;

const environmentStatusLabel = {
  compatible: '兼容',
  incompatible: '不兼容',
  unknown: '未知',
} as const;

const confidenceLabel = { high: '高', medium: '中', low: '低' } as const;

const methodLabel: Readonly<Record<string, string>> = {
  ['exact-json']: '精确 JSON 比对',
  ['normalized-exact-json']: '规范化 JSON 精确比对',
  ['exact-row-count']: '精确行数比对',
  ['row-count']: '行数比对',
  ['exact-field-values']: '精确字段值比对',
  ['set-uniqueness']: '集合唯一性检查',
  ['exact-link-count']: '精确关联数量比对',
  ['computed-non-null-scan']: '计算字段非空扫描',
  ['full-recompute-at-sequence-position']: '指定顺序位置完整重算比对',
  ['fresh-runtime-full-recompute']: '全新运行时完整重算比对',
  ['exact-record-id-sequence']: '记录 ID 顺序精确比对',
  ['expected-domain-error-and-unchanged-state']: '预期领域错误与状态不变检查',
  ['legacy-unknown']: '旧版未知方法',
};

const formatMethod = (method: string): string =>
  escapeMarkdown(methodLabel[method] ?? '自定义检查方法');

const shortId = (value: string): string => {
  const visibleCharacters = 12;
  return value.length <= visibleCharacters
    ? escapeMarkdown(value)
    : `${escapeMarkdown(value.slice(0, visibleCharacters))}…`;
};

const formatRawIdentifier = (value: string): string =>
  `<code>${value.replace(/[<>&]/g, (character) => HTML_ESCAPES[character]!)}</code>`;

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const stringifyJson = (value: unknown): string => escapeMarkdown(JSON.stringify(value));
const summarizeJson = (value: unknown): string => {
  if (!Array.isArray(value)) return stringifyJson(value);
  const hash = sha256Hex(JSON.stringify(value));
  const firstThree = value
    .slice(0, 3)
    .map((item) => JSON.stringify(item))
    .join('、');
  return `数组[${value.length} 项；前 3 项：${firstThree || '无'}；SHA-256 ${hash.slice(0, 16)}…]`;
};

const renderReceiptDimension = (
  title: string,
  dimension: TeaBenchReport['catalogue']['suiteReceipts'][number]['rules']
): string[] => {
  const lines = [`- ${title}：计划 ${dimension.plannedCount}，执行 ${dimension.executedCount}`];
  for (const receipt of dimension.receipts) {
    const status = verdictLabel[receipt.status];
    const reason = receipt.reason ? `；原因：${escapeMarkdown(receipt.reason)}` : '';
    lines.push(
      `  - ${escapeMarkdown(receipt.id)}：计划=${receipt.planned ? '是' : '否'}，执行=${receipt.executed ? '是' : '否'}，状态=${status}${reason}`
    );
  }
  return lines;
};

const renderComparison = (report: TeaBenchReport): string[] => {
  if (report.comparison === null) return ['未提供基线，因此没有性能比较结论。'];
  const comparison = report.comparison;
  const lines = [
    `- 基线场景目录 ID：${shortId(comparison.baselineIds.catalogueId)}`,
    `- 基线场景 ID：${shortId(comparison.baselineIds.scenarioId)}`,
    `- 基线执行 ID：${shortId(comparison.baselineIds.executionId)}`,
    `- 环境兼容性：${environmentStatusLabel[comparison.environmentCompatibility.status]}`,
    `- 性能判定：${verdictLabel[comparison.verdict]}`,
  ];
  for (const operation of comparison.operations) {
    lines.push(
      `- ${shortId(operation.operationId)}：比率 ${formatMetric(operation.ratio)}，置信区间 [${formatMetric(operation.ciLow)}, ${formatMetric(operation.ciHigh)}]，判定 ${verdictLabel[operation.verdict]}${operation.reason ? `；${escapeMarkdown(operation.reason)}` : ''}`
    );
  }
  if (comparison.environmentCompatibility.differences.length > 0) {
    lines.push(
      `- 环境差异：${comparison.environmentCompatibility.differences.map(escapeMarkdown).join('；')}`
    );
  }
  return lines;
};

export function renderTeaBenchReportMarkdown(input: unknown): string {
  const report = parseTeaBenchReport(input);
  const slowest = report.executions
    .flatMap((execution) =>
      execution.operations.map((operation) => ({
        ...operation,
        executionId: execution.executionId,
      }))
    )
    .filter((operation) => operation.statistics.p95.value !== null)
    .toSorted((left, right) => (right.statistics.p95.value ?? 0) - (left.statistics.p95.value ?? 0))
    .slice(0, 10);
  const lines: string[] = [
    `# ${escapeMarkdown(report.scope.title)}`,
    '',
    '> 本报告明确区分数据来源与证据类型；结论仅覆盖下列范围。',
    '',
    '## 如何阅读这份报告',
    '',
    '1. 先看“正确性判定”：只代表列出的检查是否符合预期，不等于覆盖全部 Teable 行为。',
    '2. 再看“范围、数据与运行环境”和“覆盖与缺口”：确认测的是哪份合成数据、哪些操作，哪些没有测。',
    '3. 最后单独看性能：少量样本只用来确认流程跑通，不是性能通过或生产容量证明。JSON 是原始证据；Markdown、HTML 和 Teable 行导出只是同一证据的不同视图。',
    '',
    '## 执行摘要',
    '',
    `- 正确性判定：${verdictLabel[report.verdicts.oracle]}`,
    `- 证据类型：${report.evidenceKind === 'observed' ? '实测' : report.evidenceKind === 'deterministic-test-data' ? '确定性测试数据' : '历史迁移，细节未知'}`,
    `- 执行状态：${verdictLabel[report.verdicts.execution]}`,
    `- 性能判定：${verdictLabel[report.verdicts.performance]}`,
    `- 场景目录：${shortId(report.ids.catalogueId)}`,
    `- 当前场景：${shortId(report.ids.scenarioId)}`,
    `- 本次执行：${shortId(report.ids.executionId)}`,
    '',
  ];

  for (const conclusion of report.conclusions) {
    lines.push(
      `- ${escapeMarkdown(conclusion.statement)}（置信度：${confidenceLabel[conclusion.confidence]}；证据：${conclusion.evidenceRefs.map(shortId).join('、')}）`
    );
  }

  lines.push(
    '',
    '## 范围、数据与运行环境',
    '',
    escapeMarkdown(report.scope.description),
    '',
    `- 纳入：${report.scope.included.map(escapeMarkdown).join('；')}`,
    `- 完整场景目录：${report.scope.registry.scenarioIds.length} 个场景（详细 ID 见附录）`,
    `- 本次配置：${escapeMarkdown(report.scope.configured.description)}`,
    `- 数据集：${escapeMarkdown(report.dataset.name)}；${escapeMarkdown(report.dataset.description)}`,
    `- 行数：${Object.entries(report.dataset.rowCounts)
      .map(([table, count]) => `${escapeMarkdown(table)}=${count}`)
      .join('；')}`,
    `- 后端：${report.provenance.backend.kind === 'pglite' ? '进程内 PostgreSQL（PGlite）' : 'PostgreSQL'} ${escapeMarkdown(report.provenance.backend.version)}`,
    `- PostgreSQL：${report.provenance.postgres ? escapeMarkdown(report.provenance.postgres.version) : '未采集 / 不适用'}`,
    `- 主机：${escapeMarkdown(report.provenance.host.os)} / ${escapeMarkdown(report.provenance.host.arch)} / ${escapeMarkdown(report.provenance.host.cpu)}`,
    `- 提交：${report.provenance.commit.sha === null ? `未知（${escapeMarkdown(report.provenance.commit.shaMissingReason ?? '未说明')}）` : escapeMarkdown(report.provenance.commit.sha)}；工作区${report.provenance.commit.dirty === true ? '有未提交修改' : report.provenance.commit.dirty === false ? '干净' : `状态未知（${escapeMarkdown(report.provenance.commit.dirtyReason ?? '未说明')}）`}`,
    `- 运行时间：${escapeMarkdown(report.runtime.startedAt)} 至 ${escapeMarkdown(report.runtime.completedAt)}（${report.runtime.durationMs} ms）`,
    `- 计算语义：${escapeMarkdown(report.runtime.description)}`,
    ''
  );

  if (report.scope.exclusions.length > 0) {
    lines.push('### 排除项', '');
    for (const exclusion of report.scope.exclusions) {
      lines.push(`- ${escapeMarkdown(exclusion.subject)}：${escapeMarkdown(exclusion.reason)}`);
    }
    lines.push('');
  }

  const coverageDimensionTotals = (['rules', 'sources', 'edges'] as const).map((dimension) => ({
    dimension,
    planned: report.catalogue.suiteReceipts.reduce(
      (total, receipt) => total + receipt[dimension].plannedCount,
      0
    ),
    executed: report.catalogue.suiteReceipts.reduce(
      (total, receipt) => total + receipt[dimension].executedCount,
      0
    ),
  }));
  const dimensionLabels = { rules: '规则', sources: '来源', edges: '边' } as const;
  lines.push(
    '## 覆盖与缺口',
    '',
    `- 请求 ${report.catalogue.requested}；适用 ${report.catalogue.applicable}；计划 ${report.catalogue.planned}；执行 ${report.catalogue.executed}`,
    `- 通过 ${report.catalogue.pass}；失败 ${report.catalogue.fail}；跳过 ${report.catalogue.skipped}；不支持 ${report.catalogue.unsupported}`,
    ...coverageDimensionTotals.map(
      ({ dimension, planned, executed }) =>
        `- ${dimensionLabels[dimension]}：计划 ${planned}，执行 ${executed}`
    ),
    '- 汇总由测试批次证据记录合并派生，不是独立填写的覆盖声明。',
    ''
  );
  if (report.catalogue.gaps.length > 0) {
    lines.push('### 缺口汇总', '');
    const gapCounts = new Map<keyof typeof gapKindLabel, number>();
    for (const gap of report.catalogue.gaps) {
      gapCounts.set(gap.kind, (gapCounts.get(gap.kind) ?? 0) + 1);
    }
    for (const [kind, count] of gapCounts) {
      lines.push(`- ${gapKindLabel[kind]}：${count} 个场景`);
    }
    lines.push('- 各场景的完整 ID 与原因见“详细证据附录”。', '');
  }

  lines.push('## 基线比较', '', ...renderComparison(report), '', '## 最慢操作', '');
  if (slowest.length === 0) {
    lines.push('没有可用的 p95 原始样本统计。');
  } else {
    lines.push(
      '| 执行 / 场景 | 顺序 | 操作 | 阶段 | p95 | 尝试 / 成功 / 错误 |',
      '| --- | ---: | --- | --- | ---: | ---: |'
    );
    for (const operation of slowest) {
      const owner = report.executions.find(
        (execution) => execution.executionId === operation.executionId
      )!;
      lines.push(
        `| ${shortId(operation.executionId)} / ${shortId(owner.scenarioId)} | ${operation.order} | ${escapeMarkdown(operation.title)} | ${operation.phase} | ${formatMetric(operation.statistics.p95)} | ${operation.attempted} / ${operation.success} / ${operation.errors} |`
      );
    }
  }

  lines.push('', '## 实际阶段与操作顺序', '');
  lines.push(
    '读表提示：query-core 是基础记录读取；query-structured 是结构化条件查询；write-create/update/delete 分别是新增、修改、删除记录；flush-computed 是等待剩余公式、查找与汇总计算完成。写入确认可能已包含部分同步计算，排空耗时不能单独代表全部计算成本。',
    ''
  );
  for (const event of report.runtime.phaseEvents) {
    lines.push(
      `- ${event.order}. ${shortId(event.executionId)} / ${event.kind}${event.operationId ? ` / ${shortId(event.operationId)}` : ''}：${escapeMarkdown(event.description)}`
    );
  }

  lines.push('', '## 正确性', '');
  for (const execution of report.executions) {
    lines.push(
      `### 本次执行 ${shortId(execution.executionId)}（场景=${shortId(execution.scenarioId)}；物化 case=${shortId(execution.caseId)}；运行=${shortId(execution.runId)}）`,
      '',
      `- 正确性=${verdictLabel[execution.verdicts.oracle]}；执行=${verdictLabel[execution.verdicts.execution]}；性能=${verdictLabel[execution.verdicts.performance]}`
    );
    if (execution.correctness.length === 0) lines.push('没有正确性检查记录。');
    for (const check of execution.correctness) {
      lines.push(
        `- ${escapeMarkdown(check.description)}：${verdictLabel[check.status]}；方法=${formatMethod(check.method)}；期望=${summarizeJson(check.expected)}；实际=${summarizeJson(check.actual)}；容差=${summarizeJson(check.tolerance)}${check.unknownReason ? `；未知原因=${escapeMarkdown(check.unknownReason)}` : ''}`
      );
    }
  }

  lines.push(
    '',
    '## 方法',
    '',
    `- 百分位：最近秩百分位；公式：${escapeMarkdown(report.methods.percentiles.formula)}；不平均百分位。`,
    '- 分位数是数学描述，不等于统计保证。p95 至少需要 20 个独立样本、p99 至少需要 100 个，最近秩才可能低于最大样本；达到该分辨率也不保证尾部稳定或置信度。低于分辨率时性能证据不足，不可判性能通过。',
    '- 本报告的独立性能 SLO 只针对 p95；p99 始终是描述性估计，不参与性能通过判定。p99 达到 100 个样本也不表示获得独立置信保证。',
    ...(report.methods.pairedBootstrap === null
      ? [
          `- 未执行配对 Bootstrap：${escapeMarkdown(report.methods.pairedBootstrapMissingReason ?? '未说明')}`,
        ]
      : [
          `- 配对 Bootstrap：按 ${escapeMarkdown(report.methods.pairedBootstrap.pairBy)} 配对，${report.methods.pairedBootstrap.iterations} 次，种子 ${report.methods.pairedBootstrap.seed}。`,
          `- Bootstrap 公式：${escapeMarkdown(report.methods.pairedBootstrap.formula)}`,
          `- 置信区间：${report.methods.pairedBootstrap.confidenceInterval.level}；分位数 ${report.methods.pairedBootstrap.confidenceInterval.lowerQuantile} / ${report.methods.pairedBootstrap.confidenceInterval.upperQuantile}`,
          `- 阈值：${report.methods.pairedBootstrap.threshold.regressionRatio}；${escapeMarkdown(report.methods.pairedBootstrap.threshold.formula)}；${escapeMarkdown(report.methods.pairedBootstrap.threshold.rule)}`,
        ]),
    `- 假设：${[...report.methods.percentiles.assumptions, ...(report.methods.pairedBootstrap?.assumptions ?? [])].map(escapeMarkdown).join('；')}`,
    '',
    '### 中文术语说明',
    '',
    '- 最近秩百分位（nearest-rank）：样本排序后，直接取 `ceil(p × n)` 对应的观测值，不在相邻值之间平均。',
    '- 进程内 PostgreSQL（PGlite）：在当前进程内运行、用于本地基准的 PostgreSQL 兼容数据库。',
    '- 完整重算（full-recompute）：增量路径与重建路径共享同一 Teable 计算引擎；只证明两条执行路径的状态一致，不是独立公式语义 oracle。',
    '- 混合内联与排空（hybrid inline/flush）：写入时包含同步内联计算，之后再显式排空剩余异步计算。',
    '- 排空（flush）：等待尚未完成的计算任务处理完毕；其耗时只代表剩余异步工作。',
    '- 测试批次证据记录（suite receipt）：某个测试批次对一个场景的适用性、计划、执行状态及规则/来源/边覆盖证据。',
    '',
    '## 局限与警告',
    ''
  );
  lines.push(
    '',
    '### 各操作分位数分辨率',
    '',
    '| 操作 | 成功样本 | p95（至少 20） | p99（至少 100；仅描述） |',
    '| --- | ---: | --- | --- |'
  );
  for (const execution of report.executions) {
    for (const operation of execution.operations) {
      const count = operation.rawSamples.values.length;
      lines.push(
        `| ${escapeMarkdown(operation.title)} | ${count} | ${count < 20 ? '未达到分辨率，证据不足' : '达到最低分辨率，仍非置信保证'} | ${count < 100 ? '未达到分辨率，仅数学估计' : '达到最低分辨率，仅描述性估计'} |`
      );
    }
  }
  const limitations = [
    ...report.limitations,
    ...(report.comparison?.limitations ?? []),
    ...report.conclusions.flatMap((conclusion) => conclusion.limitations),
  ];
  for (const limitation of limitations) lines.push(`- 局限：${escapeMarkdown(limitation)}`);
  const percentileWarningHelp = (code: string): string | undefined => {
    switch (code) {
      case 'bench.workload.p95_evidence_low':
        return 'p95 少于 20 个成功样本，最近秩仍落在最大值，不能作为 p95 证据。';
      case 'bench.workload.p99_evidence_low':
        return 'p99 少于 100 个成功样本，仅为描述性数学估计，不参与性能判定。';
      default:
        return undefined;
    }
  };
  for (const warning of report.warnings) {
    lines.push(
      `- ${warning.severity} / ${escapeMarkdown(warning.code)}：${escapeMarkdown(percentileWarningHelp(warning.code) ?? warning.message)}`
    );
  }
  if (limitations.length === 0 && report.warnings.length === 0) lines.push('- 无已记录项。');

  lines.push('', '## 复现命令与产物', '');
  for (const command of report.provenance.reproducibility.commands) {
    lines.push(
      `- ${escapeMarkdown(command.label)}${command.cwd ? `（工作目录：${escapeMarkdown(command.cwd)}）` : ''}：${escapeMarkdown(command.argv.map(shellQuote).join(' '))}`
    );
  }
  for (const artifact of report.executions.flatMap((execution) => execution.artifacts)) {
    lines.push(
      `- ${escapeMarkdown(artifact.kind)}：${escapeMarkdown(artifact.path)}；SHA-256=${artifact.sha256}${artifact.bytes == null ? '' : `；${artifact.bytes} bytes`}`
    );
  }
  lines.push(
    `- 数据哈希：${report.provenance.dataHash ?? `未知（${escapeMarkdown(report.provenance.hashMissingReason ?? '未说明')}）`}`,
    `- 测试数据哈希：${report.provenance.fixtureHash ?? `未知（${escapeMarkdown(report.provenance.hashMissingReason ?? '未说明')}）`}`,
    ''
  );
  lines.push(
    '## 详细证据附录',
    '',
    '### 完整标识符',
    '',
    `- 完整场景目录 ID：${formatRawIdentifier(report.ids.catalogueId)}`,
    `- 完整场景 ID：${formatRawIdentifier(report.ids.scenarioId)}`,
    `- 完整执行 ID：${formatRawIdentifier(report.ids.executionId)}`,
    '- 完整场景目录 ID 列表：'
  );
  for (const scenarioId of report.scope.registry.scenarioIds) {
    lines.push(`  - ${formatRawIdentifier(scenarioId)}`);
  }

  lines.push('', '### 测试批次与缺口明细', '');
  for (const receipt of report.catalogue.suiteReceipts) {
    lines.push(
      `#### 测试批次 ${formatRawIdentifier(receipt.suiteId)} / 场景 ${formatRawIdentifier(receipt.scenarioId)}`,
      '',
      `- 证据记录：${formatRawIdentifier(receipt.receiptId)}`,
      `- 适用=${receipt.applicable ? '是' : '否'}；计划=${receipt.planned ? '是' : '否'}；执行=${verdictLabel[receipt.execution]}`,
      `- 执行引用：${receipt.executionRef === null ? '无（未执行）' : `完整执行 ID ${formatRawIdentifier(receipt.executionRef.executionId)} / 完整运行 ID ${formatRawIdentifier(receipt.executionRef.runId)}`}`
    );
    if (receipt.reason) lines.push(`- 说明：${escapeMarkdown(receipt.reason)}`);
    lines.push(...renderReceiptDimension('规则', receipt.rules));
    lines.push(...renderReceiptDimension('来源', receipt.sources));
    lines.push(...renderReceiptDimension('边', receipt.edges), '');
  }
  for (const gap of report.catalogue.gaps) {
    lines.push(
      `- 缺口：${gap.scenarioId ? `场景 ${formatRawIdentifier(gap.scenarioId)}；` : ''}${gapKindLabel[gap.kind]}；${escapeMarkdown(gap.reason)}`
    );
  }

  lines.push('', '### 执行与正确性方法明细', '');
  for (const execution of report.executions) {
    lines.push(
      `#### 完整执行 ID：${formatRawIdentifier(execution.executionId)}`,
      '',
      `- 完整场景 ID：${formatRawIdentifier(execution.scenarioId)}`,
      `- 完整物化 case ID：${formatRawIdentifier(execution.caseId)}`,
      `- 完整运行 ID：${formatRawIdentifier(execution.runId)}`
    );
    for (const check of execution.correctness) {
      lines.push(
        `- ${escapeMarkdown(check.description)}：${formatMethod(check.method)}；原始方法名：${formatRawIdentifier(check.method)}`
      );
    }
    lines.push('');
  }
  lines.push(
    '### 统计方法原始标识符',
    '',
    `- 百分位方法：最近秩百分位；原始方法名：${formatRawIdentifier(report.methods.percentiles.method)}`,
    ...(report.methods.pairedBootstrap === null
      ? []
      : [
          `- 性能比较方法：配对 Bootstrap；原始方法名：${formatRawIdentifier(report.methods.pairedBootstrap.method)}`,
        ]),
    ''
  );

  if (report.comparison !== null) {
    lines.push(
      '### 基线完整标识符',
      '',
      `- 完整基线场景目录 ID：${formatRawIdentifier(report.comparison.baselineIds.catalogueId)}`,
      `- 完整基线场景 ID：${formatRawIdentifier(report.comparison.baselineIds.scenarioId)}`,
      `- 完整基线执行 ID：${formatRawIdentifier(report.comparison.baselineIds.executionId)}`,
      ''
    );
  }

  return lines.join('\n');
}
