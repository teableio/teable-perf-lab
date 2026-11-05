import type { ComplexityAssessment, ComplexityWorkloadStatus } from '@teable/v2-complexity';
import { describe, expect, it } from 'vitest';

import type { BenchCaseManifest, BenchWorkloadStep } from '../case/manifest';
import { deriveOperationComplexityFeatures } from './complexityFeatures';

const writeA: Extract<BenchWorkloadStep, { kind: 'write-update' }> = {
  key: 'update-amount',
  kind: 'write-update',
  table: 'Orders',
  field: 'Amount',
  rows: 20,
  batchSize: 5,
  typecast: false,
  value: { kind: 'number-increment', start: 1, step: 1 },
};
const writeB: Extract<BenchWorkloadStep, { kind: 'write-delete' }> = {
  key: 'delete-orders',
  kind: 'write-delete',
  table: 'Orders',
  rows: 4,
  batchSize: 2,
};
const coreQuery: Extract<BenchWorkloadStep, { kind: 'query-core' }> = {
  key: 'query-page',
  kind: 'query-core',
  table: 'Orders',
  query: {
    filter: { fieldId: 'Amount', operator: 'isGreater', value: 10 },
    sort: [{ fieldId: 'Amount', order: 'desc' }],
    projection: ['Amount'],
    limit: 10,
    includeTotal: true,
  },
};
const structuredQuery: Extract<BenchWorkloadStep, { kind: 'query-structured' }> = {
  key: 'aggregate-orders',
  kind: 'query-structured',
  definition: {
    version: 1,
    kind: 'aggregate',
    tableId: 'Orders',
    filter: { fieldId: 'Amount', operator: 'isGreater', value: 10 },
    aggregates: [{ fieldId: 'Amount', statisticFunc: 'sum', alias: 'total' }],
  },
  parameters: { threshold: 10 },
};
const checkpoint: Extract<BenchWorkloadStep, { kind: 'checkpoint' }> = {
  key: 'verify-count',
  kind: 'checkpoint',
  check: {
    checkId: 'count',
    description: 'row count remains deterministic',
    obligationIds: [],
    kind: 'row-count',
    table: 'Orders',
    expected: 96,
  },
};
const expectedError: Extract<BenchWorkloadStep, { kind: 'expect-error' }> = {
  key: 'invalid-query',
  kind: 'expect-error',
  expectedCode: 'validation.invalid',
  step: { kind: 'query-core', table: 'Orders', query: { limit: 1 } },
};
const flush: Extract<BenchWorkloadStep, { kind: 'flush-computed' }> = {
  key: 'drain',
  kind: 'flush-computed',
};

const manifest = (
  workload: ReadonlyArray<BenchWorkloadStep> = [
    writeA,
    checkpoint,
    writeB,
    flush,
    coreQuery,
    structuredQuery,
  ],
  rows = 100
): BenchCaseManifest => ({
  caseId: `sha256:${'a'.repeat(64)}`,
  specVersion: 1,
  generatorVersion: 'test',
  title: 'complexity feature fixture',
  source: { tea: 'fixture.tea', dataMode: 'recipe' },
  dataset: {
    rows: { Orders: rows },
    seed: { schema: 1, data: 2, query: 3, schedule: 4 },
  },
  run: {
    backend: 'pglite',
    samples: 20,
    warmup: 1,
    repetitions: 1,
    seedBatchSize: 100,
    actorId: 'usr_test',
  },
  workload,
  oracle: [],
});

const range = (status: ComplexityWorkloadStatus, rows: number) => ({
  status,
  expected: status === 'unknown' ? null : rows,
  lower: status === 'unknown' ? null : rows,
  upper: status === 'unknown' ? null : rows,
});

const assessment = (
  structural: number,
  rows: number,
  status: ComplexityWorkloadStatus = 'estimated',
  score: number | null = null
): ComplexityAssessment => ({
  policyVersion: 'v2-complexity-policy-2',
  level: status === 'unknown' ? 'unknown' : 'low',
  score,
  headline: 'fixture',
  workload: {
    status,
    rows: range(status, rows),
    typicalLevel: status === 'unknown' ? 'unknown' : 'low',
    worstCaseLevel: status === 'unknown' ? 'unknown' : 'low',
    level: status === 'unknown' ? 'unknown' : 'low',
    basis: 'max-scan-dirty',
    warnings: [],
  },
  breakdown: {
    modes: [
      {
        mode: 'sameRecord',
        pathCount: structural,
        scan: range(status, rows),
        dirty: range(status, rows),
        estimatedWrites: range(status, rows),
        workRows: range(status, rows),
        share: { typicalShare: 1, worstCaseShare: 1, warnings: [] },
      },
    ],
    paths: [],
    shareBasis: 'path-work',
  },
  components: { structural, dataWork: status === 'unknown' ? null : rows, risk: 0 },
  reasonCodes: status === 'unknown' ? ['workload-unknown'] : [],
  recommendations: [],
  confidence: status === 'unknown' ? 'low' : 'high',
});

const operation = (step: BenchWorkloadStep) => ({ key: step.key, kind: step.kind });

describe('deriveOperationComplexityFeatures', () => {
  it('changes stable assessment dimensions when loaded schema complexity changes', () => {
    const caseManifest = manifest();
    const low = deriveOperationComplexityFeatures({
      manifest: caseManifest,
      operation: operation(writeA),
      assessments: { [writeA.key]: assessment(2, 20) },
    });
    const high = deriveOperationComplexityFeatures({
      manifest: caseManifest,
      operation: operation(writeA),
      assessments: { [writeA.key]: assessment(9, 20) },
    });

    expect(low.status).toBe('available');
    expect(low.assessments[0]).toMatchObject({
      score: null,
      scoreSemantics: 'nullable-ranking-index',
      scoreProvenance: null,
      components: { structural: 2, dataWork: 20, risk: 0 },
      structural: 2,
      pathCount: 0,
      simulation: null,
    });
    expect(high.assessments[0]).toMatchObject({ structural: 9, pathCount: 0 });
    expect(high).not.toEqual(low);
  });

  it('forwards an actual nullable-ranking score and its simulation provenance unchanged', () => {
    const actualAssessment = {
      ...assessment(7, 20, 'estimated', 42),
      scoreProvenance: {
        kind: 'assumption-backed' as const,
        assumption: 'changeRate' as const,
        source: 'manifest.dimensions.complexityAssumptions.changeRateByOperation' as const,
        declaredSource: 'calibration-plan',
        evidence: 'Declared conservative upper bound.',
      },
      simulation: {
        kind: 'workload-operation' as const,
        operation: {
          kind: 'update' as const,
          tableId: 'tblOrders',
          changedFieldIds: ['fldAmount'],
        },
        assumptions: {
          rowCounts: { tblOrders: 100 },
          seedRecordCount: 20,
          changeRate: 1,
        },
        provenance: {
          rowCounts: {
            source: 'manifest.dataset.rows' as const,
            tableNamesById: { tblOrders: 'Orders' },
          },
          seedRecordCount: {
            source: 'manifest.workload.rows' as const,
            operationKey: 'update-amount',
          },
          linkFanout: {},
          changeRate: {
            source: 'manifest.dimensions.complexityAssumptions.changeRateByOperation' as const,
            value: 1,
            declaredSource: 'calibration-plan',
            evidence: 'Declared conservative upper bound.',
          },
        },
      },
    };

    const features = deriveOperationComplexityFeatures({
      manifest: manifest([writeA]),
      operation: operation(writeA),
      assessments: { [writeA.key]: actualAssessment },
    });

    expect(features.assessments[0]).toMatchObject({
      assessmentKey: 'update-amount',
      policyVersion: 'v2-complexity-policy-2',
      score: 42,
      scoreSemantics: 'nullable-ranking-index',
      scoreProvenance: {
        kind: 'assumption-backed',
        assumption: 'changeRate',
        declaredSource: 'calibration-plan',
        evidence: 'Declared conservative upper bound.',
      },
      components: { structural: 7, dataWork: 20, risk: 0 },
      simulation: {
        kind: 'workload-operation',
        assumptions: { changeRate: 1 },
        provenance: {
          changeRate: {
            source: 'manifest.dimensions.complexityAssumptions.changeRateByOperation',
            value: 1,
            declaredSource: 'calibration-plan',
            evidence: 'Declared conservative upper bound.',
          },
        },
      },
    });
  });

  it('changes manifest dimensions when workload scale and query shape change', () => {
    const small = deriveOperationComplexityFeatures({
      manifest: manifest([writeA], 100),
      operation: operation(writeA),
      assessments: { [writeA.key]: assessment(2, 20) },
    });
    const largerWrite = { ...writeA, rows: 80, batchSize: 10 } satisfies BenchWorkloadStep;
    const large = deriveOperationComplexityFeatures({
      manifest: manifest([largerWrite], 1_000),
      operation: operation(largerWrite),
      assessments: { [writeA.key]: assessment(2, 80) },
    });

    expect(small.dimensions).toMatchObject({ datasetRows: 100, targetRows: 20, batchCount: 4 });
    expect(large.dimensions).toMatchObject({ datasetRows: 1_000, targetRows: 80, batchCount: 8 });

    const widerQuery = {
      ...coreQuery,
      query: { ...coreQuery.query, groupBy: ['Customer'], projection: ['Amount', 'Customer'] },
    } satisfies BenchWorkloadStep;
    const narrowFeatures = deriveOperationComplexityFeatures({
      manifest: manifest([coreQuery]),
      operation: operation(coreQuery),
      assessments: {},
    });
    const wideFeatures = deriveOperationComplexityFeatures({
      manifest: manifest([widerQuery]),
      operation: operation(widerQuery),
      assessments: {},
    });
    expect(narrowFeatures.dimensions).toMatchObject({ groupByCount: 0, projectionCount: 1 });
    expect(wideFeatures.dimensions).toMatchObject({ groupByCount: 1, projectionCount: 2 });
  });

  it('links a flush to every write since the preceding flush in workload order', () => {
    const caseManifest = manifest();
    const features = deriveOperationComplexityFeatures({
      manifest: caseManifest,
      operation: operation(flush),
      assessments: {
        [writeA.key]: assessment(3, 20),
        [writeB.key]: assessment(5, 4),
      },
    });

    expect(features).toMatchObject({
      status: 'available',
      operationFamily: 'flush-computed/write-delete+write-update',
      assessmentKeys: ['update-amount', 'delete-orders'],
      dimensions: {
        kind: 'flush-computed',
        association: {
          strategy: 'writes-since-previous-flush',
          linkedWriteKeys: ['update-amount', 'delete-orders'],
        },
        linkedWriteCount: 2,
        linkedWriteKinds: ['write-update', 'write-delete'],
      },
    });
    expect(features.assessments.map((entry) => entry.assessmentKey)).toEqual([
      'update-amount',
      'delete-orders',
    ]);

    const secondFlush: BenchWorkloadStep = { key: 'second-drain', kind: 'flush-computed' };
    expect(
      deriveOperationComplexityFeatures({
        manifest: manifest([writeA, flush, secondFlush]),
        operation: operation(secondFlush),
        assessments: { [writeA.key]: assessment(3, 20) },
      })
    ).toMatchObject({ status: 'unavailable', reason: 'flush-without-preceding-write' });
  });

  it('keeps core and structured queries distinct without requiring write assessments', () => {
    const caseManifest = manifest();
    const core = deriveOperationComplexityFeatures({
      manifest: caseManifest,
      operation: operation(coreQuery),
      assessments: {},
    });
    const structured = deriveOperationComplexityFeatures({
      manifest: caseManifest,
      operation: operation(structuredQuery),
      assessments: {},
    });

    expect(core).toMatchObject({
      status: 'available',
      operationFamily: 'query-core',
      dimensions: { kind: 'query-core', sortCount: 1, projectionCount: 1 },
      assessmentKeys: [],
    });
    expect(structured).toMatchObject({
      status: 'available',
      operationFamily: 'query-structured/aggregate',
      dimensions: {
        kind: 'query-structured',
        definitionKind: 'aggregate',
        aggregateCount: 1,
        parameterCount: 1,
      },
      assessmentKeys: [],
    });
  });

  it('marks unsupported, missing, and unknown inputs unavailable without fallback features', () => {
    const caseManifest = manifest();
    expect(
      deriveOperationComplexityFeatures({
        manifest: caseManifest,
        operation: operation(checkpoint),
        assessments: {},
      })
    ).toMatchObject({ status: 'unavailable', reason: 'unsupported-operation-kind' });

    expect(
      deriveOperationComplexityFeatures({
        manifest: manifest([expectedError]),
        operation: operation(expectedError),
        assessments: {},
      })
    ).toMatchObject({
      status: 'unavailable',
      reason: 'unsupported-operation-kind',
      operationFamily: 'expect-error',
      dimensions: null,
    });

    expect(
      deriveOperationComplexityFeatures({
        manifest: caseManifest,
        operation: operation(writeA),
        assessments: {},
      })
    ).toMatchObject({
      status: 'unavailable',
      reason: 'missing-write-assessment',
      assessmentKeys: ['update-amount'],
      assessments: [],
    });

    const unknown = deriveOperationComplexityFeatures({
      manifest: caseManifest,
      operation: operation(writeA),
      assessments: { [writeA.key]: assessment(2, 0, 'unknown') },
    });
    expect(unknown).toMatchObject({
      status: 'unavailable',
      reason: 'assessment-workload-unknown',
      assessments: [
        {
          workloadStatus: 'unknown',
          workloadRows: { expected: null, lower: null, upper: null },
          dataWork: null,
        },
      ],
    });
  });
});
