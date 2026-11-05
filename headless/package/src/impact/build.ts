/* eslint-disable sonarjs/cognitive-complexity -- deterministic manifest-union graph assembly keeps provenance rules adjacent */
import { schemaFromDotTeaStructure, type SchemaComplexityEdge } from '@teable/v2-complexity';
import type { BenchCaseManifest, BenchWorkloadStep } from '../case/manifest';
import type { TeaBenchReport } from '../report/schema';
import type { BenchRunReport } from '../runner/BenchRunner';
import { explainOperation } from './explain';
import {
  addDeclaredDependencies,
  addEdge,
  addEstimatedPaths,
  addNode,
  addObservedTargets,
  type GraphCollector,
} from './graphParts';
import {
  TEA_BENCH_IMPACT_GRAPH_SCHEMA_VERSION,
  TeaBenchImpactGraphSchema,
  type OperationImpactGraph,
  type TeaBenchImpactGraph,
} from './schema';

export const IMPACT_GRAPH_LIMITS = {
  maxRecordNodesPerOperation: 100,
  maxNodesPerOperation: 160,
  maxEdgesPerOperation: 240,
} as const;

type StructureField = { readonly id: string; readonly name: string };
type StructureTable = {
  readonly id: string;
  readonly name: string;
  readonly fields: ReadonlyArray<StructureField>;
};
type StructureIndex = {
  readonly tablesByReference: ReadonlyMap<string, StructureTable>;
  readonly fieldsByReference: ReadonlyMap<string, StructureField & { readonly tableId: string }>;
};
type ComplexityPath = {
  readonly mode?: unknown;
  readonly fromFieldId?: unknown;
  readonly toFieldId?: unknown;
  readonly fromTableId?: unknown;
  readonly toTableId?: unknown;
  readonly linkFieldId?: unknown;
  readonly certainty?: unknown;
};

const objectValue = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const structureIndex = (structure: unknown): StructureIndex => {
  const tablesByReference = new Map<string, StructureTable>();
  const fieldsByReference = new Map<string, StructureField & { readonly tableId: string }>();
  const tables = objectValue(structure)?.tables;
  if (!Array.isArray(tables)) return { tablesByReference, fieldsByReference };
  for (const rawTable of tables) {
    const tableObject = objectValue(rawTable);
    const id = stringValue(tableObject?.id);
    const name = stringValue(tableObject?.name);
    if (!id || !name || !Array.isArray(tableObject?.fields)) continue;
    const fields: StructureField[] = [];
    for (const rawField of tableObject.fields) {
      const fieldObject = objectValue(rawField);
      const fieldId = stringValue(fieldObject?.id);
      const fieldName = stringValue(fieldObject?.name);
      if (!fieldId || !fieldName) continue;
      const field = { id: fieldId, name: fieldName };
      fields.push(field);
      fieldsByReference.set(fieldId, { ...field, tableId: id });
      fieldsByReference.set(`${name}.${fieldName}`, { ...field, tableId: id });
    }
    const table = { id, name, fields };
    tablesByReference.set(id, table);
    tablesByReference.set(name, table);
  }
  return { tablesByReference, fieldsByReference };
};

const collectQueryFieldReferences = (value: unknown, output: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectQueryFieldReferences(item, output);
    return;
  }
  const object = objectValue(value);
  if (!object) return;
  for (const [key, nested] of Object.entries(object)) {
    if ((key === 'fieldId' || key === 'field') && typeof nested === 'string') output.add(nested);
    collectQueryFieldReferences(nested, output);
  }
};

// The manifest union is intentionally handled in one exhaustive deterministic dispatcher.
// eslint-disable-next-line sonarjs/cognitive-complexity
const declaredIntent = (
  step: BenchWorkloadStep,
  index: StructureIndex
): {
  readonly tables: ReadonlyArray<StructureTable>;
  readonly fields: ReadonlyArray<StructureField & { tableId: string }>;
} => {
  const tables = new Map<string, StructureTable>();
  const fields = new Map<string, StructureField & { tableId: string }>();
  const addTable = (reference: string): StructureTable | undefined => {
    const table = index.tablesByReference.get(reference);
    if (table) tables.set(table.id, table);
    return table;
  };
  const addField = (reference: string, table?: StructureTable): void => {
    const field =
      (table ? index.fieldsByReference.get(`${table.name}.${reference}`) : undefined) ??
      index.fieldsByReference.get(reference);
    if (field) fields.set(field.id, field);
  };
  if (step.kind === 'query-core') {
    const table = addTable(step.table);
    const references = new Set<string>();
    collectQueryFieldReferences(step.query, references);
    for (const field of step.query.projection ?? []) references.add(field);
    for (const field of step.query.groupBy ?? []) references.add(field);
    for (const reference of references) addField(reference, table);
  } else if (step.kind === 'query-structured') {
    const definition = objectValue(step.definition);
    const tableReference = stringValue(definition?.tableId);
    const table = tableReference ? addTable(tableReference) : undefined;
    const references = new Set<string>();
    collectQueryFieldReferences(step.definition, references);
    for (const reference of references) addField(reference, table);
  } else if (
    step.kind === 'write-create' ||
    step.kind === 'write-update' ||
    step.kind === 'write-delete'
  ) {
    const table = addTable(step.table);
    if (step.kind === 'write-update') addField(step.field, table);
  }
  return { tables: [...tables.values()], fields: [...fields.values()] };
};

const complexityPaths = (run: BenchRunReport, key: string): ReadonlyArray<ComplexityPath> => {
  const complexity = objectValue(run.complexity);
  const assessments = objectValue(complexity?.assessments);
  const assessment = objectValue(assessments?.[key]);
  const breakdown = objectValue(assessment?.breakdown);
  return Array.isArray(breakdown?.paths)
    ? breakdown.paths.map(objectValue).filter((path): path is ComplexityPath => path !== undefined)
    : [];
};

// Graph assembly keeps evidence labels adjacent so no inferred edge can lose provenance.
// eslint-disable-next-line sonarjs/cognitive-complexity
const graphForOperation = (input: {
  readonly operation: TeaBenchReport['executions'][number]['operations'][number];
  readonly executionId: string;
  readonly step: BenchWorkloadStep;
  readonly runOperation: BenchRunReport['operations'][number] | undefined;
  readonly run: BenchRunReport;
  readonly declaredEdges: ReadonlyArray<SchemaComplexityEdge>;
  readonly structure: StructureIndex;
  readonly manifest: BenchCaseManifest;
  readonly checks: BenchRunReport['oracle']['checks'];
}): OperationImpactGraph => {
  const { operation, executionId, step, runOperation, run, structure, manifest, checks } = input;
  const rootId = `operation:${operation.operationId}`;
  const collector: GraphCollector = {
    nodes: new Map(),
    edges: [],
    structure,
    rootId,
    operationId: operation.operationId,
  };
  const { nodes, edges } = collector;
  const notes: string[] = [];
  addNode(collector, {
    id: rootId,
    kind: 'operation',
    label: operation.title,
    evidence: 'declared',
    relation: 'measured-step',
  });

  const intent = declaredIntent(step, structure);
  for (const table of intent.tables) {
    const nodeId = `table:${table.id}`;
    addNode(collector, {
      id: nodeId,
      kind: 'table',
      label: table.name,
      tableId: table.id,
      evidence: 'declared',
      relation: step.kind.startsWith('query-') ? 'query-source' : 'command-target-table',
    });
    addEdge(collector, {
      id: `${rootId}->${nodeId}:declared`,
      from: rootId,
      to: nodeId,
      relation: step.kind.startsWith('query-')
        ? 'declares-query-source'
        : 'declares-command-target',
      evidence: 'declared',
      completeness: 'complete',
      description: '由 manifest 工作负载步骤声明；不表示该表所有记录或单元格实际变化。',
    });
  }
  for (const field of intent.fields) {
    const nodeId = `field:${field.id}`;
    const table = structure.tablesByReference.get(field.tableId);
    addNode(collector, {
      id: nodeId,
      kind: 'field',
      label: `${table?.name ?? field.tableId}.${field.name}`,
      tableId: field.tableId,
      fieldId: field.id,
      evidence: 'declared',
      relation: step.kind.startsWith('query-') ? 'query-field' : 'command-target-field',
    });
    addEdge(collector, {
      id: `${rootId}->${nodeId}:declared`,
      from: rootId,
      to: nodeId,
      relation: step.kind.startsWith('query-') ? 'declares-query-field' : 'declares-command-field',
      evidence: 'declared',
      completeness: 'complete',
      description: '字段来自 manifest 查询或写入意图；不表示字段值已变化。',
    });
  }
  const seeds = new Set(intent.fields.map((field) => field.id));
  if (step.kind === 'write-create' || step.kind === 'write-delete') {
    for (const table of intent.tables) for (const field of table.fields) seeds.add(field.id);
  }
  addDeclaredDependencies(collector, seeds, input.declaredEdges);
  const estimatedPaths = complexityPaths(run, step.key).flatMap((path) => {
    const fromFieldId = stringValue(path.fromFieldId);
    const toFieldId = stringValue(path.toFieldId);
    if (!fromFieldId || !toFieldId) return [];
    return [{ fromFieldId, toFieldId, mode: stringValue(path.mode) ?? 'dependency' }];
  });
  addEstimatedPaths(collector, estimatedPaths);

  const observation = runOperation?.observation;
  addObservedTargets(collector, observation);

  if (step.kind === 'flush-computed') {
    const runtimeId = `runtime:${operation.operationId}`;
    addNode(collector, {
      id: runtimeId,
      kind: 'runtime',
      label: `处理任务 ${runOperation?.processed ?? operation.work.processed}`,
      evidence: 'observed',
      relation: 'processed-task-count',
    });
    addEdge(collector, {
      id: `${rootId}->${runtimeId}:processed`,
      from: rootId,
      to: runtimeId,
      relation: 'observed-processed-task-count',
      evidence: 'observed',
      completeness: 'complete',
      description: 'processed 表示运行时处理的任务数，不是记录数。',
    });
    notes.push('排空影响的表、记录和单元格未观察；不能从 processed 任务数推导。');
  } else {
    notes.push('未观察依赖计算实际改变的表、记录或单元格；schema 路径只表达声明或估计。');
  }
  if (!observation || observation.recordRelation === 'none') {
    notes.push('此操作没有可持久化的返回/命令目标记录 ID 证据。');
  }
  notes.push('正确性期望由 manifest 声明，pass/fail 由 runner 的确定性代码比较；未使用 AI。');

  const evidence = new Set<OperationImpactGraph['evidence'][number]>(['declared', 'unknown']);
  if (edges.some((edge) => edge.evidence === 'estimated')) evidence.add('estimated');
  if (edges.some((edge) => edge.evidence === 'observed')) evidence.add('observed');
  const retainedEdges = edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to));
  return {
    operationId: operation.operationId,
    executionId,
    key: operation.key,
    kind: operation.kind,
    order: operation.order,
    relation: 'operation-impact-evidence',
    explanation: explainOperation({ step, manifest, run, checks }),
    evidence: [...evidence],
    completeness:
      observation?.truncated || nodes.size >= IMPACT_GRAPH_LIMITS.maxNodesPerOperation
        ? 'bounded'
        : 'partial',
    nodes: [...nodes.values()],
    edges: retainedEdges,
    notes,
  };
};

export function buildTeaBenchImpactGraph(input: {
  readonly report: TeaBenchReport;
  readonly run: BenchRunReport;
  readonly manifest: BenchCaseManifest;
  readonly structure: unknown;
}): TeaBenchImpactGraph {
  const execution = input.report.executions[0];
  if (!execution) throw new Error('Impact graph requires one report execution');
  const measuredSteps = new Map(
    input.manifest.workload
      .filter((step) => step.kind !== 'checkpoint' && step.kind !== 'expect-error')
      .map((step) => [step.key, step])
  );
  const runOperations = new Map(
    input.run.operations.map((operation) => [operation.key, operation])
  );
  const index = structureIndex(input.structure);
  const schemaProfile = schemaFromDotTeaStructure(input.structure);
  const oracleChecksByStep = new Map<string, BenchRunReport['oracle']['checks']>();
  const chainsByStep = new Map<string, string[]>();
  let sequence: string[] = [];
  for (const step of input.manifest.workload) {
    if (step.kind === 'expect-error') {
      sequence = [];
      continue;
    }
    if (step.kind !== 'checkpoint') {
      sequence.push(step.key);
      continue;
    }
    const checks = input.run.oracle.checks.filter(
      (check) =>
        check.checkId === step.check.checkId || check.checkId?.startsWith(`${step.check.checkId}#`)
    );
    for (const key of sequence) {
      oracleChecksByStep.set(key, [...(oracleChecksByStep.get(key) ?? []), ...checks]);
      chainsByStep.set(key, [...sequence, step.check.checkId]);
      chainsByStep.set(step.key, [...sequence, step.check.checkId]);
    }
    sequence = [];
  }
  const graphs = Object.fromEntries(
    execution.operations.map((operation) => {
      const step = measuredSteps.get(operation.key);
      if (!step) throw new Error(`Measured operation has no manifest step: ${operation.key}`);
      const graph = graphForOperation({
        operation,
        executionId: execution.executionId,
        step,
        runOperation: runOperations.get(operation.key),
        run: input.run,
        structure: index,
        declaredEdges: schemaProfile.edges,
        manifest: input.manifest,
        checks: oracleChecksByStep.get(operation.key) ?? [],
      });
      const chain = chainsByStep.get(operation.key);
      if (chain)
        graph.notes.push(`检查验证的是操作序列后的状态，不是单独归因：${chain.join(' → ')}`);
      return [operation.operationId, graph];
    })
  );
  return TeaBenchImpactGraphSchema.parse({
    schema: TEA_BENCH_IMPACT_GRAPH_SCHEMA_VERSION,
    reportSchema: input.report.schema,
    executionId: execution.executionId,
    caseId: execution.caseId,
    runId: execution.runId,
    limits: IMPACT_GRAPH_LIMITS,
    graphs,
    // Manifest-order cards intentionally normalize all step variants in one place.
    // eslint-disable-next-line sonarjs/cognitive-complexity
    steps: input.manifest.workload.map((step, order) => {
      const operation = execution.operations.find((candidate) => candidate.key === step.key);
      const checkId =
        step.kind === 'checkpoint'
          ? step.check.checkId
          : step.kind === 'expect-error'
            ? (step.checkId ?? `${step.key}/expect-error`)
            : null;
      const checks =
        checkId === null
          ? []
          : input.run.oracle.checks.filter(
              (check) => check.checkId === checkId || check.checkId?.startsWith(`${checkId}#`)
            );
      const graph = operation ? graphs[operation.operationId] : undefined;
      return {
        order,
        key: step.key,
        kind: step.kind,
        measured: operation !== undefined,
        operationId: operation?.operationId ?? null,
        title:
          graph?.explanation.title ??
          (step.kind === 'checkpoint' ? '状态检查（非计时）' : '预期错误检查（非计时）'),
        description:
          step.kind === 'checkpoint'
            ? step.check.description
            : step.kind === 'expect-error'
              ? (step.description ?? '拒绝无效操作并核对状态不变。')
              : (graph?.explanation.action ?? 'manifest 操作'),
        checkId,
        method: checks[0]?.method ?? null,
        statuses: checks.map((check) => check.status),
        chain: chainsByStep.get(step.key) ?? [step.key, ...(checkId ? [checkId] : [])],
        expectationEvidence: 'declared',
        verdictEvidence: checks.length > 0 || operation ? 'observed' : 'unknown',
      };
    }),
    correctnessSteps: input.manifest.workload.flatMap((step) => {
      if (step.kind !== 'expect-error') return [];
      const baseId = step.checkId ?? `${step.key}/expect-error`;
      const checks = input.run.oracle.checks.filter(
        (check) => check.checkId === baseId || check.checkId?.startsWith(`${baseId}#`)
      );
      return [
        {
          key: step.key,
          kind: 'expect-error',
          measured: false,
          description: step.description ?? '提交无效操作，期待指定错误并核对状态保持不变。',
          expectationEvidence: 'declared',
          verdictEvidence: 'observed',
          checkIds: checks.flatMap((check) => (check.checkId ? [check.checkId] : [])),
          statuses: checks.map((check) => check.status),
        },
      ];
    }),
  });
}
