import type { OperationImpactGraph } from './schema';

const evidenceLabel = {
  declared: '声明',
  estimated: '估计',
  observed: '观察',
  unknown: '未知',
} as const;
const escapeHtml = (value: unknown): string =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const statusLabel: Readonly<Record<string, string>> = {
  pass: '通过',
  fail: '失败',
  unknown: '未知',
  inconclusive: '证据不足',
  skipped: '跳过',
  unsupported: '不支持',
  ['not-run']: '未运行',
  ['not-executed']: '未执行',
  ['not-compared']: '未比较',
};

const compactSentence = (value: string, limit: number, detailHint: string): string => {
  const text = value.replace(/\s+/g, ' ').trim();
  const sentence = text.match(/^[^。！？]*[。！？]?/)?.[0] ?? text;
  if (sentence.length === text.length && sentence.length <= limit) return sentence;
  return `${sentence.slice(0, limit - detailHint.length - 1).replace(/[。！？；，\s]+$/, '')}…${detailHint}`;
};

// eslint-disable-next-line sonarjs/cognitive-complexity -- keeps all impact evidence in one escaped card
export function renderOperationExplanationCard(
  graph: OperationImpactGraph,
  options: { status?: string; stepNumber?: number; stepOrder?: number } = {}
): string {
  const explanation = graph.explanation;
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const relationships = graph.edges.filter(
    (edge) => edge.evidence === 'estimated' || edge.relation.startsWith('declared-')
  );
  const relationshipRows = relationships
    .map(
      (edge) =>
        `<tr><td>${escapeHtml(labels.get(edge.from) ?? edge.from)}</td><td>→</td><td>${escapeHtml(labels.get(edge.to) ?? edge.to)}</td><td>${evidenceLabel[edge.evidence]}</td><td>${escapeHtml(edge.description)}</td></tr>`
    )
    .join('');
  const svgRelationships = relationships
    .filter((edge) => edge.relation.includes('dependency') || edge.evidence === 'estimated')
    .slice(0, 6);
  const svg = svgRelationships.length
    ? `<details class="nested-detail"><summary>可选关系图（声明/估计，不是实际变化图）</summary><svg viewBox="0 0 900 ${svgRelationships.length * 70 + 24}" role="img" aria-label="${escapeHtml(explanation.title)} 的声明或估计关系"><title>${escapeHtml(explanation.title)} 的字段关系</title>${svgRelationships
        .map((edge, index) => {
          const y = 20 + index * 70;
          return `<g><rect x="10" y="${y}" width="350" height="45" rx="4" fill="#e8f2ef" stroke="#526079"></rect><text x="20" y="${y + 28}" fill="#172033">${escapeHtml(labels.get(edge.from) ?? edge.from)}</text><path d="M 365 ${y + 22} L 520 ${y + 22}" stroke="#526079" fill="none"></path><text x="385" y="${y + 15}" fill="#526079">${evidenceLabel[edge.evidence]} →</text><rect x="525" y="${y}" width="365" height="45" rx="4" fill="#f5f7fb" stroke="#526079"></rect><text x="535" y="${y + 28}" fill="#172033">${escapeHtml(labels.get(edge.to) ?? edge.to)}</text></g>`;
        })
        .join('')}</svg></details>`
    : '<p>没有可展示的字段传播关系；不能据此推断没有运行时工作。</p>';
  const readableReference = (value: string): string => {
    let text = value;
    for (const node of graph.nodes) {
      const id =
        node.kind === 'table' ? node.tableId : node.kind === 'field' ? node.fieldId : undefined;
      if (id) text = text.replaceAll(id, node.label);
    }
    return text
      .replace(/\btbl[A-Za-z0-9]+\b/g, '相关表')
      .replace(/\bfld[A-Za-z0-9]+\b/g, '相关字段')
      .replace(/\brec[A-Za-z0-9]+\b/g, '目标记录');
  };
  const sourceText = explanation.sources.length
    ? explanation.sources
        .map((source) => `${source.table}${source.field ? ` / ${source.field}` : ''}`)
        .join('；')
    : '计算运行时队列';
  const target = escapeHtml(readableReference(sourceText));
  const purpose = compactSentence(readableReference(explanation.action), 160, '（完整说明见详情）');
  const transition = explanation.valueTransition;
  const usefulTransition = !/未声明|没有被观察|不声明|更新规则|正确性步骤/.test(transition);
  const expectedDescription = usefulTransition
    ? transition
    : (explanation.expected[0]?.description.replace(
        '执行 manifest 中声明的操作；没有直接绑定的独立正确性检查。',
        '完成 manifest 声明的操作。'
      ) ?? '完成 manifest 声明的操作');
  const payloadStart =
    ['[', '{'].map((token) => expectedDescription.indexOf(token)).find((index) => index >= 0) ?? -1;
  const expectedText =
    payloadStart < 0 ? expectedDescription : expectedDescription.slice(0, payloadStart);
  const expected = compactSentence(
    readableReference(expectedText.trim() || '核对声明的预期结果') +
      (payloadStart < 0 ? '' : '（完整预期见详情）'),
    140,
    '（完整预期见详情）'
  );
  const checks = explanation.actual.filter((item) => item.status !== undefined);
  const checkStatus = checks.some((item) => item.status === 'fail')
    ? 'fail'
    : checks.length > 0 && checks.every((item) => item.status === 'pass')
      ? 'pass'
      : 'unknown';
  const status = options.status ?? checkStatus;
  const observed =
    checks.length > 0
      ? checks.every((item) => item.evidence === 'observed')
      : explanation.actual.some((item) => item.evidence === 'observed');
  const verdictKind = checks.length > 0 ? '正确性' : '执行';
  const stepNumber = options.stepNumber ?? graph.order + 1;
  return `<article class="operation-card" data-step-order="${options.stepOrder ?? graph.order}" aria-labelledby="operation-card-${graph.order}"><div class="operation-heading"><span class="step-index">步骤 ${stepNumber}</span><strong class="status ${status === 'pass' ? 'status-pass' : status === 'fail' ? 'status-fail' : 'status-neutral'}">${verdictKind}（${observed ? '观察' : '未知'}）：${escapeHtml(statusLabel[status] ?? '未知')}</strong></div><h3 id="operation-card-${graph.order}">${escapeHtml(explanation.title)}</h3><p class="operation-purpose">${escapeHtml(purpose)}</p><dl class="operation-brief"><div><dt>目标</dt><dd>${target}</dd></div><div><dt>预期</dt><dd>${escapeHtml(expected)}</dd></div></dl><details class="evidence-detail"><summary>展开完整关系与凭据</summary><div class="detail-body"><p class="help">原始操作键：<code>${escapeHtml(graph.key)}</code>；operationId：<code>${escapeHtml(graph.operationId)}</code>；executionId：<code>${escapeHtml(graph.executionId)}</code>；状态：<code>${escapeHtml(status)}</code></p><h4>原始上下文</h4><p>${escapeHtml(explanation.context)}</p><h4>1. 正在读取或修改什么（声明）</h4><p>${escapeHtml(explanation.action)}</p><p>来源：${escapeHtml(sourceText)}。</p><p>${escapeHtml(explanation.selection)}</p><p>${escapeHtml(explanation.valueTransition)}</p><h4>2. 关系流向</h4><p>完整性：${escapeHtml(graph.completeness)}。箭头只表达声明或估计，不能推出实际影响的记录数或单元格数。</p>${relationshipRows ? `<div class="table-wrap"><table><caption>源表/字段 → 关联或派生表/字段</caption><thead><tr><th scope="col">来源</th><th scope="col">方向</th><th scope="col">目标</th><th scope="col">证据</th><th scope="col">解释</th></tr></thead><tbody>${relationshipRows}</tbody></table></div>` : '<p>没有已声明或估计的关系路径。</p>'}${svg}<h4>3. 预期结果（manifest 声明）</h4><ul>${explanation.expected.map((item) => `<li>${evidenceLabel[item.evidence]}：${escapeHtml(item.description)}</li>`).join('')}</ul><h4>4. 实际凭据（runner 确定性代码）</h4><ul>${explanation.actual.map((item) => `<li>${evidenceLabel[item.evidence]}：${escapeHtml(item.description)}${item.checkId ? ` <code>${escapeHtml(item.checkId)}</code>` : ''}${item.status ? `；状态：<code>${escapeHtml(item.status)}</code>` : ''}${item.method ? `；方法：<code>${escapeHtml(item.method)}</code>` : ''}</li>`).join('')}</ul><h4>5. 没有观察、不能声称什么</h4><ul>${[...explanation.notObserved, ...graph.notes].map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul></div></details></article>`;
}
