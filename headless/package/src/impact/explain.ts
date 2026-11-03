import type { BenchCaseManifest, BenchWorkloadStep } from '../case/manifest';
import type { BenchOracleCheckReceipt } from '../oracle/types';
import type { BenchRunReport } from '../runner/BenchRunner';
import { operationIntent } from './intent';
import type { OperationImpactGraph } from './schema';

export type OperationExplanation = OperationImpactGraph['explanation'];

const referenceTitles: Readonly<Record<string, string>> = {
  ['query-project-budget']: '查询项目预算与预算储备金',
  ['query-time-cost']: '查询工时记录与成本',
  ['create-work-items']: '新增两个工作项',
  ['update-work-estimate']: '修改工作项的预估工时',
  ['query-updated-work']: '核对修改后的预估工时与计划投入',
  ['clear-time-membership']: '清空一个工作项关联的工时记录',
  ['query-cleared-membership']: '核对清空关联后的汇总工时',
  ['restore-time-membership']: '恢复一个工作项的三条工时关联',
  ['query-restored-membership']: '核对恢复关联后的汇总工时',
  ['clear-account-active']: '清空全部账户的启用状态',
  ['restore-account-active']: '把全部账户恢复为启用',
  ['cycle-project-status']: '轮换四个项目的业务状态',
  ['delete-time-entry']: '删除一条工时记录',
  ['flush-after-create']: '等待新增工作项后的计算完成',
  ['flush-after-estimate']: '等待预估工时公式更新完成',
  ['flush-after-clear-membership']: '等待清空关联后的汇总更新完成',
  ['flush-after-restore-membership']: '等待恢复关联后的汇总更新完成',
  ['flush-after-clear-active']: '等待账户状态清空处理完成',
  ['flush-after-restore-active']: '等待账户启用状态恢复完成',
  ['flush-after-project-status']: '等待项目状态变更处理完成',
  ['flush-after-rejected-budget']: '等待无效预算被拒绝后的剩余计算完成',
  ['flush-after-delete']: '等待删除工时记录后的计算完成',
};

const referenceTransitions: Readonly<Record<string, string>> = {
  ['update-work-estimate']: '声明将预估工时从配方的 8 改为 10；计划投入公式预期从 16 变为 20。',
  ['clear-time-membership']: '声明移除首个工作项的全部工时关联；汇总工时预期从 6 变为 0。',
  ['restore-time-membership']: '声明关联三条工时记录；汇总工时预期从 0 恢复为 6。',
  ['clear-account-active']: '声明把 Active 清空为 null；执行前逐行值没有额外采样。',
  ['restore-account-active']:
    '声明把 20 条 Accounts.Active 从前一步的 null 恢复为 true。null 不等于 false；此 schema 没有声明 Active 的下游计算依赖。检查链：restore-account-active → flush-after-restore-active → reference/restore-active。',
  ['cycle-project-status']: '声明按 Active / Complete 轮换四个项目；未额外读取各行的旧状态。',
  ['flush-after-rejected-budget']:
    '前置正确性步骤声明向 Budget 提交无效字符串并期待拒绝；该拒绝不是一个测量操作。',
};

const kindTitles: Readonly<Record<string, string>> = {
  ['query-core']: '读取记录',
  ['query-structured']: '执行结构化查询',
  ['write-create']: '新增记录',
  ['write-update']: '修改记录',
  ['write-delete']: '删除记录',
  ['flush-computed']: '等待剩余计算完成',
};

const checkDescription = (check: BenchOracleCheckReceipt): string => {
  const description = check.description ?? check.key;
  if (description.startsWith('row-count ')) return `核对 ${check.table ?? '相关表'} 的记录数`;
  if (description.startsWith('unique-primary '))
    return `核对 ${check.table ?? '相关表'} 的主字段非空且唯一`;
  if (description.startsWith('link-count ')) return `核对 ${check.table ?? '相关表'} 的关联数量`;
  if (description.startsWith('computed-not-null '))
    return `核对 ${check.table ?? '相关表'} 的计算结果没有空值`;
  return description;
};

// Receipt assembly keeps declared expectations and runner observations visibly separated.
// eslint-disable-next-line sonarjs/cognitive-complexity
export function explainOperation(input: {
  readonly step: BenchWorkloadStep;
  readonly manifest: BenchCaseManifest;
  readonly run: BenchRunReport;
  readonly checks: ReadonlyArray<BenchOracleCheckReceipt>;
}): OperationExplanation {
  const { step, manifest, run, checks } = input;
  const isReference = manifest.title === 'reference-business-operations';
  const table = 'table' in step ? step.table : null;
  const field = 'field' in step ? step.field : null;
  const intent = operationIntent(step, isReference);

  const runOperation = run.operations.find((operation) => operation.key === step.key);
  const actual: OperationExplanation['actual'][number][] = [
    {
      evidence: runOperation ? 'observed' : 'unknown',
      description: runOperation
        ? `成功样本 ${runOperation.count}；错误 ${runOperation.errors}；返回记录累计 ${runOperation.rowsReturned}；命令写入目标累计 ${runOperation.rowsWritten}。这些计数不是计算单元格变化数。`
        : '没有此操作的 runner 测量收据。',
    },
  ];
  if (step.kind === 'flush-computed' && runOperation) {
    actual.push({
      evidence: 'observed',
      description: `processed=${runOperation.processed}，单位是任务，不是记录。`,
    });
  }
  if (runOperation?.observation && runOperation.observation.recordRelation !== 'none') {
    actual.push({
      evidence: 'observed',
      description: `保留 ${runOperation.observation.recordIds.length} 个去重的${runOperation.observation.recordRelation === 'returned' ? '返回' : '命令目标'}记录 ID${runOperation.observation.truncated ? '（达到 100 个的收集上限，已截断）' : ''}；字段名：${runOperation.observation.fieldNames.join('、') || '没有持久化字段名'}。ID 只表示目标/返回关系。`,
    });
  }
  for (const check of checks) {
    actual.push({
      evidence: 'observed',
      description: `${checkDescription(check)}：${check.status}；这是 runner 代码比较 manifest 期望与实际数据的结果，不是 AI 判断。`,
      ...(check.checkId ? { checkId: check.checkId } : {}),
      method: check.method,
      status: check.status,
    });
  }
  return {
    title:
      (isReference ? referenceTitles[step.key] : undefined) ?? kindTitles[step.kind] ?? step.key,
    context: isReference
      ? '合成业务流程：账户 → 项目 → 可执行工作项；工时记录表示在工作项上的实际投入。'
      : '仅说明 manifest 声明的当前步骤；不推断未声明的业务流程。',
    action: intent.action,
    sources: table ? [{ table, field }] : [],
    selection: intent.selection,
    valueTransition:
      (isReference ? referenceTransitions[step.key] : undefined) ?? intent.valueTransition,
    expected: checks.length
      ? checks.map((check) => ({ evidence: 'declared', description: checkDescription(check) }))
      : [
          {
            evidence: 'declared',
            description: '执行 manifest 中声明的操作；没有直接绑定的独立正确性检查。',
          },
        ],
    actual,
    notObserved: [
      '没有读取 outbox 或原始数据库来追踪计算单元格变化。',
      '命令目标/返回记录与字段名不等于已确认发生变化的计算单元格。',
      '依赖路径来自 schema 或 complexity 估计，不能推出实际受影响行数。',
    ],
  };
}
