import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseBenchCaseManifest, type BenchCaseManifest } from '../case/manifest';
import { materializeCatalogueScenario, type Scenario } from '../catalogue';
import {
  COMPLEXITY_BUDGET_MODEL_VERSION,
  MINIMUM_COMPLEXITY_SAMPLES_PER_POINT,
  type CalibratedComplexityBudgetModel,
} from '../ci/complexityBudgetModel';
import { deriveOperationComplexityFeatures } from '../ci/complexityFeatures';
import {
  BENCH_MEASUREMENT_PROTOCOL,
  readBenchMeasurementProtocol,
  runCase,
} from '../runner/BenchRunner';
import { percentile } from '../runner/metrics';
import { readTeaArchive } from '../tea/teaZip';
import { loadPinnedCalibrationArtifact } from './artifact';
import { evaluateComplexityCalibration, evaluateComplexityGate } from './evaluate';
import {
  COMPLEXITY_SERIES_DEFINITIONS,
  complexitySeriesBaseScenarios,
  createComplexitySeriesScenario,
} from './plan';
import {
  COMPLEXITY_CALIBRATION_SCHEMA,
  COMPLEXITY_GATE_SCHEMA,
  type ComplexityCalibrationArtifact,
  type ComplexityCalibrationSeriesResult,
  type ComplexityCalibrationRunInput,
  type ComplexityGateReport,
  type ComplexityGateSeriesResult,
  type ComplexityGateRunInput,
  type ComplexitySeriesDefinition,
  type ComplexitySeriesExecutionError,
  type ComplexitySeriesMeasurementProtocol,
  type ComplexitySeriesRole,
  type ComplexitySeriesSampleReceipt,
  type ComplexitySeriesSchemaSize,
} from './types';

function sampleCount(input: number | undefined): number {
  const samples = input ?? MINIMUM_COMPLEXITY_SAMPLES_PER_POINT;
  if (!Number.isInteger(samples) || samples < MINIMUM_COMPLEXITY_SAMPLES_PER_POINT) {
    throw new Error(
      `Complexity series requires at least ${MINIMUM_COMPLEXITY_SAMPLES_PER_POINT} measured samples per point`
    );
  }
  return samples;
}

/** Shared calibration/gate contract; samples exclude fresh full-workload warmup passes. */
export function complexitySeriesMeasurementProtocol(
  samplesPerPoint = MINIMUM_COMPLEXITY_SAMPLES_PER_POINT
): ComplexitySeriesMeasurementProtocol {
  return { ...BENCH_MEASUREMENT_PROTOCOL, samplesPerPoint, warmup: 1, repetitions: 1 };
}

function protocolMismatch(
  recorded: ComplexitySeriesMeasurementProtocol,
  current: ComplexitySeriesMeasurementProtocol
): string | undefined {
  for (const field of Object.keys(current) as (keyof ComplexitySeriesMeasurementProtocol)[]) {
    if (recorded[field] !== current[field]) {
      return `measurementProtocol.${field} mismatch: expected ${current[field]}, received ${recorded[field]}; recalibration required`;
    }
  }
  return undefined;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Materialized structure is not an object');
  }
  return value as Record<string, unknown>;
}

async function inspectSchemaSize(input: {
  readonly definition: ComplexitySeriesDefinition;
  readonly workUnits: number;
  readonly teaPath: string;
  readonly manifest: BenchCaseManifest;
}): Promise<ComplexitySeriesSchemaSize> {
  const archive = readTeaArchive(await readFile(input.teaPath));
  const structure = object(archive.structure);
  if (!Array.isArray(structure.tables)) throw new Error('Materialized structure has no tables');
  let fieldCount = 0;
  let computedFieldCount = 0;
  for (const rawTable of structure.tables) {
    const table = object(rawTable);
    if (!Array.isArray(table.fields)) throw new Error('Materialized table has no fields');
    fieldCount += table.fields.length;
    for (const rawField of table.fields) {
      const field = object(rawField);
      if (['formula', 'lookup', 'rollup', 'conditionalRollup'].includes(String(field.type))) {
        computedFieldCount += 1;
      }
    }
  }
  const manifest = input.manifest;
  const rowsByTable = { ...manifest.dataset.rows };
  return {
    tableCount: structure.tables.length,
    fieldCount,
    computedFieldCount,
    rowsByTable,
    totalRows: Object.values(rowsByTable).reduce((sum, rows) => sum + rows, 0),
    groundedDimension: {
      name: input.definition.dimension,
      workUnits: input.workUnits,
    },
  };
}
function assessmentEvidence(input: {
  readonly manifest: BenchCaseManifest;
  readonly operation: Parameters<typeof deriveOperationComplexityFeatures>[0]['operation'];
  readonly assessments: Parameters<typeof deriveOperationComplexityFeatures>[0]['assessments'];
}): {
  readonly association: ComplexitySeriesSampleReceipt['complexityAssociation'];
  readonly assessmentCount: number;
  readonly assessment: ComplexitySeriesSampleReceipt['complexityAssessment'];
} {
  const features = deriveOperationComplexityFeatures(input);
  const association =
    features.dimensions?.kind === 'flush-computed' ? features.dimensions.association : null;
  const assessment = features.assessments[0];
  if (
    features.status !== 'available' ||
    !association ||
    features.assessments.length !== 1 ||
    !assessment
  ) {
    return { association, assessmentCount: features.assessments.length, assessment: null };
  }
  return {
    association,
    assessmentCount: 1,
    assessment: {
      assessmentKey: assessment.assessmentKey,
      policyVersion: assessment.policyVersion,
      score: assessment.score,
      scoreSemantics: assessment.scoreSemantics,
      scoreProvenance: assessment.scoreProvenance,
      declaredChangeRate:
        assessment.simulation?.kind === 'workload-operation'
          ? (assessment.simulation.assumptions.changeRate ?? null)
          : null,
      components: { ...assessment.components },
      association,
      simulation: assessment.simulation,
      assumptions: { scoreMeaning: 'ranking-only', syntheticChangeRate: 'forbidden' },
    },
  };
}

async function executePoint(input: {
  readonly connectionString: string;
  readonly outDir: string;
  readonly samplesPerPoint: number;
  readonly source: Scenario;
  readonly definition: ComplexitySeriesDefinition;
  readonly role: ComplexitySeriesRole;
  readonly workUnits: number;
}): Promise<ComplexitySeriesSampleReceipt> {
  const scenario = createComplexitySeriesScenario(input);
  const materialized = await materializeCatalogueScenario({ scenario, outDir: input.outDir });
  const generated = materialized.cases[0];
  if (!generated) throw new Error(`Scenario ${scenario.scenarioId} produced no case`);
  const manifest = parseBenchCaseManifest(
    JSON.parse(await readFile(generated.manifestPath, 'utf8')) as unknown
  );
  const schemaSize = await inspectSchemaSize({
    definition: input.definition,
    workUnits: input.workUnits,
    teaPath: generated.teaPath,
    manifest,
  });
  const measurementProtocol = complexitySeriesMeasurementProtocol(input.samplesPerPoint);
  const declaredProtocol = {
    ...measurementProtocol,
    warmup: manifest.run.warmup,
    repetitions: manifest.run.repetitions,
  };
  const declaredMismatch = protocolMismatch(measurementProtocol, declaredProtocol);
  if (declaredMismatch) throw new Error(declaredMismatch);
  const run = await runCase({
    teaPath: generated.teaPath,
    manifestPath: generated.manifestPath,
    backendOverride: 'postgres',
    connectionString: input.connectionString,
    samples: measurementProtocol.samplesPerPoint,
    warmup: manifest.run.warmup,
    repetitions: manifest.run.repetitions,
  });
  const actualProtocol = {
    ...readBenchMeasurementProtocol(run),
    samplesPerPoint: run.samples,
    warmup: run.warmup,
    repetitions: run.repetitions.length,
  };
  const actualMismatch = protocolMismatch(actualProtocol, measurementProtocol);
  if (actualMismatch) throw new Error(actualMismatch);
  if (run.backend !== 'postgres') throw new Error('Complexity series did not use PostgreSQL');
  if (!run.environment.pgVersion) {
    throw new Error('PostgreSQL version provenance is missing from the benchmark run');
  }
  if (run.repetitions.some((repetition) => repetition.setup.totalRows !== schemaSize.totalRows)) {
    throw new Error('PostgreSQL seeded row count does not match the materialized schema receipt');
  }
  const operation = run.operations.find(
    (candidate) => candidate.key === input.definition.operationKey
  );
  const scoreEvidence = operation
    ? assessmentEvidence({ manifest, operation, assessments: run.complexity.assessments })
    : { association: null, assessmentCount: 0, assessment: null };
  return {
    role: input.role,
    ruleId: input.definition.ruleId,
    scenarioId: scenario.scenarioId,
    caseId: run.caseId,
    runId: run.runId,
    backend: 'postgres',
    measurementProtocol: actualProtocol,
    runProvenance: {
      commit: run.commit,
      node: run.environment.node,
      platform: run.environment.platform,
      arch: run.environment.arch,
      runtime: run.environment.runtime,
      postgresVersion: run.environment.pgVersion,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    },
    operationKey: input.definition.operationKey,
    operationFamily: input.definition.operationFamily,
    workUnits: input.workUnits,
    schemaSize,
    complexityAssociation: scoreEvidence.association,
    complexityAssessmentCount: scoreEvidence.assessmentCount,
    complexityAssessment: scoreEvidence.assessment,
    correctnessVerdict: run.correctnessVerdict ?? run.verdict,
    operationFound: operation !== undefined,
    operationErrors: operation?.errors ?? 0,
    sampleCount: operation?.samplesMs.length ?? 0,
    samplesMs: operation?.samplesMs ?? [],
    actualP95Ms: operation?.p95Ms ?? null,
  };
}

async function executeSafely(
  input: Parameters<typeof executePoint>[0]
): Promise<
  | { readonly status: 'measured'; readonly receipt: ComplexitySeriesSampleReceipt }
  | { readonly status: 'error'; readonly error: ComplexitySeriesExecutionError }
> {
  try {
    return { status: 'measured', receipt: await executePoint(input) };
  } catch (error) {
    return {
      status: 'error',
      error: {
        ruleId: input.definition.ruleId,
        role: input.role,
        workUnits: input.workUnits,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function calibrateComplexitySeries(
  input: ComplexityCalibrationRunInput
): Promise<ComplexityCalibrationArtifact> {
  const samplesPerPoint = sampleCount(input.samplesPerPoint);
  const bases = complexitySeriesBaseScenarios();
  const executionErrors: ComplexitySeriesExecutionError[] = [];
  const series: ComplexityCalibrationSeriesResult[] = [];
  await mkdir(input.outDir, { recursive: true });
  for (const definition of COMPLEXITY_SERIES_DEFINITIONS) {
    const source = bases.get(definition.ruleId)!;
    const requests = [
      ...definition.calibrationWorkUnits.map((workUnits) => ({
        role: 'calibration' as const,
        workUnits,
      })),
      { role: 'holdout' as const, workUnits: definition.holdoutWorkUnits },
    ];
    const receipts: ComplexitySeriesSampleReceipt[] = [];
    for (const request of requests) {
      const result = await executeSafely({
        connectionString: input.connectionString,
        outDir: join(input.outDir, definition.ruleId, `${request.role}-${request.workUnits}`),
        samplesPerPoint,
        source,
        definition,
        ...request,
      });
      if (result.status === 'measured') receipts.push(result.receipt);
      else executionErrors.push(result.error);
    }
    series.push(
      evaluateComplexityCalibration({
        definition,
        receipts,
        measurementProtocol: complexitySeriesMeasurementProtocol(samplesPerPoint),
        headroom: input.headroom,
        provenance: input.provenance,
        minimumSamplesPerPoint: samplesPerPoint,
      })
    );
  }
  const correctnessFailed = series.some((result) =>
    result.receipts.some((receipt) => receipt.correctnessVerdict === 'fail')
  );
  const allCalibrated = series.every((result) => result.calibration.status === 'calibrated');
  return {
    schema: COMPLEXITY_CALIBRATION_SCHEMA,
    mode: 'calibrate',
    backend: 'postgres',
    modelVersion: COMPLEXITY_BUDGET_MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    requestedSamplesPerPoint: samplesPerPoint,
    measurementProtocol: complexitySeriesMeasurementProtocol(samplesPerPoint),
    headroom: input.headroom,
    provenance: input.provenance,
    verdict: correctnessFailed ? 'fail' : allCalibrated ? 'pass' : 'inconclusive',
    executionErrors,
    series,
  };
}

function baselineModel(
  artifact: ComplexityCalibrationArtifact,
  definition: ComplexitySeriesDefinition
): CalibratedComplexityBudgetModel | null {
  const matches = artifact.series.filter(
    (entry) =>
      entry.ruleId === definition.ruleId &&
      entry.operationKey === definition.operationKey &&
      entry.operationFamily === definition.operationFamily &&
      entry.dimension === definition.dimension
  );
  const entry = matches[0];
  if (matches.length !== 1 || !entry || entry.calibration.status !== 'calibrated') return null;
  const model = entry.calibration.model;
  const requestedCalibrationMatches =
    entry.requestedWorkUnits.calibration.length === definition.calibrationWorkUnits.length &&
    entry.requestedWorkUnits.calibration.every(
      (workUnits, index) => workUnits === definition.calibrationWorkUnits[index]
    );
  const modelPointsMatch =
    model.points.length === definition.calibrationWorkUnits.length &&
    model.points.every((point) => definition.calibrationWorkUnits.includes(point.physicalValue));
  const holdoutMatches =
    entry.requestedWorkUnits.holdout === definition.holdoutWorkUnits &&
    model.validation.points.length === 1 &&
    model.validation.points[0]?.physicalValue === definition.holdoutWorkUnits;
  const provenanceMatches =
    model.provenance.source === artifact.provenance.source &&
    model.provenance.runner === artifact.provenance.runner &&
    model.provenance.calibratedAt === artifact.provenance.calibratedAt;
  const receiptMatches = (
    role: 'calibration' | 'holdout',
    workUnits: number,
    expectedP95Ms: number,
    expectedSampleCount: number,
    expectedScore: number
  ): boolean => {
    const receipts = entry.receipts.filter(
      (receipt) => receipt.role === role && receipt.workUnits === workUnits
    );
    const receipt = receipts[0];
    if (
      !receipt ||
      receipts.length !== 1 ||
      expectedSampleCount < MINIMUM_COMPLEXITY_SAMPLES_PER_POINT ||
      expectedSampleCount !==
        artifact.measurementProtocol.samplesPerPoint * artifact.measurementProtocol.repetitions ||
      receipt.samplesMs.length !== expectedSampleCount
    ) {
      return false;
    }
    const sampleP95Ms = percentile(
      [...receipt.samplesMs].sort((left, right) => left - right),
      0.95
    );
    return (
      receipt.ruleId === definition.ruleId &&
      receipt.operationKey === definition.operationKey &&
      receipt.operationFamily === definition.operationFamily &&
      receipt.schemaSize.groundedDimension.name === definition.dimension &&
      receipt.schemaSize.groundedDimension.workUnits === workUnits &&
      receipt.complexityAssessment?.score === expectedScore &&
      receipt.complexityAssessment.policyVersion === model.scorePolicyVersion &&
      receipt.complexityAssessment.components.dataWork !== null &&
      receipt.complexityAssessment.scoreSemantics === 'nullable-ranking-index' &&
      receipt.complexityAssessment.scoreProvenance?.kind === 'assumption-backed' &&
      receipt.complexityAssessment.declaredChangeRate !== null &&
      Number.isFinite(receipt.complexityAssessment.declaredChangeRate) &&
      receipt.complexityAssessment.declaredChangeRate >= 0 &&
      receipt.complexityAssessment.declaredChangeRate <= 1 &&
      receipt.complexityAssessment.declaredChangeRate ===
        model.points[0]?.scoreEvidence.declaredChangeRate &&
      receipt.complexityAssessment.scoreProvenance.declaredSource ===
        model.points[0]?.scoreEvidence.scoreProvenance?.declaredSource &&
      receipt.complexityAssessment.scoreProvenance.evidence ===
        model.points[0]?.scoreEvidence.scoreProvenance?.evidence &&
      receipt.complexityAssessment.association.linkedWriteKeys.length === 1 &&
      receipt.complexityAssessment.association.linkedWriteKeys[0] ===
        receipt.complexityAssessment.assessmentKey &&
      receipt.complexityAssessmentCount === 1 &&
      receipt.complexityAssociation?.linkedWriteKeys.length === 1 &&
      receipt.complexityAssociation.linkedWriteKeys[0] ===
        receipt.complexityAssessment.assessmentKey &&
      receipt.correctnessVerdict === 'pass' &&
      receipt.operationFound &&
      receipt.operationErrors === 0 &&
      receipt.sampleCount === expectedSampleCount &&
      receipt.samplesMs.length === expectedSampleCount &&
      receipt.actualP95Ms === expectedP95Ms &&
      sampleP95Ms === expectedP95Ms
    );
  };
  const calibrationReceiptsMatch = model.points.every((point) =>
    receiptMatches(
      'calibration',
      point.physicalValue,
      point.observedP95Ms,
      point.sampleCount,
      point.score
    )
  );
  const holdoutPoint = model.validation.points[0];
  const holdoutReceiptMatches =
    holdoutPoint !== undefined &&
    receiptMatches(
      'holdout',
      holdoutPoint.physicalValue,
      holdoutPoint.observedP95Ms,
      holdoutPoint.sampleCount,
      holdoutPoint.score
    );
  let envelope = 0;
  const envelopeMatches = model.points.every((point) => {
    envelope = Math.max(envelope, point.observedP95Ms);
    return point.boundedP95Ms === envelope;
  });
  const receiptCountMatches = entry.receipts.length === definition.calibrationWorkUnits.length + 1;
  const baselineRuntime = entry.receipts[0]?.runProvenance;
  const baselineRuntimeConsistent =
    baselineRuntime !== undefined &&
    entry.receipts.every(
      (receipt) =>
        receipt.runProvenance.node === baselineRuntime.node &&
        receipt.runProvenance.platform === baselineRuntime.platform &&
        receipt.runProvenance.arch === baselineRuntime.arch &&
        receipt.runProvenance.runtime === baselineRuntime.runtime &&
        receipt.runProvenance.postgresVersion === baselineRuntime.postgresVersion
    );
  return model.operationFamily === definition.operationFamily &&
    model.inputKind === 'actual-complexity-assessment-score' &&
    model.physicalDimension === definition.dimension &&
    model.headroom === artifact.headroom &&
    model.minimumSamplesPerPoint === artifact.requestedSamplesPerPoint &&
    requestedCalibrationMatches &&
    modelPointsMatch &&
    holdoutMatches &&
    calibrationReceiptsMatch &&
    holdoutReceiptMatches &&
    envelopeMatches &&
    receiptCountMatches &&
    baselineRuntimeConsistent &&
    provenanceMatches
    ? model
    : null;
}

function gateRuntimeMatchesBaseline(
  artifact: ComplexityCalibrationArtifact,
  definition: ComplexitySeriesDefinition,
  receipt: ComplexitySeriesSampleReceipt
): boolean {
  const series = artifact.series.find(
    (entry) =>
      entry.ruleId === definition.ruleId &&
      entry.operationKey === definition.operationKey &&
      entry.operationFamily === definition.operationFamily &&
      entry.dimension === definition.dimension
  );
  const baseline = series?.receipts[0]?.runProvenance;
  return (
    baseline !== undefined &&
    receipt.runProvenance.node === baseline.node &&
    receipt.runProvenance.platform === baseline.platform &&
    receipt.runProvenance.arch === baseline.arch &&
    receipt.runProvenance.runtime === baseline.runtime &&
    receipt.runProvenance.postgresVersion === baseline.postgresVersion
  );
}

async function baselineCompatibilityProblem(input: {
  readonly artifact: ComplexityCalibrationArtifact;
  readonly definition: ComplexitySeriesDefinition;
  readonly source: Scenario;
  readonly outDir: string;
  readonly samplesPerPoint: number;
}): Promise<ComplexitySeriesExecutionError | null> {
  const protocol = complexitySeriesMeasurementProtocol(input.samplesPerPoint);
  const mismatch = protocolMismatch(input.artifact.measurementProtocol, protocol);
  const entry = input.artifact.series.find((series) => series.ruleId === input.definition.ruleId);
  if (mismatch) {
    return {
      ruleId: input.definition.ruleId,
      role: 'gate',
      workUnits: input.definition.gateWorkUnits,
      message: mismatch,
    };
  }
  for (const receipt of entry?.receipts ?? []) {
    const message = await baselineReceiptMismatch({
      receipt,
      definition: input.definition,
      source: input.source,
      outDir: input.outDir,
      protocol,
    });
    if (message) {
      return {
        ruleId: input.definition.ruleId,
        role: receipt.role,
        workUnits: receipt.workUnits,
        message,
      };
    }
  }
  return null;
}

async function baselineReceiptMismatch(input: {
  readonly receipt: ComplexitySeriesSampleReceipt;
  readonly definition: ComplexitySeriesDefinition;
  readonly source: Scenario;
  readonly outDir: string;
  readonly protocol: ComplexitySeriesMeasurementProtocol;
}): Promise<string | null> {
  try {
    // Recreate each baseline point at its own dimension and role, never the gate size.
    const scenario = createComplexitySeriesScenario({
      source: input.source,
      definition: input.definition,
      role: input.receipt.role,
      workUnits: input.receipt.workUnits,
    });
    const materialized = await materializeCatalogueScenario({
      scenario,
      outDir: join(input.outDir, 'calibration-compatibility', input.definition.ruleId),
    });
    const generated = materialized.cases[0];
    if (!generated) throw new Error('Current baseline point produced no case');
    if (scenario.scenarioId !== input.receipt.scenarioId) {
      throw new Error(
        `scenarioId mismatch: expected ${scenario.scenarioId}, received ${input.receipt.scenarioId}; recalibration required`
      );
    }
    if (generated.caseId !== input.receipt.caseId) {
      throw new Error(
        `caseId mismatch: expected ${generated.caseId}, received ${input.receipt.caseId}; recalibration required`
      );
    }
    const manifest = parseBenchCaseManifest(
      JSON.parse(await readFile(generated.manifestPath, 'utf8')) as unknown
    );
    return (
      protocolMismatch(input.receipt.measurementProtocol, {
        ...input.protocol,
        warmup: manifest.run.warmup,
        repetitions: manifest.run.repetitions,
      }) ?? null
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function runGateDefinition(input: {
  readonly run: ComplexityGateRunInput;
  readonly artifact: ComplexityCalibrationArtifact;
  readonly definition: ComplexitySeriesDefinition;
  readonly source: Scenario;
  readonly samplesPerPoint: number;
}): Promise<{
  readonly series: ComplexityGateSeriesResult;
  readonly executionError: ComplexitySeriesExecutionError | null;
}> {
  const model = baselineModel(input.artifact, input.definition);
  const compatibilityProblem =
    model === null
      ? null
      : await baselineCompatibilityProblem({
          ...input,
          outDir: input.run.outDir,
        });
  if (model === null || compatibilityProblem) {
    return {
      series: evaluateComplexityGate({
        definition: input.definition,
        measurementProtocol: complexitySeriesMeasurementProtocol(input.samplesPerPoint),
        receipt: null,
        model: null,
        modelUnavailableReason: 'calibration-artifact-invalid',
        minimumSamplesPerPoint: input.samplesPerPoint,
      }),
      executionError: compatibilityProblem,
    };
  }
  if (input.artifact.provenance.runner !== input.run.runner) {
    return {
      series: evaluateComplexityGate({
        definition: input.definition,
        measurementProtocol: complexitySeriesMeasurementProtocol(input.samplesPerPoint),
        receipt: null,
        model,
        blockingReason: 'incompatible-runner',
        minimumSamplesPerPoint: input.samplesPerPoint,
      }),
      executionError: null,
    };
  }
  const result = await executeSafely({
    connectionString: input.run.connectionString,
    outDir: join(
      input.run.outDir,
      input.definition.ruleId,
      `gate-${input.definition.gateWorkUnits}`
    ),
    samplesPerPoint: input.samplesPerPoint,
    source: input.source,
    definition: input.definition,
    role: 'gate',
    workUnits: input.definition.gateWorkUnits,
  });
  if (result.status === 'error') {
    return {
      series: evaluateComplexityGate({
        definition: input.definition,
        measurementProtocol: complexitySeriesMeasurementProtocol(input.samplesPerPoint),
        receipt: null,
        model,
        minimumSamplesPerPoint: input.samplesPerPoint,
      }),
      executionError: result.error,
    };
  }
  const runtimeMatches = gateRuntimeMatchesBaseline(
    input.artifact,
    input.definition,
    result.receipt
  );
  return {
    series: evaluateComplexityGate({
      definition: input.definition,
      measurementProtocol: complexitySeriesMeasurementProtocol(input.samplesPerPoint),
      receipt: result.receipt,
      model,
      ...(runtimeMatches ? {} : { blockingReason: 'incompatible-runner' as const }),
      minimumSamplesPerPoint: input.samplesPerPoint,
    }),
    executionError: null,
  };
}

export async function gateComplexitySeries(
  input: ComplexityGateRunInput
): Promise<ComplexityGateReport> {
  const samplesPerPoint = sampleCount(input.samplesPerPoint);
  const loaded = await loadPinnedCalibrationArtifact({
    path: input.calibrationArtifactPath,
    expectedSha256: input.expectedCalibrationSha256,
  });
  const generatedAt = new Date().toISOString();
  if (loaded.status === 'unknown') {
    return {
      schema: COMPLEXITY_GATE_SCHEMA,
      mode: 'gate',
      backend: 'postgres',
      modelVersion: COMPLEXITY_BUDGET_MODEL_VERSION,
      generatedAt,
      runner: input.runner,
      requestedSamplesPerPoint: samplesPerPoint,
      measurementProtocol: complexitySeriesMeasurementProtocol(samplesPerPoint),
      calibrationEvidence: {
        status: 'unknown',
        path: input.calibrationArtifactPath,
        sha256: loaded.sha256,
        expectedSha256: input.expectedCalibrationSha256,
        reason: loaded.reason,
        ...(loaded.message ? { message: loaded.message } : {}),
      },
      verdict: 'inconclusive',
      executionErrors: [],
      series: COMPLEXITY_SERIES_DEFINITIONS.map((definition) =>
        evaluateComplexityGate({
          definition,
          measurementProtocol: complexitySeriesMeasurementProtocol(samplesPerPoint),
          receipt: null,
          model: null,
          modelUnavailableReason: loaded.reason,
          minimumSamplesPerPoint: samplesPerPoint,
        })
      ),
    };
  }
  const bases = complexitySeriesBaseScenarios();
  await mkdir(input.outDir, { recursive: true });

  const executionErrors: ComplexitySeriesExecutionError[] = [];
  const series: ComplexityGateSeriesResult[] = [];
  for (const definition of COMPLEXITY_SERIES_DEFINITIONS) {
    const result = await runGateDefinition({
      run: input,
      artifact: loaded.artifact,
      definition,
      source: bases.get(definition.ruleId)!,
      samplesPerPoint,
    });
    series.push(result.series);
    if (result.executionError) executionErrors.push(result.executionError);
  }
  const hasFailure = series.some(
    (result) => result.gate.verdict === 'fail' || result.receipt?.correctnessVerdict === 'fail'
  );
  const allPassed = series.every((result) => result.gate.verdict === 'pass');
  return {
    schema: COMPLEXITY_GATE_SCHEMA,
    mode: 'gate',
    backend: 'postgres',
    modelVersion: COMPLEXITY_BUDGET_MODEL_VERSION,
    generatedAt,
    runner: input.runner,
    requestedSamplesPerPoint: samplesPerPoint,
    measurementProtocol: complexitySeriesMeasurementProtocol(samplesPerPoint),
    calibrationEvidence: {
      status: 'loaded',
      path: input.calibrationArtifactPath,
      sha256: loaded.sha256,
      expectedSha256: input.expectedCalibrationSha256,
      provenance: loaded.artifact.provenance,
      generatedAt: loaded.artifact.generatedAt,
    },
    verdict: hasFailure ? 'fail' : allPassed ? 'pass' : 'inconclusive',
    executionErrors,
    series,
  };
}
