import type { ComplexityAssessment, ComplexityWorkloadStatus } from '@teable/v2-complexity';
import { z } from 'zod';

import type { BenchCaseManifest, BenchWorkloadStep } from '../case/manifest';
import type { BenchComplexityAssessment } from '../case/TeaCaseLoader';

export type MeasuredWorkloadOperation = Pick<BenchWorkloadStep, 'key' | 'kind'>;

export type ComplexityFeatureUnavailableReason =
  | 'operation-not-found'
  | 'operation-kind-mismatch'
  | 'unsupported-operation-kind'
  | 'missing-write-assessment'
  | 'flush-without-preceding-write'
  | 'assessment-workload-unknown';

export type ComplexityRangeFeatures = {
  readonly status: ComplexityWorkloadStatus;
  readonly expected: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
};

export type ComplexityModeFeatures = {
  readonly mode: string;
  readonly pathCount: number;
  readonly scan: ComplexityRangeFeatures;
  readonly dirty: ComplexityRangeFeatures;
  readonly estimatedWrites: ComplexityRangeFeatures;
  readonly workRows: ComplexityRangeFeatures;
};

/**
 * Exact assessment evidence used by empirical calibration. `score` retains its
 * model meaning as a nullable ranking index; it is never a latency estimate.
 */
export type ComplexityAssessmentFeatures = {
  readonly assessmentKey: string;
  readonly policyVersion: string;
  readonly score: number | null;
  readonly scoreSemantics: 'nullable-ranking-index';
  readonly scoreProvenance: BenchComplexityAssessment['scoreProvenance'] | null;
  readonly components: ComplexityAssessment['components'];
  readonly simulation: BenchComplexityAssessment['simulation'] | null;
  readonly confidence: ComplexityAssessment['confidence'];
  readonly workloadStatus: ComplexityAssessment['workload']['status'];
  readonly workloadRows: ComplexityRangeFeatures;
  readonly structural: number;
  readonly dataWork: number | null;
  readonly risk: number;
  readonly pathCount: number;
  readonly modes: ReadonlyArray<ComplexityModeFeatures>;
  readonly reasonCodes: ReadonlyArray<string>;
};

export type WriteCreateDimensions = {
  readonly kind: 'write-create';
  readonly table: string;
  readonly datasetRows: number | null;
  readonly targetRows: number;
  readonly batchSize: number;
  readonly batchCount: number;
  readonly typecast: boolean;
};

export type WriteUpdateDimensions = {
  readonly kind: 'write-update';
  readonly table: string;
  readonly field: string;
  readonly datasetRows: number | null;
  readonly targetRows: number;
  readonly batchSize: number;
  readonly batchCount: number;
  readonly typecast: boolean;
  readonly selection: 'first' | 'random';
  readonly valueKind: Extract<BenchWorkloadStep, { kind: 'write-update' }>['value']['kind'];
};

export type WriteDeleteDimensions = {
  readonly kind: 'write-delete';
  readonly table: string;
  readonly datasetRows: number | null;
  readonly targetRows: number;
  readonly batchSize: number;
  readonly batchCount: number;
  readonly selection: 'first' | 'random';
};

export type QueryCoreDimensions = {
  readonly kind: 'query-core';
  readonly table: string;
  readonly datasetRows: number | null;
  readonly filterNodeCount: number;
  readonly sortCount: number;
  readonly groupByCount: number;
  readonly projectionCount: number;
  readonly limit: number | null;
  readonly offset: number | null;
  readonly cursorKind: 'literal' | 'operation' | 'none';
  readonly includeTotal: boolean;
  readonly viewScoped: boolean;
};

export type QueryStructuredDimensions = {
  readonly kind: 'query-structured';
  readonly definitionKind: string | null;
  readonly definitionVersion: number | null;
  readonly table: string | null;
  readonly datasetRows: number | null;
  readonly definitionNodeCount: number;
  readonly filterNodeCount: number;
  readonly sortCount: number;
  readonly groupByCount: number;
  readonly selectCount: number;
  readonly aggregateCount: number;
  readonly relationCount: number;
  readonly limit: number | null;
  readonly offset: number | null;
  readonly includeTotal: boolean;
  readonly parameterCount: number;
};

export type FlushComputedDimensions = {
  readonly kind: 'flush-computed';
  readonly association: {
    readonly strategy: 'writes-since-previous-flush';
    readonly linkedWriteKeys: ReadonlyArray<string>;
  };
  readonly linkedWriteCount: number;
  readonly linkedWriteKinds: ReadonlyArray<
    Extract<BenchWorkloadStep, { kind: `write-${string}` }>['kind']
  >;
};

export type OperationComplexityDimensions =
  | WriteCreateDimensions
  | WriteUpdateDimensions
  | WriteDeleteDimensions
  | QueryCoreDimensions
  | QueryStructuredDimensions
  | FlushComputedDimensions;

export type OperationComplexityFeatures = {
  readonly operationKey: string;
  readonly operationKind: BenchWorkloadStep['kind'];
  /** Descriptive classification only; it does not establish calibration comparability. */
  readonly operationFamily: string | null;
  readonly dimensions: OperationComplexityDimensions | null;
  readonly assessmentKeys: ReadonlyArray<string>;
  readonly assessments: ReadonlyArray<ComplexityAssessmentFeatures>;
} & (
  | { readonly status: 'available' }
  | {
      readonly status: 'unavailable';
      readonly reason: ComplexityFeatureUnavailableReason;
    }
);

type SupportedStep = Extract<
  BenchWorkloadStep,
  {
    kind:
      | 'write-create'
      | 'write-update'
      | 'write-delete'
      | 'query-core'
      | 'query-structured'
      | 'flush-computed';
  }
>;

type WriteStep = Extract<BenchWorkloadStep, { kind: `write-${string}` }>;
const StructuredDefinitionFeatureSchema = z
  .object({
    version: z.number().finite().optional(),
    kind: z.string().optional(),
    tableId: z.string().optional(),
    filter: z.unknown().optional(),
    sort: z.array(z.unknown()).optional(),
    groupBy: z.array(z.unknown()).optional(),
    select: z.array(z.unknown()).optional(),
    aggregates: z.array(z.unknown()).optional(),
    relations: z.record(z.string(), z.unknown()).optional(),
    page: z
      .object({
        limit: z.number().finite().optional(),
        offset: z.number().finite().optional(),
        includeTotal: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

type StructuredDefinitionFeatures = z.infer<typeof StructuredDefinitionFeatureSchema>;

const parseStructuredDefinition = (value: unknown): StructuredDefinitionFeatures | undefined => {
  const result = StructuredDefinitionFeatureSchema.safeParse(value);
  return result.success ? result.data : undefined;
};

const jsonNodeCount = (value: unknown): number => {
  if (Array.isArray(value)) return 1 + value.reduce((sum, item) => sum + jsonNodeCount(item), 0);
  if (typeof value === 'object' && value !== null)
    return 1 + Object.values(value).reduce((sum, item) => sum + jsonNodeCount(item), 0);
  return 1;
};

const rangeFeatures = (
  range: ComplexityAssessment['workload']['rows']
): ComplexityRangeFeatures => ({
  status: range.status,
  expected: range.expected,
  lower: range.lower,
  upper: range.upper,
});

const assessmentFeatures = (
  assessmentKey: string,
  assessment: ComplexityAssessment
): ComplexityAssessmentFeatures => {
  const simulation = (assessment as Partial<BenchComplexityAssessment>).simulation ?? null;
  return {
    assessmentKey,
    policyVersion: assessment.policyVersion,
    score: assessment.score,
    scoreSemantics: 'nullable-ranking-index',
    scoreProvenance: (assessment as Partial<BenchComplexityAssessment>).scoreProvenance ?? null,
    components: assessment.components,
    simulation,
    confidence: assessment.confidence,
    workloadStatus: assessment.workload.status,
    workloadRows: rangeFeatures(assessment.workload.rows),
    structural: assessment.components.structural,
    dataWork: assessment.components.dataWork,
    risk: assessment.components.risk,
    pathCount: assessment.breakdown.paths.length,
    modes: assessment.breakdown.modes
      .map((mode) => ({
        mode: mode.mode,
        pathCount: mode.pathCount,
        scan: rangeFeatures(mode.scan),
        dirty: rangeFeatures(mode.dirty),
        estimatedWrites: rangeFeatures(mode.estimatedWrites),
        workRows: rangeFeatures(mode.workRows),
      }))
      .sort((left, right) => left.mode.localeCompare(right.mode)),
    reasonCodes: [...assessment.reasonCodes].sort(),
  };
};

const datasetRows = (manifest: BenchCaseManifest, table: string | null): number | null => {
  if (table === null) return null;
  const rows = manifest.dataset.rows[table];
  return rows === undefined ? null : rows;
};

const batchCount = (rows: number, size: number): number => Math.ceil(rows / size);

const coreQueryDimensions = (
  manifest: BenchCaseManifest,
  step: Extract<BenchWorkloadStep, { kind: 'query-core' }>
): QueryCoreDimensions => {
  const { query } = step;
  return {
    kind: step.kind,
    table: step.table,
    datasetRows: datasetRows(manifest, step.table),
    filterNodeCount: query.filter === undefined ? 0 : jsonNodeCount(query.filter),
    sortCount: query.sort?.length ?? 0,
    groupByCount: query.groupBy?.length ?? 0,
    projectionCount: query.projection?.length ?? 0,
    limit: query.limit ?? null,
    offset: query.offset ?? null,
    cursorKind:
      query.cursor === undefined
        ? 'none'
        : typeof query.cursor === 'string'
          ? 'literal'
          : 'operation',
    includeTotal: query.includeTotal === true,
    viewScoped: query.viewId !== undefined,
  };
};

const structuredQueryDimensions = (
  manifest: BenchCaseManifest,
  step: Extract<BenchWorkloadStep, { kind: 'query-structured' }>
): QueryStructuredDimensions => {
  const definition = parseStructuredDefinition(step.definition);
  const table = definition?.tableId ?? null;
  return {
    kind: step.kind,
    definitionKind: definition?.kind ?? null,
    definitionVersion: definition?.version ?? null,
    table,
    datasetRows: datasetRows(manifest, table),
    definitionNodeCount: jsonNodeCount(step.definition),
    filterNodeCount: definition?.filter === undefined ? 0 : jsonNodeCount(definition.filter),
    sortCount: definition?.sort?.length ?? 0,
    groupByCount: definition?.groupBy?.length ?? 0,
    selectCount: definition?.select?.length ?? 0,
    aggregateCount: definition?.aggregates?.length ?? 0,
    relationCount: Object.keys(definition?.relations ?? {}).length,
    limit: definition?.page?.limit ?? null,
    offset: definition?.page?.offset ?? null,
    includeTotal: definition?.page?.includeTotal === true,
    parameterCount: Object.keys(step.parameters ?? {}).length,
  };
};

const dimensionsForStep = (
  manifest: BenchCaseManifest,
  step: SupportedStep,
  linkedWrites: ReadonlyArray<WriteStep>
): OperationComplexityDimensions => {
  switch (step.kind) {
    case 'write-create':
      return {
        kind: step.kind,
        table: step.table,
        datasetRows: datasetRows(manifest, step.table),
        targetRows: step.rows,
        batchSize: step.batchSize,
        batchCount: batchCount(step.rows, step.batchSize),
        typecast: step.typecast,
      };
    case 'write-update':
      return {
        kind: step.kind,
        table: step.table,
        field: step.field,
        datasetRows: datasetRows(manifest, step.table),
        targetRows: step.rows,
        batchSize: step.batchSize,
        batchCount: batchCount(step.rows, step.batchSize),
        typecast: step.typecast,
        selection: step.selection ?? 'first',
        valueKind: step.value.kind,
      };
    case 'write-delete':
      return {
        kind: step.kind,
        table: step.table,
        datasetRows: datasetRows(manifest, step.table),
        targetRows: step.rows,
        batchSize: step.batchSize,
        batchCount: batchCount(step.rows, step.batchSize),
        selection: step.selection ?? 'first',
      };
    case 'query-core':
      return coreQueryDimensions(manifest, step);
    case 'query-structured':
      return structuredQueryDimensions(manifest, step);
    case 'flush-computed':
      return {
        kind: step.kind,
        association: {
          strategy: 'writes-since-previous-flush',
          linkedWriteKeys: linkedWrites.map((write) => write.key),
        },
        linkedWriteCount: linkedWrites.length,
        linkedWriteKinds: linkedWrites.map((write) => write.kind),
      };
  }
};

const isWrite = (step: BenchWorkloadStep): step is WriteStep =>
  step.kind === 'write-create' || step.kind === 'write-update' || step.kind === 'write-delete';

const linkedWritesForFlush = (
  workload: ReadonlyArray<BenchWorkloadStep>,
  flushIndex: number
): ReadonlyArray<WriteStep> => {
  const linked: WriteStep[] = [];
  for (let index = flushIndex - 1; index >= 0; index -= 1) {
    const step = workload[index]!;
    if (step.kind === 'flush-computed') break;
    if (isWrite(step)) linked.push(step);
  }
  return linked.reverse();
};

const familyFor = (step: SupportedStep, linkedWrites: ReadonlyArray<WriteStep>): string => {
  if (step.kind === 'query-structured') {
    const definition = parseStructuredDefinition(step.definition);
    return `${step.kind}/${definition?.kind ?? 'unknown'}`;
  }
  if (step.kind === 'flush-computed') {
    const kinds = [...new Set(linkedWrites.map((write) => write.kind))].sort();
    return `${step.kind}/${kinds.join('+') || 'unlinked'}`;
  }
  return step.kind;
};

const isSupported = (step: BenchWorkloadStep): step is SupportedStep =>
  step.kind !== 'checkpoint' && step.kind !== 'expect-error';

export function deriveOperationComplexityFeatures(input: {
  readonly manifest: BenchCaseManifest;
  readonly operation: MeasuredWorkloadOperation;
  readonly assessments: Readonly<Record<string, ComplexityAssessment>>;
}): OperationComplexityFeatures {
  const base = {
    operationKey: input.operation.key,
    operationKind: input.operation.kind,
  };
  const stepIndex = input.manifest.workload.findIndex((step) => step.key === input.operation.key);
  if (stepIndex < 0) {
    return {
      ...base,
      status: 'unavailable',
      reason: 'operation-not-found',
      operationFamily: null,
      dimensions: null,
      assessmentKeys: [],
      assessments: [],
    };
  }
  const step = input.manifest.workload[stepIndex]!;
  if (step.kind !== input.operation.kind) {
    return {
      ...base,
      status: 'unavailable',
      reason: 'operation-kind-mismatch',
      operationFamily: null,
      dimensions: null,
      assessmentKeys: [],
      assessments: [],
    };
  }
  if (!isSupported(step)) {
    return {
      ...base,
      status: 'unavailable',
      reason: 'unsupported-operation-kind',
      operationFamily: step.kind,
      dimensions: null,
      assessmentKeys: [],
      assessments: [],
    };
  }

  const linkedWrites =
    step.kind === 'flush-computed' ? linkedWritesForFlush(input.manifest.workload, stepIndex) : [];
  const assessmentKeys = isWrite(step)
    ? [step.key]
    : step.kind === 'flush-computed'
      ? linkedWrites.map((write) => write.key)
      : [];
  const assessments = assessmentKeys.flatMap((key) => {
    const assessment = input.assessments[key];
    return assessment === undefined ? [] : [assessmentFeatures(key, assessment)];
  });
  const result = {
    ...base,
    operationFamily: familyFor(step, linkedWrites),
    dimensions: dimensionsForStep(input.manifest, step, linkedWrites),
    assessmentKeys,
    assessments,
  };
  if (step.kind === 'flush-computed' && linkedWrites.length === 0) {
    return { ...result, status: 'unavailable', reason: 'flush-without-preceding-write' };
  }
  if (assessmentKeys.length !== assessments.length) {
    return { ...result, status: 'unavailable', reason: 'missing-write-assessment' };
  }
  if (assessments.some((assessment) => assessment.workloadStatus === 'unknown')) {
    return { ...result, status: 'unavailable', reason: 'assessment-workload-unknown' };
  }
  return { ...result, status: 'available' };
}
