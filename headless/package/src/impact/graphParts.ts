import type { SchemaComplexityEdge } from '@teable/v2-complexity';

import type { BenchOperationMeasurement } from '../runner/BenchRunner';
import type { ImpactGraphEdge, ImpactGraphNode } from './schema';

export type GraphCollector = {
  readonly nodes: Map<string, ImpactGraphNode>;
  readonly edges: ImpactGraphEdge[];
  readonly structure: {
    readonly tablesByReference: ReadonlyMap<string, { id: string; name: string }>;
    readonly fieldsByReference: ReadonlyMap<string, { id: string; name: string; tableId: string }>;
  };
  readonly rootId: string;
  readonly operationId: string;
};

export const addNode = (collector: GraphCollector, node: ImpactGraphNode): void => {
  if (collector.nodes.has(node.id)) return;
  if (collector.nodes.size < 160) collector.nodes.set(node.id, node);
};

export const addEdge = (collector: GraphCollector, edge: ImpactGraphEdge): void => {
  if (collector.edges.length < 240) collector.edges.push(edge);
};

const fieldNode = (
  collector: GraphCollector,
  fieldId: string,
  evidence: 'declared' | 'estimated',
  relation: string
): void => {
  const field = collector.structure.fieldsByReference.get(fieldId);
  addNode(collector, {
    id: `field:${fieldId}`,
    kind: 'field',
    label: field
      ? `${collector.structure.tablesByReference.get(field.tableId)?.name ?? field.tableId}.${field.name}`
      : fieldId,
    ...(field ? { tableId: field.tableId } : {}),
    fieldId,
    evidence,
    relation,
  });
};

export function addDeclaredDependencies(
  collector: GraphCollector,
  seeds: ReadonlySet<string>,
  dependencies: ReadonlyArray<SchemaComplexityEdge>
): void {
  const reachable = new Set(seeds);
  for (let round = 0; round < 160; round += 1) {
    let expanded = false;
    for (const [index, dependency] of dependencies.entries()) {
      if (!reachable.has(dependency.fromFieldId)) continue;
      fieldNode(collector, dependency.fromFieldId, 'declared', 'schema-dependency-field');
      fieldNode(collector, dependency.toFieldId, 'declared', 'schema-dependency-field');
      const id = `${collector.operationId}:schema:${index}`;
      if (!collector.edges.some((edge) => edge.id === id)) {
        addEdge(collector, {
          id,
          from: `field:${dependency.fromFieldId}`,
          to: `field:${dependency.toFieldId}`,
          relation: `declared-${dependency.kind}-dependency`,
          evidence: 'declared',
          completeness: 'partial',
          description:
            '由 .tea schema 声明的字段依赖；仅是可能的传播关系，不证明实际记录或单元格改变。',
        });
      }
      if (!reachable.has(dependency.toFieldId)) {
        reachable.add(dependency.toFieldId);
        expanded = true;
      }
    }
    if (!expanded) return;
  }
}

export function addEstimatedPaths(
  collector: GraphCollector,
  paths: ReadonlyArray<{ fromFieldId: string; toFieldId: string; mode: string }>
): void {
  for (const [index, path] of paths.entries()) {
    fieldNode(collector, path.fromFieldId, 'estimated', 'estimated-dependency-field');
    fieldNode(collector, path.toFieldId, 'estimated', 'estimated-dependency-field');
    addEdge(collector, {
      id: `${collector.operationId}:estimated-path:${index}`,
      from: `field:${path.fromFieldId}`,
      to: `field:${path.toFieldId}`,
      relation: `estimated-${path.mode}-path`,
      evidence: 'estimated',
      completeness: 'partial',
      description:
        '来自 run.json complexity.assessments 的结构与数据工作估计；不是已观察到的记录或计算单元格变化。',
    });
  }
}

export function addObservedTargets(
  collector: GraphCollector,
  observation: BenchOperationMeasurement['observation']
): void {
  if (!observation) return;
  for (const [index, recordId] of observation.recordIds.slice(0, 100).entries()) {
    const nodeId = `record:${collector.operationId}:${recordId}`;
    addNode(collector, {
      id: nodeId,
      kind: 'record',
      label: recordId,
      recordId,
      evidence: 'observed',
      relation: observation.recordRelation,
    });
    addEdge(collector, {
      id: `${collector.operationId}:observed-record:${index}`,
      from: collector.rootId,
      to: nodeId,
      relation:
        observation.recordRelation === 'returned'
          ? 'observed-query-returned-record'
          : 'observed-command-target-record',
      evidence: 'observed',
      completeness: observation.truncated ? 'bounded' : 'complete',
      description:
        observation.recordRelation === 'returned'
          ? '运行时查询返回的记录 ID；不表示记录或计算单元格发生变化。'
          : '运行时命令选中或创建的目标记录 ID；不表示依赖计算单元格已确认变化。',
    });
  }
  for (const fieldName of observation.fieldNames) {
    const nodeId = `observed-field:${collector.operationId}:${fieldName}`;
    addNode(collector, {
      id: nodeId,
      kind: 'field',
      label: fieldName,
      evidence: 'observed',
      relation:
        observation.recordRelation === 'returned' ? 'returned-field-name' : 'command-field-name',
    });
    addEdge(collector, {
      id: `${collector.operationId}:observed-field:${collector.edges.length}`,
      from: collector.rootId,
      to: nodeId,
      relation: 'observed-field-name',
      evidence: 'observed',
      completeness: 'bounded',
      description: '字段名来自运行时查询结果或命令目标；sidecar 不包含任何单元格值。',
    });
  }
}
