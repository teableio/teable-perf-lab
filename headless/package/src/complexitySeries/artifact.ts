import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import {
  COMPLEXITY_BUDGET_MODEL_VERSION,
  MINIMUM_COMPLEXITY_SAMPLES_PER_POINT,
} from '../ci/complexityBudgetModel';
import { BENCH_MEASUREMENT_PROTOCOL } from '../runner/BenchRunner';
import {
  COMPLEXITY_CALIBRATION_SCHEMA,
  type ComplexityCalibrationArtifact,
  type ComplexitySeriesUnknownReason,
} from './types';

const NonEmpty = z.string().trim().min(1);
const PositiveFinite = z.number().finite().positive();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const RuleId = z.enum(['R-FORMULA-004', 'R-FORMULA-005', 'R-PROP-003']);
const Dimension = z.enum(['graphDepth', 'graphWidth', 'fanout']);
const MeasurementProtocol = z
  .object({
    version: z.literal(BENCH_MEASUREMENT_PROTOCOL.version),
    warmupStrategy: z.literal(BENCH_MEASUREMENT_PROTOCOL.warmupStrategy),
    timingScope: z.literal(BENCH_MEASUREMENT_PROTOCOL.timingScope),
    statistic: z.literal(BENCH_MEASUREMENT_PROTOCOL.statistic),
    samplesPerPoint: z.number().int().min(MINIMUM_COMPLEXITY_SAMPLES_PER_POINT),
    warmup: z.number().int().nonnegative(),
    repetitions: z.number().int().positive(),
  })
  .strict();
const UnknownReason = z.enum([
  'invalid-operation-family',
  'missing-complexity-score',
  'invalid-complexity-score',
  'invalid-elapsed-ms',
  'invalid-headroom',
  'invalid-minimum-samples',
  'invalid-provenance',
  'invalid-score-evidence',
  'incomparable-operation-family',
  'incompatible-score-policy',
  'incompatible-physical-dimension',
  'tied-complexity-scores',
  'insufficient-complexity-points',
  'insufficient-samples',
  'insufficient-holdout-points',
  'holdout-overlaps-calibration',
  'holdout-outside-calibrated-range',
  'holdout-validation-failed',
  'unsupported-extrapolation',
  'multiple-complexity-assessments',
  'missing-complexity-assessment',
  'incompatible-complexity-assessment',
  'correctness-failure',
  'correctness-inconclusive',
  'operation-not-found',
  'operation-errors',
  'receipt-mismatch',
  'calibration-artifact-missing',
  'calibration-artifact-invalid',
  'calibration-artifact-hash-mismatch',
  'calibration-model-missing',
  'incompatible-runner',
  'calibration-model-version-mismatch',
]);
const Provenance = z
  .object({ source: NonEmpty, runner: NonEmpty, calibratedAt: NonEmpty })
  .strict();
const ScoreComponents = z
  .object({
    structural: z.number().finite().nonnegative(),
    dataWork: z.number().finite().nonnegative(),
    risk: z.number().finite().nonnegative(),
  })
  .strict();
const ScoreProvenance = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('assumption-backed'),
      assumption: z.literal('changeRate'),
      source: z.literal('manifest.dimensions.complexityAssumptions.changeRateByOperation'),
      declaredSource: NonEmpty,
      evidence: NonEmpty,
    })
    .strict(),
  z
    .object({ kind: z.literal('incomplete-input'), missingAssumption: z.literal('changeRate') })
    .strict(),
  z.object({ kind: z.literal('schema-only') }).strict(),
]);
type ScoreProvenanceValue = z.infer<typeof ScoreProvenance>;
const sameScoreProvenance = (
  left: ScoreProvenanceValue,
  right: ScoreProvenanceValue | undefined
): boolean => {
  if (!right || left.kind !== right.kind) return false;
  if (left.kind !== 'assumption-backed' || right.kind !== 'assumption-backed') return true;
  return left.declaredSource === right.declaredSource && left.evidence === right.evidence;
};

const CalibrationPoint = z
  .object({
    score: z.number().finite().nonnegative(),
    physicalDimension: Dimension,
    physicalValue: PositiveFinite,
    scoreEvidence: z
      .object({
        policyVersion: NonEmpty,
        scoreSemantics: z.literal('nullable-ranking-index'),
        scoreProvenance: ScoreProvenance,
        declaredChangeRate: z.number().finite().min(0).max(1),
        components: ScoreComponents,
        assessmentKey: NonEmpty,
        association: z.literal('flush-preceding-write'),
      })
      .strict(),
    sampleCount: z.number().int().min(MINIMUM_COMPLEXITY_SAMPLES_PER_POINT),
    observedP95Ms: PositiveFinite,
    boundedP95Ms: PositiveFinite,
  })
  .strict();
const HoldoutPoint = z
  .object({
    score: z.number().finite().nonnegative(),
    physicalDimension: Dimension,
    physicalValue: PositiveFinite,
    sampleCount: z.number().int().min(MINIMUM_COMPLEXITY_SAMPLES_PER_POINT),
    observedP95Ms: PositiveFinite,
    predictedP95Ms: PositiveFinite,
    maxP95Ms: PositiveFinite,
    predictionErrorMs: z.number().finite(),
    observedToPredictedRatio: z.number().finite().positive(),
  })
  .strict();
const Model = z
  .object({
    modelVersion: z.literal(COMPLEXITY_BUDGET_MODEL_VERSION),
    inputKind: z.literal('actual-complexity-assessment-score'),
    operationFamily: NonEmpty,
    headroom: z.number().finite().min(1),
    headroomSelection: z.literal('preselected-before-independent-holdout'),
    minimumSamplesPerPoint: z.number().int().min(MINIMUM_COMPLEXITY_SAMPLES_PER_POINT),
    provenance: Provenance,
    scorePolicyVersion: NonEmpty,
    physicalDimension: Dimension,
    assumptions: z
      .object({
        scoreMeaning: z.literal('ranking-only'),
        interpolation: z.literal('empirical-p95-linear-with-monotone-envelope'),
        extrapolation: z.literal('forbidden'),
        syntheticChangeRate: z.literal('forbidden'),
      })
      .strict(),
    range: z
      .object({
        minimumScore: z.number().finite().nonnegative(),
        maximumScore: z.number().finite().nonnegative(),
      })
      .strict(),
    points: z.array(CalibrationPoint).min(2),
    validation: z
      .object({
        independentHoldout: z.literal(true),
        holdoutPointCount: z.number().int().positive(),
        holdoutSampleCount: z.number().int().min(MINIMUM_COMPLEXITY_SAMPLES_PER_POINT),
        maximumObservedToPredictedRatio: z.number().finite().nonnegative(),
        points: z.array(HoldoutPoint).min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((model, context) => {
    if (model.range.minimumScore >= model.range.maximumScore) {
      context.addIssue({
        code: 'custom',
        path: ['range'],
        message: 'Calibration score range is empty',
      });
    }
    if (
      model.points[0]?.score !== model.range.minimumScore ||
      model.points[model.points.length - 1]?.score !== model.range.maximumScore
    ) {
      context.addIssue({
        code: 'custom',
        path: ['range'],
        message: 'Calibration score range does not match empirical endpoints',
      });
    }
    if (model.validation.holdoutPointCount !== model.validation.points.length) {
      context.addIssue({
        code: 'custom',
        path: ['validation', 'holdoutPointCount'],
        message: 'Holdout point count does not match receipts',
      });
    }
    const holdoutSampleCount = model.validation.points.reduce(
      (sum, point) => sum + point.sampleCount,
      0
    );
    if (model.validation.holdoutSampleCount !== holdoutSampleCount) {
      context.addIssue({
        code: 'custom',
        path: ['validation', 'holdoutSampleCount'],
        message: 'Holdout sample count does not match receipts',
      });
    }
    if (
      model.validation.points.some(
        (point) =>
          point.observedP95Ms > point.maxP95Ms ||
          Math.abs(point.maxP95Ms - point.predictedP95Ms * model.headroom) > 1e-8 ||
          Math.abs(point.predictionErrorMs - (point.observedP95Ms - point.predictedP95Ms)) > 1e-8 ||
          Math.abs(point.observedToPredictedRatio - point.observedP95Ms / point.predictedP95Ms) >
            1e-8
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['validation', 'points'],
        message: 'Holdout exceeded its budget or contains inconsistent prediction evidence',
      });
    }
    for (const point of model.validation.points) {
      if (
        point.score <= model.range.minimumScore ||
        point.score >= model.range.maximumScore ||
        point.physicalDimension !== model.physicalDimension
      ) {
        context.addIssue({
          code: 'custom',
          path: ['validation', 'points'],
          message: 'Holdout score or physical dimension is outside the calibrated model',
        });
      }
    }
    if (
      model.points.some(
        (point, index) =>
          point.physicalDimension !== model.physicalDimension ||
          point.scoreEvidence.policyVersion !== model.scorePolicyVersion ||
          point.scoreEvidence.scoreSemantics !== 'nullable-ranking-index' ||
          point.scoreEvidence.scoreProvenance.kind !== 'assumption-backed' ||
          point.scoreEvidence.declaredChangeRate !==
            model.points[0]?.scoreEvidence.declaredChangeRate ||
          !sameScoreProvenance(
            point.scoreEvidence.scoreProvenance,
            model.points[0]?.scoreEvidence.scoreProvenance
          ) ||
          (index > 0 && point.score <= model.points[index - 1]!.score)
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['points'],
        message: 'Calibration scores must be unique, ordered, and compatible',
      });
    }
  });
const SchemaSize = z
  .object({
    tableCount: z.number().int().positive(),
    fieldCount: z.number().int().positive(),
    computedFieldCount: z.number().int().nonnegative(),
    rowsByTable: z.record(z.string().min(1), z.number().int().nonnegative()),
    totalRows: z.number().int().nonnegative(),
    groundedDimension: z.object({ name: Dimension, workUnits: PositiveFinite }).strict(),
  })
  .strict();
const AssessmentEvidence = z
  .object({
    assessmentKey: NonEmpty,
    policyVersion: NonEmpty,
    score: z.number().finite().nonnegative().nullable(),
    declaredChangeRate: z.number().finite().min(0).max(1).nullable(),
    scoreSemantics: z.literal('nullable-ranking-index'),
    scoreProvenance: ScoreProvenance.nullable(),
    components: z
      .object({
        structural: z.number().finite().nonnegative(),
        dataWork: z.number().finite().nonnegative().nullable(),
        risk: z.number().finite().nonnegative(),
      })
      .strict(),
    association: z
      .object({
        strategy: z.literal('writes-since-previous-flush'),
        linkedWriteKeys: z.array(NonEmpty),
      })
      .strict(),
    simulation: z.unknown(),
    assumptions: z
      .object({
        scoreMeaning: z.literal('ranking-only'),
        syntheticChangeRate: z.literal('forbidden'),
      })
      .strict(),
  })
  .strict();
const Receipt = z
  .object({
    role: z.enum(['calibration', 'holdout', 'gate']),
    ruleId: RuleId,
    scenarioId: NonEmpty,
    caseId: NonEmpty,
    runId: NonEmpty,
    backend: z.literal('postgres'),
    runProvenance: z
      .object({
        commit: NonEmpty,
        node: NonEmpty,
        platform: NonEmpty,
        arch: NonEmpty,
        runtime: NonEmpty,
        postgresVersion: NonEmpty,
        startedAt: NonEmpty,
        completedAt: NonEmpty,
      })
      .strict(),
    measurementProtocol: MeasurementProtocol,
    operationKey: NonEmpty,
    operationFamily: NonEmpty,
    workUnits: PositiveFinite,
    schemaSize: SchemaSize,
    complexityAssociation: z
      .object({
        strategy: z.literal('writes-since-previous-flush'),
        linkedWriteKeys: z.array(NonEmpty),
      })
      .strict()
      .nullable(),
    complexityAssessmentCount: z.number().int().nonnegative(),
    complexityAssessment: AssessmentEvidence.nullable(),
    correctnessVerdict: z.enum(['pass', 'fail', 'inconclusive']),
    operationFound: z.boolean(),
    operationErrors: z.number().int().nonnegative(),
    sampleCount: z.number().int().nonnegative(),
    samplesMs: z.array(PositiveFinite),
    actualP95Ms: PositiveFinite.nullable(),
  })
  .strict();
const Series = z
  .object({
    ruleId: RuleId,
    operationKey: NonEmpty,
    operationFamily: NonEmpty,
    dimension: Dimension,
    requestedWorkUnits: z
      .object({
        calibration: z.array(PositiveFinite).min(2),
        holdout: PositiveFinite,
      })
      .strict(),
    receipts: z.array(Receipt),
    calibration: z.discriminatedUnion('status', [
      z.object({ status: z.literal('calibrated'), model: Model }).strict(),
      z.object({ status: z.literal('unknown'), reason: UnknownReason, model: z.null() }).strict(),
    ]),
  })
  .strict();
const ExecutionError = z
  .object({
    ruleId: RuleId,
    role: z.enum(['calibration', 'holdout', 'gate']),
    workUnits: PositiveFinite,
    message: NonEmpty,
  })
  .strict();
const Artifact = z
  .object({
    schema: z.literal(COMPLEXITY_CALIBRATION_SCHEMA),
    mode: z.literal('calibrate'),
    backend: z.literal('postgres'),
    modelVersion: z.literal(COMPLEXITY_BUDGET_MODEL_VERSION),
    generatedAt: NonEmpty,
    requestedSamplesPerPoint: z.number().int().min(MINIMUM_COMPLEXITY_SAMPLES_PER_POINT),
    measurementProtocol: MeasurementProtocol,
    headroom: z.number().finite().min(1),
    provenance: Provenance,
    verdict: z.enum(['pass', 'fail', 'inconclusive']),
    executionErrors: z.array(ExecutionError),
    series: z.array(Series).length(3),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.requestedSamplesPerPoint !== artifact.measurementProtocol.samplesPerPoint) {
      context.addIssue({
        code: 'custom',
        path: ['measurementProtocol', 'samplesPerPoint'],
        message: 'measurementProtocol.samplesPerPoint must match requestedSamplesPerPoint',
      });
    }
    for (const [seriesIndex, series] of artifact.series.entries()) {
      for (const [receiptIndex, receipt] of series.receipts.entries()) {
        for (const field of Object.keys(artifact.measurementProtocol) as Array<
          keyof typeof artifact.measurementProtocol
        >) {
          if (receipt.measurementProtocol[field] !== artifact.measurementProtocol[field]) {
            context.addIssue({
              code: 'custom',
              path: ['series', seriesIndex, 'receipts', receiptIndex, 'measurementProtocol', field],
              message: `receipt measurementProtocol.${field} must match the artifact protocol`,
            });
          }
        }
        const expectedSamples =
          artifact.measurementProtocol.samplesPerPoint * artifact.measurementProtocol.repetitions;
        if (
          receipt.sampleCount !== expectedSamples ||
          receipt.samplesMs.length !== expectedSamples
        ) {
          context.addIssue({
            code: 'custom',
            path: ['series', seriesIndex, 'receipts', receiptIndex, 'sampleCount'],
            message: `sampleCount must equal measurementProtocol.samplesPerPoint * measurementProtocol.repetitions (${expectedSamples})`,
          });
        }
      }
    }
  });

export type PinnedCalibrationLoad =
  | {
      readonly status: 'loaded';
      readonly artifact: ComplexityCalibrationArtifact;
      readonly sha256: string;
    }
  | {
      readonly status: 'unknown';
      readonly sha256: string | null;
      readonly reason: Extract<
        ComplexitySeriesUnknownReason,
        | 'calibration-artifact-missing'
        | 'calibration-artifact-invalid'
        | 'calibration-artifact-hash-mismatch'
      >;
      readonly message?: string;
    };

export async function loadPinnedCalibrationArtifact(input: {
  readonly path: string;
  readonly expectedSha256: string;
}): Promise<PinnedCalibrationLoad> {
  if (!Sha256.safeParse(input.expectedSha256).success) {
    return { status: 'unknown', sha256: null, reason: 'calibration-artifact-hash-mismatch' };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(input.path);
  } catch {
    return { status: 'unknown', sha256: null, reason: 'calibration-artifact-missing' };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== input.expectedSha256) {
    return { status: 'unknown', sha256, reason: 'calibration-artifact-hash-mismatch' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return { status: 'unknown', sha256, reason: 'calibration-artifact-invalid' };
  }
  const parsed = Artifact.safeParse(raw);
  if (!parsed.success) {
    const issue =
      parsed.error.issues.find((candidate) => candidate.path.includes('measurementProtocol')) ??
      parsed.error.issues[0];
    const path = issue?.path.join('.') || 'artifact';
    return {
      status: 'unknown',
      sha256,
      reason: 'calibration-artifact-invalid',
      message: `${path}: ${issue?.message ?? 'invalid calibration artifact'}`,
    };
  }
  if (parsed.data.verdict !== 'pass') {
    return {
      status: 'unknown',
      sha256,
      reason: 'calibration-artifact-invalid',
      message: 'verdict: expected pass calibration artifact',
    };
  }
  return {
    status: 'loaded',
    artifact: parsed.data as ComplexityCalibrationArtifact,
    sha256,
  };
}
