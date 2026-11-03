import { z } from 'zod';
import { percentile } from '../runner/metrics';

export const TEA_BENCH_REPORT_SCHEMA_VERSION = 'tea-bench-report/2' as const;

const NonEmptyStringSchema = z.string().trim().min(1);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const FiniteNonNegativeSchema = z.number().finite().nonnegative();
const UnitSchema = z.enum(['ms', 'count', 'bytes', 'rows', 'ratio', 'percent']);

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

export const ReportIdsSchema = z
  .object({
    catalogueId: NonEmptyStringSchema,
    scenarioId: NonEmptyStringSchema,
    executionId: NonEmptyStringSchema,
  })
  .strict();

export const ReportScopeSchema = z
  .object({
    title: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    registry: z
      .object({
        kind: z.enum(['full-registry', 'selected']),
        scenarioIds: z.array(NonEmptyStringSchema),
        scenarios: z
          .array(
            z
              .object({
                scenarioId: NonEmptyStringSchema,
                ruleId: NonEmptyStringSchema,
                title: NonEmptyStringSchema,
                description: NonEmptyStringSchema,
                profile: JsonValueSchema,
                workload: JsonValueSchema,
                fixture: JsonValueSchema,
                oracle: JsonValueSchema,
                executionStatus: NonEmptyStringSchema,
              })
              .strict()
          )
          .optional(),
      })
      .strict(),
    configured: z
      .object({
        scenarioIds: z.array(NonEmptyStringSchema),
        description: NonEmptyStringSchema,
      })
      .strict(),
    included: z.array(NonEmptyStringSchema),
    exclusions: z.array(
      z
        .object({
          subject: NonEmptyStringSchema,
          reason: NonEmptyStringSchema,
        })
        .strict()
    ),
  })
  .strict();

const ReproducibleCommandSchema = z
  .object({
    label: NonEmptyStringSchema,
    argv: z.array(z.string().min(1)).min(1),
    cwd: NonEmptyStringSchema.optional(),
  })
  .strict();

export const ReportProvenanceSchema = z
  .object({
    commit: z
      .object({
        sha: z
          .string()
          .regex(/^[0-9a-f]{7,64}$/i)
          .nullable(),
        shaMissingReason: NonEmptyStringSchema.optional(),
        dirty: z.boolean().nullable(),
        dirtyReason: NonEmptyStringSchema.optional(),
      })
      .strict()
      .superRefine((commit, context) => {
        if (commit.sha === null && commit.shaMissingReason == null) {
          context.addIssue({
            code: 'custom',
            path: ['shaMissingReason'],
            message: 'commit SHA 未知时必须说明原因',
          });
        }
        if (commit.dirty === null && commit.dirtyReason == null) {
          context.addIssue({
            code: 'custom',
            path: ['dirtyReason'],
            message: 'dirty 未知时必须说明原因',
          });
        }
      }),
    toolVersions: z.record(NonEmptyStringSchema, NonEmptyStringSchema),
    backend: z
      .object({
        kind: NonEmptyStringSchema,
        version: NonEmptyStringSchema,
        configuration: z.record(z.string(), JsonValueSchema).optional(),
      })
      .strict(),
    postgres: z
      .object({
        version: NonEmptyStringSchema,
        extensions: z.array(NonEmptyStringSchema).default([]),
      })
      .strict()
      .nullable(),
    host: z
      .object({
        os: NonEmptyStringSchema,
        arch: NonEmptyStringSchema,
        cpu: NonEmptyStringSchema,
        logicalCpuCount: z.number().int().positive(),
        memoryBytes: z.number().int().nonnegative(),
      })
      .strict(),
    seeds: z.record(NonEmptyStringSchema, z.number().int()),
    dataHash: Sha256Schema.nullable(),
    fixtureHash: Sha256Schema.nullable(),
    hashMissingReason: NonEmptyStringSchema.optional(),
    reproducibility: z
      .object({
        state: z.enum(['clean', 'dirty', 'unknown']),
        immutable: z.boolean(),
        commands: z.array(ReproducibleCommandSchema).min(1),
        environment: z.record(NonEmptyStringSchema, z.string()),
        inputs: z.array(
          z
            .object({
              path: NonEmptyStringSchema,
              sha256: Sha256Schema,
            })
            .strict()
        ),
      })
      .strict(),
  })
  .strict()
  .superRefine((provenance, context) => {
    const expectedState =
      provenance.commit.dirty === false
        ? 'clean'
        : provenance.commit.dirty === true
          ? 'dirty'
          : 'unknown';
    if (provenance.reproducibility.state !== expectedState) {
      context.addIssue({
        code: 'custom',
        path: ['reproducibility', 'state'],
        message: 'reproducibility.state 必须与 commit.dirty 一致',
      });
    }
    const hashesKnown =
      provenance.commit.sha !== null &&
      provenance.dataHash !== null &&
      provenance.fixtureHash !== null;
    if (!hashesKnown && provenance.hashMissingReason == null) {
      context.addIssue({
        code: 'custom',
        path: ['hashMissingReason'],
        message: '哈希未知时必须说明原因',
      });
    }
    if (provenance.reproducibility.immutable && (expectedState !== 'clean' || !hashesKnown)) {
      context.addIssue({
        code: 'custom',
        path: ['reproducibility', 'immutable'],
        message: '只有干净提交且 dataHash、fixtureHash 已知时才能声明 immutable',
      });
    }
  });

const CatalogueGapSchema = z
  .object({
    scenarioId: NonEmptyStringSchema.optional(),
    kind: z.enum(['not-applicable', 'not-planned', 'not-executed', 'skipped', 'unsupported']),
    reason: NonEmptyStringSchema,
  })
  .strict();

const CoverageItemReceiptSchema = z
  .object({
    id: NonEmptyStringSchema,
    requiredCheckIds: z.array(NonEmptyStringSchema).default([]).optional(),
    planned: z.boolean(),
    executed: z.boolean(),
    status: z.enum(['pass', 'fail', 'skipped', 'unsupported', 'not-executed']),
    reason: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.executed && !receipt.planned) {
      context.addIssue({
        code: 'custom',
        path: ['executed'],
        message: '未计划的覆盖项不能标记为已执行',
      });
    }
    if (!receipt.executed && receipt.status === 'pass') {
      context.addIssue({ code: 'custom', path: ['status'], message: '未执行的覆盖项不能标记通过' });
    }
    if (!receipt.executed && receipt.reason == null) {
      context.addIssue({ code: 'custom', path: ['reason'], message: '未执行的覆盖项必须说明原因' });
    }
  });

const CoverageDimensionReceiptsSchema = z
  .object({
    plannedCount: z.number().int().nonnegative(),
    executedCount: z.number().int().nonnegative(),
    receipts: z.array(CoverageItemReceiptSchema),
  })
  .strict()
  .superRefine((dimension, context) => {
    const plannedCount = dimension.receipts.filter((receipt) => receipt.planned).length;
    const executedCount = dimension.receipts.filter((receipt) => receipt.executed).length;
    if (dimension.plannedCount !== plannedCount) {
      context.addIssue({
        code: 'custom',
        path: ['plannedCount'],
        message: 'plannedCount 必须由 receipts 派生',
      });
    }
    if (dimension.executedCount !== executedCount) {
      context.addIssue({
        code: 'custom',
        path: ['executedCount'],
        message: 'executedCount 必须由 receipts 派生',
      });
    }
  });

const SuiteCoverageReceiptSchema = z
  .object({
    receiptId: NonEmptyStringSchema,
    suiteId: NonEmptyStringSchema,
    scenarioId: NonEmptyStringSchema,
    executionRef: z
      .object({
        executionId: NonEmptyStringSchema,
        scenarioId: NonEmptyStringSchema,
        runId: NonEmptyStringSchema,
      })
      .strict()
      .nullable(),
    applicable: z.boolean(),
    planned: z.boolean(),
    execution: z.enum(['pass', 'fail', 'not-executed', 'skipped', 'unsupported']),
    reason: NonEmptyStringSchema.optional(),
    rules: CoverageDimensionReceiptsSchema,
    sources: CoverageDimensionReceiptsSchema,
    edges: CoverageDimensionReceiptsSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      (receipt.execution === 'pass' || receipt.execution === 'fail') &&
      receipt.executionRef === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['executionRef'],
        message: '已执行的 suite receipt 必须引用 execution',
      });
    }
    if (receipt.planned && !receipt.applicable) {
      context.addIssue({ code: 'custom', path: ['planned'], message: '不适用场景不能进入计划' });
    }
    if (!receipt.planned && (receipt.execution === 'pass' || receipt.execution === 'fail')) {
      context.addIssue({
        code: 'custom',
        path: ['execution'],
        message: '未计划场景不能有通过或失败状态',
      });
    }
    if (
      (!receipt.applicable || !receipt.planned || receipt.execution !== 'pass') &&
      receipt.reason == null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: '存在覆盖缺口或失败时必须说明原因',
      });
    }
  });

export const ReportCatalogueCoverageSchema = z
  .object({
    requested: z.number().int().nonnegative(),
    applicable: z.number().int().nonnegative(),
    planned: z.number().int().nonnegative(),
    executed: z.number().int().nonnegative(),
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
    suiteReceipts: z.array(SuiteCoverageReceiptSchema),
    gaps: z.array(CatalogueGapSchema),
  })
  .strict()
  .superRefine((coverage, context) => {
    const derived = {
      requested: coverage.suiteReceipts.length,
      applicable: coverage.suiteReceipts.filter((receipt) => receipt.applicable).length,
      planned: coverage.suiteReceipts.filter((receipt) => receipt.planned).length,
      executed: coverage.suiteReceipts.filter(
        (receipt) => receipt.execution === 'pass' || receipt.execution === 'fail'
      ).length,
      pass: coverage.suiteReceipts.filter((receipt) => receipt.execution === 'pass').length,
      fail: coverage.suiteReceipts.filter((receipt) => receipt.execution === 'fail').length,
      skipped: coverage.suiteReceipts.filter((receipt) => receipt.execution === 'skipped').length,
      unsupported: coverage.suiteReceipts.filter((receipt) => receipt.execution === 'unsupported')
        .length,
    };
    for (const field of Object.keys(derived) as Array<keyof typeof derived>) {
      if (coverage[field] !== derived[field]) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} 必须由可合并的 suiteReceipts 派生，不能单独填写`,
        });
      }
    }
    const receiptIds = coverage.suiteReceipts.map((receipt) => receipt.receiptId);
    if (new Set(receiptIds).size !== receiptIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['suiteReceipts'],
        message: 'receiptId 必须唯一，才能幂等合并',
      });
    }
  });

const PresentMetricSchema = z
  .object({
    value: FiniteNonNegativeSchema,
    unit: UnitSchema,
  })
  .strict();

const MissingMetricSchema = z
  .object({
    value: z.null(),
    unit: UnitSchema,
    missingReason: NonEmptyStringSchema,
  })
  .strict();

export const ReportMetricSchema = z.union([PresentMetricSchema, MissingMetricSchema]);

const PresentRawSamplesSchema = z
  .object({
    unit: UnitSchema,
    values: z.array(FiniteNonNegativeSchema).min(1),
  })
  .strict();

const MissingRawSamplesSchema = z
  .object({
    unit: UnitSchema,
    values: z.array(FiniteNonNegativeSchema).length(0),
    missingReason: NonEmptyStringSchema,
  })
  .strict();

export const ReportRawSamplesSchema = z.union([PresentRawSamplesSchema, MissingRawSamplesSchema]);

const OperationStatisticsSchema = z
  .object({
    min: ReportMetricSchema,
    p50: ReportMetricSchema,
    p95: ReportMetricSchema,
    p99: ReportMetricSchema,
    max: ReportMetricSchema,
    mean: ReportMetricSchema,
  })
  .strict();

const nearlyEqual = (left: number, right: number): boolean =>
  Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8;

export const ReportOperationSchema = z
  .object({
    operationId: NonEmptyStringSchema,
    key: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    kind: NonEmptyStringSchema,
    phase: z.enum(['setup', 'warmup', 'measurement', 'drain']),
    order: z.number().int().nonnegative(),
    attempted: z.number().int().nonnegative(),
    success: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    rawSamples: ReportRawSamplesSchema,
    statistics: OperationStatisticsSchema,
    work: z
      .object({
        rowsRead: z.number().int().nonnegative(),
        rowsWritten: z.number().int().nonnegative(),
        rowsReturned: z.number().int().nonnegative(),
        processed: z.number().int().nonnegative(),
      })
      .strict(),
    hybridSemantics: z
      .object({
        role: z.enum(['inline', 'flush', 'end-to-end']),
        includesInlineWork: z.boolean(),
        includesDrainWork: z.boolean(),
        description: NonEmptyStringSchema,
      })
      .strict(),
    warnings: z.array(NonEmptyStringSchema),
  })
  .strict()
  .superRefine((operation, context) => {
    if (operation.attempted !== operation.success + operation.errors) {
      context.addIssue({
        code: 'custom',
        path: ['attempted'],
        message: 'attempted 必须等于 success 与 errors 之和',
      });
    }
    if (operation.rawSamples.values.length !== operation.success) {
      context.addIssue({
        code: 'custom',
        path: ['rawSamples', 'values'],
        message: '原始样本数必须等于 success',
      });
    }

    const metrics = operation.statistics;
    const metricEntries = Object.entries(metrics) as Array<
      [keyof typeof metrics, (typeof metrics)[keyof typeof metrics]]
    >;
    for (const [name, metric] of metricEntries) {
      if (metric.unit !== operation.rawSamples.unit) {
        context.addIssue({
          code: 'custom',
          path: ['statistics', name, 'unit'],
          message: '统计量单位必须与原始样本一致',
        });
      }
    }

    const samples = operation.rawSamples.values;
    if (samples.length === 0) {
      for (const [name, metric] of metricEntries) {
        if (metric.value !== null) {
          context.addIssue({
            code: 'custom',
            path: ['statistics', name, 'value'],
            message: '没有原始样本时统计量必须为 null，并提供缺失原因',
          });
        }
      }
      return;
    }

    const sorted = [...samples].sort((left, right) => left - right);
    const expected: Record<keyof typeof metrics, number> = {
      min: sorted[0]!,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted[sorted.length - 1]!,
      mean: sorted.reduce((sum, sample) => sum + sample, 0) / sorted.length,
    };
    for (const [name, metric] of metricEntries) {
      if (metric.value === null || !nearlyEqual(metric.value, expected[name])) {
        context.addIssue({
          code: 'custom',
          path: ['statistics', name, 'value'],
          message: `${name} 必须直接由原始样本计算；百分位使用 nearest-rank，不能平均百分位`,
        });
      }
    }
  });

export const ReportMethodsSchema = z
  .object({
    percentiles: z
      .object({
        method: z.literal('nearest-rank'),
        formula: NonEmptyStringSchema,
        assumptions: z.array(NonEmptyStringSchema).min(1),
        averagedPercentiles: z.literal(false),
      })
      .strict(),
    pairedBootstrap: z
      .object({
        method: z.literal('paired-bootstrap'),
        formula: NonEmptyStringSchema,
        assumptions: z.array(NonEmptyStringSchema).min(1),
        pairBy: NonEmptyStringSchema,
        iterations: z.number().int().positive(),
        seed: z.number().int(),
        confidenceInterval: z
          .object({
            level: z.number().gt(0).lt(1),
            lowerQuantile: z.number().gte(0).lte(1),
            upperQuantile: z.number().gte(0).lte(1),
          })
          .strict()
          .refine((interval) => interval.lowerQuantile < interval.upperQuantile, {
            message: '置信区间下分位数必须小于上分位数',
          }),
        threshold: z
          .object({
            regressionRatio: z.number().finite().positive(),
            formula: NonEmptyStringSchema,
            rule: NonEmptyStringSchema,
          })
          .strict(),
      })
      .strict()
      .nullable(),
    pairedBootstrapMissingReason: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((methods, context) => {
    if (methods.pairedBootstrap === null && methods.pairedBootstrapMissingReason == null) {
      context.addIssue({
        code: 'custom',
        path: ['pairedBootstrapMissingReason'],
        message: '未执行配对 Bootstrap 时必须说明原因',
      });
    }
  });

export const ReportCorrectnessSchema = z
  .object({
    key: NonEmptyStringSchema,
    checkId: NonEmptyStringSchema,
    kind: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    table: NonEmptyStringSchema.nullable(),
    field: NonEmptyStringSchema.nullable(),
    expected: JsonValueSchema.nullable(),
    actual: JsonValueSchema.nullable(),
    tolerance: JsonValueSchema.nullable(),
    status: z.enum(['pass', 'fail', 'unknown', 'not-run', 'inconclusive']),
    unknownReason: NonEmptyStringSchema.optional(),
    obligationIds: z.array(NonEmptyStringSchema),
    rowsMatched: z.number().int().nonnegative().nullable(),
    method: NonEmptyStringSchema,
    message: NonEmptyStringSchema.optional(),
    details: JsonValueSchema.optional(),
    evidenceRefs: z.array(NonEmptyStringSchema),
  })
  .strict()
  .superRefine((check, context) => {
    if ((check.expected === null || check.actual === null) && check.unknownReason == null) {
      context.addIssue({
        code: 'custom',
        path: ['unknownReason'],
        message: '期望或实际结果未知时必须说明原因',
      });
    }
    if (check.expected === 'pass' && check.actual === 'pass') {
      context.addIssue({
        code: 'custom',
        path: ['expected'],
        message: '不能用 pass/pass 状态替代正确性证据',
      });
    }
  });

const ComparisonOperationSchema = z
  .object({
    operationId: NonEmptyStringSchema,
    ratio: ReportMetricSchema,
    ciLow: ReportMetricSchema,
    ciHigh: ReportMetricSchema,
    verdict: z.enum(['pass', 'fail', 'inconclusive']),
    reason: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((comparison, context) => {
    for (const field of ['ratio', 'ciLow', 'ciHigh'] as const) {
      if (comparison[field].unit !== 'ratio') {
        context.addIssue({
          code: 'custom',
          path: [field, 'unit'],
          message: '比较比率单位必须为 ratio',
        });
      }
    }
  });

export const ReportComparisonSchema = z
  .object({
    baselineIds: ReportIdsSchema,
    environmentCompatibility: z
      .object({
        status: z.enum(['compatible', 'incompatible', 'unknown']),
        differences: z.array(NonEmptyStringSchema),
      })
      .strict(),
    verdict: z.enum(['pass', 'fail', 'inconclusive']),
    operations: z.array(ComparisonOperationSchema),
    limitations: z.array(NonEmptyStringSchema),
  })
  .strict();

export const ReportConclusionSchema = z
  .object({
    conclusionId: NonEmptyStringSchema,
    kind: z.literal('evidence-derived'),
    statement: NonEmptyStringSchema,
    evidenceRefs: z.array(NonEmptyStringSchema).min(1),
    confidence: z.enum(['high', 'medium', 'low']),
    limitations: z.array(NonEmptyStringSchema),
  })
  .strict();

export const ReportArtifactSchema = z
  .object({
    artifactId: NonEmptyStringSchema,
    kind: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    sha256: Sha256Schema,
    mediaType: NonEmptyStringSchema,
    bytes: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ReportWarningSchema = z
  .object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
    severity: z.enum(['info', 'warning', 'error']),
  })
  .strict();

const ReportVerdictsSchema = z
  .object({
    oracle: z.enum(['pass', 'fail', 'not-run', 'inconclusive']),
    execution: z.enum(['pass', 'fail', 'skipped', 'unsupported']),
    performance: z.enum(['pass', 'fail', 'inconclusive', 'not-compared']),
  })
  .strict();

export const ReportExecutionSchema = z
  .object({
    executionId: NonEmptyStringSchema,
    scenarioId: NonEmptyStringSchema,
    caseId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    operations: z.array(ReportOperationSchema),
    correctness: z.array(ReportCorrectnessSchema),
    artifacts: z.array(ReportArtifactSchema),
    verdicts: ReportVerdictsSchema,
  })
  .strict()
  .superRefine((execution, context) => {
    for (const field of ['operations', 'correctness', 'artifacts'] as const) {
      const ids =
        field === 'operations'
          ? execution.operations.map((operation) => operation.operationId)
          : field === 'correctness'
            ? execution.correctness.map((check) => check.checkId)
            : execution.artifacts.map((artifact) => artifact.artifactId);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} ID 必须在 execution 内唯一`,
        });
      }
    }
    for (let index = 1; index < execution.operations.length; index += 1) {
      if (execution.operations[index - 1]!.order >= execution.operations[index]!.order) {
        context.addIssue({
          code: 'custom',
          path: ['operations', index, 'order'],
          message: '操作必须按实际 order 严格递增排列',
        });
      }
    }
  });

export const TeaBenchReportSchema = z
  .object({
    schema: z.literal(TEA_BENCH_REPORT_SCHEMA_VERSION),
    evidenceKind: z.enum(['observed', 'deterministic-test-data', 'legacy-unknown']),
    ids: ReportIdsSchema,
    scope: ReportScopeSchema,
    provenance: ReportProvenanceSchema,
    dataset: z
      .object({
        name: NonEmptyStringSchema,
        description: NonEmptyStringSchema,
        rowCounts: z.record(NonEmptyStringSchema, z.number().int().nonnegative()),
      })
      .strict(),
    runtime: z
      .object({
        startedAt: z.iso.datetime({ offset: true }),
        completedAt: z.iso.datetime({ offset: true }),
        durationMs: FiniteNonNegativeSchema,
        phaseEvents: z.array(
          z
            .object({
              executionId: NonEmptyStringSchema,
              order: z.number().int().nonnegative(),
              kind: z.enum(['setup', 'sample-setup', 'warmup', 'measurement', 'drain']),
              sampleIndex: z.number().int().nonnegative().optional(),
              operationId: NonEmptyStringSchema.optional(),
              description: NonEmptyStringSchema,
            })
            .strict()
        ),
        computationSemantics: z.literal('hybrid-inline-and-flush'),
        description: NonEmptyStringSchema,
      })
      .strict(),
    catalogue: ReportCatalogueCoverageSchema,
    executions: z.array(ReportExecutionSchema),
    methods: ReportMethodsSchema,
    verdicts: ReportVerdictsSchema,
    comparison: ReportComparisonSchema.nullable(),
    conclusions: z.array(ReportConclusionSchema),
    limitations: z.array(NonEmptyStringSchema),
    warnings: z.array(ReportWarningSchema),
  })
  .strict()
  .superRefine((report, context) => {
    const executionIds = report.executions.map((execution) => execution.executionId);
    if (new Set(executionIds).size !== executionIds.length) {
      context.addIssue({ code: 'custom', path: ['executions'], message: 'executionId 必须唯一' });
    }
    for (const [index, receipt] of report.catalogue.suiteReceipts.entries()) {
      if (
        receipt.executionRef !== null &&
        !report.executions.some(
          (execution) =>
            execution.executionId === receipt.executionRef?.executionId &&
            execution.scenarioId === receipt.executionRef?.scenarioId &&
            execution.runId === receipt.executionRef?.runId
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['catalogue', 'suiteReceipts', index, 'executionRef'],
          message: 'receipt 必须引用本报告实际列出的 execution',
        });
      }
    }
    for (const [index, event] of report.runtime.phaseEvents.entries()) {
      if (index > 0 && report.runtime.phaseEvents[index - 1]!.order >= event.order) {
        context.addIssue({
          code: 'custom',
          path: ['runtime', 'phaseEvents', index, 'order'],
          message: 'phaseEvents 必须按实际事件顺序严格递增',
        });
      }
      const execution = report.executions.find((item) => item.executionId === event.executionId);
      if (
        execution === undefined ||
        (event.operationId !== undefined &&
          !execution.operations.some((operation) => operation.operationId === event.operationId))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['runtime', 'phaseEvents', index],
          message: '阶段事件必须引用实际 execution 与 operation',
        });
      }
    }
    const evidenceIds = new Set(
      report.executions.flatMap((execution) => [
        execution.executionId,
        ...execution.operations.map((operation) => operation.operationId),
        ...execution.correctness.map((check) => check.checkId),
        ...execution.artifacts.map((artifact) => artifact.artifactId),
      ])
    );
    for (const [index, conclusion] of report.conclusions.entries()) {
      if (conclusion.evidenceRefs.some((reference) => !evidenceIds.has(reference))) {
        context.addIssue({
          code: 'custom',
          path: ['conclusions', index, 'evidenceRefs'],
          message: '结论必须引用本报告中存在的证据',
        });
      }
    }
    if (report.comparison === null && report.methods.pairedBootstrap !== null) {
      context.addIssue({
        code: 'custom',
        path: ['methods', 'pairedBootstrap'],
        message: '没有基线比较时不能声称执行了配对 Bootstrap',
      });
    }
  });

export type TeaBenchReport = z.infer<typeof TeaBenchReportSchema>;
export type ReportMetric = z.infer<typeof ReportMetricSchema>;

export const parseTeaBenchReport = (input: unknown): TeaBenchReport =>
  TeaBenchReportSchema.parse(input);
