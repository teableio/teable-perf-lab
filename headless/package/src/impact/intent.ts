import type { BenchWorkloadStep } from '../case/manifest';
import type { OperationImpactGraph } from './schema';

type Intent = Pick<OperationImpactGraph['explanation'], 'action' | 'selection' | 'valueTransition'>;

const defaultTransition = '此操作未声明值变化，或旧值没有被观察；不显示任意业务单元格内容。';

const queryIntent = (
  step: Extract<BenchWorkloadStep, { kind: 'query-core' }>,
  reference: boolean
): Intent => {
  if (reference && step.key === 'query-project-budget') {
    return {
      action:
        '读取 Projects：筛选 Budget > 9999，按 Title 升序，投影 Title、Budget、Budget Reserve，limit=3，includeTotal=true。',
      selection: '每个样本最多返回 3 条；includeTotal 请求匹配总数，不是数据库实际扫描行数。',
      valueTransition: defaultTransition,
    };
  }
  return {
    action: `读取 ${step.table}，按 manifest 的筛选、排序和字段投影返回记录。`,
    selection: `请求最多 ${step.query.limit ?? '默认上限'} 条；偏移 ${step.query.offset ?? 0}${step.query.cursor ? '，使用游标继续读取' : ''}。`,
    valueTransition: defaultTransition,
  };
};

export function operationIntent(step: BenchWorkloadStep, reference: boolean): Intent {
  switch (step.kind) {
    case 'query-core':
      return queryIntent(step, reference);
    case 'query-structured':
      return {
        action: '按结构化记录查询定义读取业务数据；返回字段名可能是查询别名。',
        selection: '使用结构化定义中的筛选、分页和字段别名；此收据不保证包含原始记录 ID。',
        valueTransition: defaultTransition,
      };
    case 'write-create':
      return {
        action: `向 ${step.table} 新增确定性配方记录，并应用配方中声明的关联。`,
        selection: `声明新增 ${step.rows} 条，提交批次上限 ${step.batchSize} 条。`,
        valueTransition: defaultTransition,
      };
    case 'write-update':
      return {
        action: `修改 ${step.table} 的 ${step.field} 字段。`,
        selection: `每个独立样本声明选择 ${step.rows} 条${step.selection === 'random' ? '固定种子随机' : '前序（当前 fresh sample 的 stateIndex=0）'}记录，提交批次上限 ${step.batchSize} 条；累计工作计数不能当作去重后的变化行数。`,
        valueTransition:
          step.value.kind === 'link-targets'
            ? `声明关联到 ${step.value.table} 的 ${step.value.indices.length} 个目标；目标序号来自 manifest，不是运行时变化证明。`
            : '声明采用 manifest 中的更新规则；为避免泄露任意业务内容，不显示原始提交值。',
      };
    case 'write-delete':
      return {
        action: `删除 ${step.table} 的命令目标记录；后续检查确认最终行数和计算状态。`,
        selection: `声明删除 ${step.rows} 条${step.selection === 'random' ? '固定种子随机' : '前序'}记录。`,
        valueTransition: defaultTransition,
      };
    case 'flush-computed':
      return {
        action: '排空尚未完成的计算任务；写入确认时可能已内联完成一部分计算。',
        selection: '不选择业务记录；等待运行时剩余计算任务。',
        valueTransition: '排空不声明某个业务字段的值变化。',
      };
    default:
      return {
        action: '此步骤仅用于正确性，不是测量操作。',
        selection: '不适用。',
        valueTransition: defaultTransition,
      };
  }
}
