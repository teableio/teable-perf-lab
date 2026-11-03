import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import type { BenchOracleCheckReceipt } from '../oracle/types';
import type { BenchOperationMeasurement, BenchRunReport } from '../runner/BenchRunner';
import { mergeReportSuiteReceipts, type ReportSuiteReceipt } from './coverage';
import { createReportIds } from './ids';
import {
  JsonValueSchema,
  TEA_BENCH_REPORT_SCHEMA_VERSION,
  TeaBenchReportSchema,
  type JsonValue,
  type TeaBenchReport,
} from './schema';

type Scope = TeaBenchReport['scope'];
type Artifact = TeaBenchReport['executions'][number]['artifacts'][number];
type Conclusion = TeaBenchReport['conclusions'][number];
type ReproducibleCommand = TeaBenchReport['provenance']['reproducibility']['commands'][number];
type ReproducibleInput = TeaBenchReport['provenance']['reproducibility']['inputs'][number];

type ProvenanceInput = {
  readonly commitDirty: boolean | null;
  readonly commitDirtyReason?: string;
  readonly dataHash: string | null;
  readonly fixtureHash: string | null;
  readonly hashMissingReason?: string;
  readonly toolVersions: Readonly<Record<string, string>>;
  readonly backend: TeaBenchReport['provenance']['backend'];
  readonly postgres: TeaBenchReport['provenance']['postgres'];
  readonly host: TeaBenchReport['provenance']['host'];
  readonly reproducibility: {
    readonly commands: ReadonlyArray<ReproducibleCommand>;
    readonly environment: Readonly<Record<string, string>>;
    readonly inputs: ReadonlyArray<ReproducibleInput>;
  };
};

type SharedAdapterInput = ProvenanceInput & {
  /** Stable catalogue scenario identity; materialized caseId stays separate. */
  readonly scenarioId?: string;
  readonly mode: 'fresh' | 'legacy';
  /** Full registry/configuration scope, captured before execution. */
  readonly scope: Scope;
  /** Requested/applicable/planned receipts, captured before execution. */
  readonly suiteReceipts: ReadonlyArray<ReportSuiteReceipt>;
  readonly dataset: {
    readonly name: string;
    readonly description: string;
    readonly rowCounts: Readonly<Record<string, number>>;
  };
  readonly artifacts: ReadonlyArray<Artifact>;
  readonly oracleEvidenceRefs?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly performanceVerdict: TeaBenchReport['verdicts']['performance'];
  readonly limitations?: ReadonlyArray<string>;
  readonly conclusions?: ReadonlyArray<Conclusion>;
};

export type CreateTeaBenchReportFromRunInput = SharedAdapterInput;

const stableId = (prefix: string, identity: unknown): string =>
  `${prefix}_${sha256Hex(canonicalJson(identity))}`;

const asJson = (value: unknown): JsonValue | null => {
  const parsed = JsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const metric = (value: number | null, missingReason: string) =>
  value === null
    ? { value: null, unit: 'ms' as const, missingReason }
    : { value, unit: 'ms' as const };

const operationStatistics = (operation: BenchOperationMeasurement) => {
  const reason = 'operation has no successful raw samples';
  return {
    min: metric(operation.minMs, reason),
    p50: metric(operation.p50Ms, reason),
    p95: metric(operation.p95Ms, reason),
    p99: metric(operation.p99Ms, reason),
    max: metric(operation.maxMs, reason),
    mean: metric(operation.meanMs, reason),
  };
};
const missingCorrectnessDetails = (check: BenchOracleCheckReceipt): boolean =>
  typeof check.checkId !== 'string' ||
  typeof check.description !== 'string' ||
  typeof check.method !== 'string' ||
  !Array.isArray(check.obligationIds) ||
  ['expected', 'actual', 'tolerance', 'table', 'field', 'rowsMatched'].some(
    (field) => !Object.hasOwn(check, field)
  );

const correctnessJsonIsValid = (check: BenchOracleCheckReceipt): boolean =>
  [check.expected, check.actual, check.tolerance, check.details]
    .filter((value) => value !== undefined)
    .every((value) => JsonValueSchema.safeParse(value).success);

const correctnessReceipt = (
  check: BenchOracleCheckReceipt,
  index: number,
  mode: SharedAdapterInput['mode'],
  evidenceRefs: Readonly<Record<string, ReadonlyArray<string>>>,
  checkId: string
): TeaBenchReport['executions'][number]['correctness'][number] => {
  const expected = asJson(check.expected);
  const actual = asJson(check.actual);
  const tolerance = asJson(check.tolerance);
  const missingDetailedFields = missingCorrectnessDetails(check);
  if (mode === 'fresh' && missingDetailedFields) {
    throw new Error(`Fresh oracle receipt ${index} is missing detailed correctness fields.`);
  }
  if (mode === 'fresh' && !correctnessJsonIsValid(check)) {
    throw new Error(`Fresh oracle receipt ${index} contains non-JSON correctness evidence.`);
  }
  const unknownReason = missingDetailedFields
    ? mode === 'legacy'
      ? 'Legacy oracle receipt lacks detailed expected/actual evidence or metadata.'
      : 'Oracle receipt lacks required detailed evidence.'
    : undefined;
  const status =
    mode === 'legacy' && unknownReason !== undefined && check.status !== 'fail'
      ? 'unknown'
      : check.status;
  const details = asJson(check.details);
  return {
    key: check.key ?? `legacy-check-${index}`,
    checkId,
    kind: check.kind ?? 'legacy',
    description: check.description ?? 'Legacy oracle check (description unavailable)',
    table: check.table ?? null,
    field: check.field ?? null,
    expected,
    actual,
    tolerance,
    status,
    ...(unknownReason === undefined ? {} : { unknownReason }),
    obligationIds: Array.isArray(check.obligationIds) ? [...check.obligationIds] : [],
    rowsMatched: typeof check.rowsMatched === 'number' ? check.rowsMatched : null,
    method: check.method ?? 'legacy-unknown',
    ...(check.message === undefined ? {} : { message: check.message }),
    ...(details === null ? {} : { details }),
    evidenceRefs: [...(evidenceRefs[check.checkId] ?? evidenceRefs[check.key] ?? [])],
  };
};

const withExecutionReceipt = (
  receipt: ReportSuiteReceipt,
  report: BenchRunReport,
  executionId: string,
  scenarioId: string,
  passedObligations: ReadonlySet<string>,
  failedObligations: ReadonlySet<string>,
  unknownObligations: ReadonlySet<string>
): ReportSuiteReceipt => {
  if (receipt.scenarioId !== scenarioId || !receipt.applicable || !receipt.planned) return receipt;
  const checksById = new Map(report.oracle.checks.map((check) => [check.checkId, check]));
  const updateDimension = (dimension: ReportSuiteReceipt['rules']): ReportSuiteReceipt['rules'] => {
    const receipts = dimension.receipts.map((item) => {
      const requiredCheckIds = item.requiredCheckIds ?? [];
      const requiredChecks = requiredCheckIds.map((checkId) => checksById.get(checkId));
      const requiredComplete =
        requiredCheckIds.length === 0 || requiredChecks.every((check) => check?.status === 'pass');
      const requiredFailed = requiredChecks.some((check) => check?.status === 'fail');
      const passed =
        item.planned &&
        requiredComplete &&
        passedObligations.has(item.id) &&
        !failedObligations.has(item.id) &&
        !unknownObligations.has(item.id);
      const failed = item.planned && (failedObligations.has(item.id) || requiredFailed);
      const executed = passed || failed;
      const status = passed
        ? ('pass' as const)
        : failed
          ? ('fail' as const)
          : ('not-executed' as const);
      return executed
        ? {
            ...item,
            executed: true,
            status,
            ...(passed ? { reason: undefined } : { reason: 'Oracle 断言失败。' }),
          }
        : {
            ...item,
            executed: false,
            status,
            reason: item.reason ?? '必需的逐状态检查未全部出现并通过。',
          };
    });
    return {
      plannedCount: receipts.filter((item) => item.planned).length,
      executedCount: receipts.filter((item) => item.executed).length,
      receipts,
    };
  };
  const oraclePassed =
    report.oracle.status === 'pass' &&
    failedObligations.size === 0 &&
    unknownObligations.size === 0;
  const execution =
    oraclePassed &&
    report.errors.length === 0 &&
    !report.operations.some((operation) => operation.errors > 0)
      ? ('pass' as const)
      : ('fail' as const);
  return {
    ...receipt,
    execution,
    executionRef: { executionId, scenarioId, runId: report.runId },
    ...(execution === 'pass'
      ? { reason: undefined }
      : { reason: '操作或 oracle 断言未全部通过。' }),
    rules: updateDimension(receipt.rules),
    sources: updateDimension(receipt.sources),
    edges: updateDimension(receipt.edges),
  };
};

export function createTeaBenchReportFromRun(
  report: BenchRunReport,
  input: CreateTeaBenchReportFromRunInput
): TeaBenchReport {
  if (input.mode === 'fresh') {
    if (typeof input.commitDirty !== 'boolean')
      throw new Error('Fresh reports require explicit commit dirty state.');
    if (input.dataHash == null || input.fixtureHash == null) {
      throw new Error('Fresh reports require explicit data and fixture hashes.');
    }
  }
  if (report.commit === 'unknown' && input.mode === 'fresh') {
    throw new Error('A fresh report cannot be identified without a commit SHA.');
  }

  const generatedIds = createReportIds({
    catalogue: input.suiteReceipts
      .map(({ receiptId, suiteId, scenarioId, applicable, planned }) => ({
        receiptId,
        suiteId,
        scenarioId,
        applicable,
        planned,
      }))
      .sort((left, right) => left.receiptId.localeCompare(right.receiptId)),
    scenario: {
      caseId: report.caseId,
      specVersion: report.specVersion,
      generatorVersion: report.generatorVersion,
    },
    execution: { runId: report.runId, commit: report.commit },
  });
  const scenarioId = input.scenarioId ?? report.caseId;
  const ids = { ...generatedIds, scenarioId };
  const operations = report.operations.map((operation, order) => ({
    operationId: stableId('operation', { executionId: ids.executionId, order, key: operation.key }),
    key: operation.key,
    title: operation.key,
    kind: operation.kind,
    phase: operation.kind === 'flush-computed' ? ('drain' as const) : ('measurement' as const),
    order,
    attempted: operation.count + operation.errors,
    success: operation.count,
    errors: operation.errors,
    rawSamples:
      operation.samplesMs.length === 0
        ? {
            unit: 'ms' as const,
            values: [],
            missingReason: 'operation has no successful raw samples',
          }
        : { unit: 'ms' as const, values: [...operation.samplesMs] },
    statistics: operationStatistics(operation),
    work: {
      rowsRead: operation.rowsRead,
      rowsWritten: operation.rowsWritten,
      rowsReturned: operation.rowsReturned,
      processed: operation.processed,
    },
    hybridSemantics:
      operation.kind === 'flush-computed'
        ? {
            role: 'flush' as const,
            includesInlineWork: false,
            includesDrainWork: true,
            description: '显式排空待处理的计算任务。',
          }
        : {
            role: 'inline' as const,
            includesInlineWork: true,
            includesDrainWork: false,
            description: '只测量该操作及其内联计算工作。',
          },
    warnings: [...operation.warnings],
  }));
  const checkIds = new Set<string>();
  const correctness = report.oracle.checks.map((check, index) => {
    const sourceId = check.checkId ?? stableId('legacy-check', { key: check.key ?? null, index });
    const checkId = checkIds.has(sourceId)
      ? stableId('check', { executionId: ids.executionId, sourceId, index })
      : sourceId;
    checkIds.add(checkId);
    return correctnessReceipt(check, index, input.mode, input.oracleEvidenceRefs ?? {}, checkId);
  });
  const passedObligations = new Set<string>();
  const failedObligations = new Set<string>();
  const unknownObligations = new Set<string>();
  for (const check of correctness) {
    for (const obligationId of check.obligationIds) {
      if (check.status === 'pass') passedObligations.add(obligationId);
      else if (check.status === 'fail') failedObligations.add(obligationId);
      else unknownObligations.add(obligationId);
    }
  }
  const suiteReceipts = input.suiteReceipts.map((receipt) =>
    withExecutionReceipt(
      receipt,
      report,
      ids.executionId,
      scenarioId,
      passedObligations,
      failedObligations,
      unknownObligations
    )
  );
  const oracleVerdict = correctness.some((check) => check.status === 'fail')
    ? 'fail'
    : correctness.some((check) => check.status === 'unknown')
      ? 'inconclusive'
      : report.oracle.status;
  const executionVerdict =
    report.errors.length > 0 || report.operations.some((operation) => operation.errors > 0)
      ? 'fail'
      : 'pass';
  const verdicts = {
    oracle: oracleVerdict,
    execution: executionVerdict,
    performance: report.performanceVerdict ?? input.performanceVerdict,
  } as const;
  const started = Date.parse(report.startedAt);
  const completed = Date.parse(report.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    throw new Error('Run timestamps must be valid and completedAt must not precede startedAt.');
  }
  const phaseEvents: TeaBenchReport['runtime']['phaseEvents'] = [];
  let phaseOrder = 0;
  const hasSamplePhases = report.repetitions.some((repetition) =>
    repetition.phases.some((phase) => phase.kind === 'sample-setup')
  );
  if (hasSamplePhases) {
    for (const repetition of report.repetitions) {
      for (const phase of repetition.phases) {
        if (phase.kind === 'oracle') continue;
        if (phase.kind === 'measure') {
          for (const operation of operations) {
            phaseEvents.push({
              executionId: ids.executionId,
              order: phaseOrder++,
              kind: operation.phase,
              sampleIndex: phase.sampleIndex,
              operationId: operation.operationId,
              description: `重复 ${repetition.index} / 样本 ${phase.sampleIndex ?? 0}：${operation.phase === 'drain' ? '显式排空计算任务' : `测量操作 ${operation.key}`}。`,
            });
          }
        } else {
          phaseEvents.push({
            executionId: ids.executionId,
            order: phaseOrder++,
            kind: phase.kind,
            sampleIndex: phase.sampleIndex,
            description:
              phase.kind === 'warmup'
                ? '在随后关闭的独立运行时中预热；所有测量样本使用新的运行时。'
                : `样本 ${phase.sampleIndex ?? 0} 的独立运行时导入与播种；不计入操作耗时。`,
          });
        }
      }
    }
  } else {
    if (
      report.warmup > 0 &&
      report.repetitions.some((repetition) =>
        repetition.phases.some((phase) => phase.kind === 'warmup')
      )
    ) {
      phaseEvents.push({
        executionId: ids.executionId,
        order: phaseOrder++,
        kind: 'warmup',
        description: '历史 runner 记录的预热阶段。',
      });
    }
    for (const operation of operations) {
      phaseEvents.push({
        executionId: ids.executionId,
        order: phaseOrder++,
        kind: operation.phase,
        operationId: operation.operationId,
        description:
          operation.phase === 'drain' ? '显式排空计算任务。' : `测量操作 ${operation.key}。`,
      });
    }
  }

  return TeaBenchReportSchema.parse({
    schema: TEA_BENCH_REPORT_SCHEMA_VERSION,
    evidenceKind: input.mode === 'fresh' ? 'observed' : 'legacy-unknown',
    ids,
    scope: input.scope,
    provenance: {
      commit: {
        sha: report.commit === 'unknown' ? null : report.commit,
        ...(report.commit === 'unknown'
          ? { shaMissingReason: 'Legacy run did not capture a commit SHA.' }
          : {}),
        dirty: input.commitDirty,
        ...(input.commitDirty === null
          ? { dirtyReason: input.commitDirtyReason ?? 'Legacy run did not capture dirty state.' }
          : {}),
      },
      toolVersions: input.toolVersions,
      backend: input.backend,
      postgres: input.postgres,
      host: input.host,
      seeds: report.seed,
      dataHash: input.dataHash,
      fixtureHash: input.fixtureHash,
      ...(input.dataHash === null || input.fixtureHash === null
        ? {
            hashMissingReason:
              input.hashMissingReason ?? 'Legacy run did not capture input hashes.',
          }
        : {}),
      reproducibility: {
        state: input.commitDirty === null ? 'unknown' : input.commitDirty ? 'dirty' : 'clean',
        immutable:
          input.commitDirty === false &&
          input.dataHash !== null &&
          input.fixtureHash !== null &&
          input.reproducibility.inputs.length > 0,
        commands: input.reproducibility.commands,
        environment: input.reproducibility.environment,
        inputs: input.reproducibility.inputs,
      },
    },
    dataset: input.dataset,
    runtime: {
      startedAt: report.startedAt,
      completedAt: report.completedAt,
      durationMs: completed - started,
      phaseEvents,
      computationSemantics: 'hybrid-inline-and-flush',
      description: '实际 runner 操作顺序；flush-computed 操作记录为排空阶段。',
    },
    catalogue: mergeReportSuiteReceipts([suiteReceipts]),
    executions: [
      {
        executionId: ids.executionId,
        scenarioId,
        caseId: report.caseId,
        runId: report.runId,
        operations,
        correctness,
        artifacts: [...input.artifacts],
        verdicts,
      },
    ],
    methods: {
      percentiles: {
        method: 'nearest-rank',
        formula: 'sorted[ceil(p * n) - 1]',
        assumptions: ['Each raw sample is one successful workload execution.'],
        averagedPercentiles: false,
      },
      pairedBootstrap: null,
      pairedBootstrapMissingReason:
        'This adapter converts one run and performs no baseline comparison.',
    },
    verdicts,
    comparison: null,
    conclusions: input.conclusions ?? [],
    limitations: input.limitations ?? [],
    warnings: [
      ...report.warnings.map((message) => ({
        code: message,
        message,
        severity: 'warning' as const,
      })),
      ...report.errors.map((message) => ({
        code: 'bench.run.error',
        message,
        severity: 'error' as const,
      })),
    ],
  });
}
