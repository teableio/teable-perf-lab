import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import { parseTeaBenchReport, type JsonValue, type TeaBenchReport } from './schema';

export type TeableReportRow = Readonly<Record<string, JsonValue>>;
export type TeableReportRows = {
  readonly scenarioRows: ReadonlyArray<TeableReportRow>;
  readonly runRows: ReadonlyArray<TeableReportRow>;
  readonly operationRows: ReadonlyArray<TeableReportRow>;
  readonly correctnessRows: ReadonlyArray<TeableReportRow>;
  readonly artifactRows: ReadonlyArray<TeableReportRow>;
};

export const stableReportRowKey = (kind: string, identity: unknown): string =>
  `${kind}_${sha256Hex(canonicalJson({ kind, identity }))}`;

function scenarioRow(report: TeaBenchReport, scenarioId: string): TeableReportRow {
  const metadata = report.scope.registry.scenarios?.find(
    (scenario) => scenario.scenarioId === scenarioId
  );
  const receipts = report.catalogue.suiteReceipts.filter(
    (receipt) => receipt.scenarioId === scenarioId
  );
  const execution = report.executions.find((item) => item.scenarioId === scenarioId);
  return {
    rowKey: stableReportRowKey('scenario', { catalogueId: report.ids.catalogueId, scenarioId }),
    catalogueId: report.ids.catalogueId,
    scenarioId,
    ruleId: metadata?.ruleId ?? null,
    title: metadata?.title ?? scenarioId,
    description: metadata?.description ?? '场景元数据未随历史报告保存',
    profileJson: canonicalJson(metadata?.profile ?? null),
    workloadJson: canonicalJson(metadata?.workload ?? null),
    fixtureJson: canonicalJson(metadata?.fixture ?? null),
    oracleJson: canonicalJson(metadata?.oracle ?? null),
    catalogueStatus: metadata?.executionStatus ?? 'unknown',
    executionStatus: execution?.verdicts.execution ?? 'not-executed',
    oracleStatus: execution?.verdicts.oracle ?? 'not-executed',
    coverageReceiptsJson: canonicalJson(receipts),
    rawJson: canonicalJson({ metadata: metadata ?? null, receipts }),
  };
}
type Execution = TeaBenchReport['executions'][number];

function executionIdentity(report: TeaBenchReport, execution: Execution) {
  return {
    catalogueId: report.ids.catalogueId,
    scenarioId: execution.scenarioId,
    caseId: execution.caseId,
    executionId: execution.executionId,
    runId: execution.runId,
  };
}

function collectOperationRows(report: TeaBenchReport, execution: Execution): TeableReportRow[] {
  const identity = executionIdentity(report, execution);
  return execution.operations.map((operation) => {
    const row: Record<string, JsonValue> = {
      rowKey: stableReportRowKey('operation', { ...identity, operationId: operation.operationId }),
      ...identity,
      operationId: operation.operationId,
      key: operation.key,
      title: operation.title,
      kind: operation.kind,
      phase: operation.phase,
      order: operation.order,
      attempted: operation.attempted,
      success: operation.success,
      errors: operation.errors,
      sampleUnit: operation.rawSamples.unit,
      samplesJson: canonicalJson(operation.rawSamples.values),
      samplesMissingReason:
        'missingReason' in operation.rawSamples ? operation.rawSamples.missingReason : null,
      rowsRead: operation.work.rowsRead,
      rowsWritten: operation.work.rowsWritten,
      rowsReturned: operation.work.rowsReturned,
      processed: operation.work.processed,
      rawJson: canonicalJson(operation),
    };
    for (const [name, metric] of Object.entries(operation.statistics)) {
      row[name] = metric.value;
      row[`${name}Unit`] = metric.unit;
      row[`${name}MissingReason`] = 'missingReason' in metric ? metric.missingReason : null;
    }
    return row;
  });
}

function collectCorrectnessRows(report: TeaBenchReport, execution: Execution): TeableReportRow[] {
  const identity = executionIdentity(report, execution);
  return execution.correctness.map((check) => ({
    rowKey: stableReportRowKey('correctness', { ...identity, checkId: check.checkId }),
    ...identity,
    checkId: check.checkId,
    description: check.description,
    method: check.method,
    status: check.status,
    table: check.table,
    field: check.field,
    rowsMatched: check.rowsMatched,
    expectedJson: canonicalJson(check.expected),
    actualJson: canonicalJson(check.actual),
    toleranceJson: canonicalJson(check.tolerance),
    obligationIdsJson: canonicalJson(check.obligationIds),
    unknownReason: check.unknownReason ?? null,
    rawJson: canonicalJson(check),
  }));
}

function collectArtifactRows(report: TeaBenchReport, execution: Execution): TeableReportRow[] {
  const identity = executionIdentity(report, execution);
  return execution.artifacts.map((artifact) => ({
    rowKey: stableReportRowKey('artifact', { ...identity, artifactId: artifact.artifactId }),
    ...identity,
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    path: artifact.path,
    sha256: artifact.sha256,
    mediaType: artifact.mediaType,
    bytes: artifact.bytes ?? null,
    rawJson: canonicalJson(artifact),
  }));
}

export function exportTeaBenchReportRows(input: unknown): TeableReportRows {
  const report = parseTeaBenchReport(input);
  const scenarioIds = [
    ...new Set(report.catalogue.suiteReceipts.map((receipt) => receipt.scenarioId)),
  ];
  const scenarioRows = scenarioIds.map((scenarioId) => scenarioRow(report, scenarioId));
  const runRows: TeableReportRow[] = [];
  const operationRows: TeableReportRow[] = [];
  const correctnessRows: TeableReportRow[] = [];
  const artifactRows: TeableReportRow[] = [];

  for (const execution of report.executions) {
    const identity = {
      catalogueId: report.ids.catalogueId,
      scenarioId: execution.scenarioId,
      executionId: execution.executionId,
      runId: execution.runId,
    };
    runRows.push({
      rowKey: stableReportRowKey('run', identity),
      ...identity,
      schema: report.schema,
      evidenceKind: report.evidenceKind,
      oracleVerdict: execution.verdicts.oracle,
      executionStatus: execution.verdicts.execution,
      performanceVerdict: execution.verdicts.performance,
      suiteDuration: report.runtime.durationMs,
      suiteDurationUnit: 'ms',
      executionDuration: null,
      executionDurationUnit: 'ms',
      executionDurationMissingReason: '当前报告只记录 suite 总时长，未收集单 execution 总时长',
      commitSha: report.provenance.commit.sha,
      commitDirty: report.provenance.commit.dirty,
      backendKind: report.provenance.backend.kind,
      dataHash: report.provenance.dataHash,
      fixtureHash: report.provenance.fixtureHash,
      provenanceJson: canonicalJson(report.provenance),
      methodsJson: canonicalJson(report.methods),
      comparisonJson: canonicalJson(report.comparison),
      executionRawJson: canonicalJson(execution),
      reportRawJson: canonicalJson(report),
    });
    operationRows.push(...collectOperationRows(report, execution));
    correctnessRows.push(...collectCorrectnessRows(report, execution));
    artifactRows.push(...collectArtifactRows(report, execution));
  }
  return { scenarioRows, runRows, operationRows, correctnessRows, artifactRows };
}
