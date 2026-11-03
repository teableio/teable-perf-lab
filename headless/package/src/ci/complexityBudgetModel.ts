export const COMPLEXITY_BUDGET_MODEL_VERSION = 'tea-bench-complexity-score-budget/2' as const;
export const MINIMUM_COMPLEXITY_SAMPLES_PER_POINT = 20;

export type ComplexityScoreComponents = {
  readonly structural: number;
  readonly dataWork: number;
  readonly risk: number;
};
export type ComplexityScoreProvenance = {
  readonly kind: 'assumption-backed';
  readonly assumption: 'changeRate';
  readonly source: 'manifest.dimensions.complexityAssumptions.changeRateByOperation';
  readonly declaredSource: string;
  readonly evidence: string;
};

export type ComplexityScoreEvidence = {
  /** Actual nullable ranking score emitted by the complexity assessment. */
  readonly score: number | null;
  readonly policyVersion: string;
  readonly scoreSemantics: 'nullable-ranking-index';
  readonly scoreProvenance: ComplexityScoreProvenance | null;
  readonly declaredChangeRate: number;
  readonly components: ComplexityScoreComponents;
  readonly assessmentKey: string;
  readonly association: 'operation-write' | 'flush-preceding-write';
  readonly physicalDimension: string;
  readonly physicalValue: number;
};

export type ComplexityRunMeasurement = {
  /** Exact operation shape; measurements from different families are never comparable. */
  readonly operationFamily: string;
  readonly scoreEvidence: ComplexityScoreEvidence;
  /** Duration of one independent measured run. */
  readonly elapsedMs: number;
};

export type ComplexityBudgetProvenance = {
  readonly source: string;
  /** Stable description of the CI runner class used for every measurement. */
  readonly runner: string;
  readonly calibratedAt: string;
};

export type ComplexityCalibrationPoint = {
  readonly score: number;
  readonly physicalDimension: string;
  readonly physicalValue: number;
  readonly scoreEvidence: Omit<
    ComplexityScoreEvidence,
    'score' | 'physicalDimension' | 'physicalValue'
  >;
  readonly sampleCount: number;
  readonly observedP95Ms: number;
  /** Nondecreasing empirical envelope used for interpolation. */
  readonly boundedP95Ms: number;
};

export type ComplexityHoldoutValidationPoint = {
  readonly score: number;
  readonly physicalDimension: string;
  readonly physicalValue: number;
  readonly sampleCount: number;
  readonly observedP95Ms: number;
  readonly predictedP95Ms: number;
  readonly maxP95Ms: number;
  readonly predictionErrorMs: number;
  readonly observedToPredictedRatio: number;
};

export type CalibratedComplexityBudgetModel = {
  readonly modelVersion: typeof COMPLEXITY_BUDGET_MODEL_VERSION;
  readonly inputKind: 'actual-complexity-assessment-score';
  readonly operationFamily: string;
  /** Selected by the caller before the independent holdout is evaluated. */
  readonly headroom: number;
  readonly headroomSelection: 'preselected-before-independent-holdout';
  readonly minimumSamplesPerPoint: number;
  readonly provenance: ComplexityBudgetProvenance;
  readonly scorePolicyVersion: string;
  readonly physicalDimension: string;
  readonly assumptions: {
    readonly scoreMeaning: 'ranking-only';
    readonly interpolation: 'empirical-p95-linear-with-monotone-envelope';
    readonly extrapolation: 'forbidden';
    readonly syntheticChangeRate: 'forbidden';
  };
  readonly range: { readonly minimumScore: number; readonly maximumScore: number };
  readonly points: ReadonlyArray<ComplexityCalibrationPoint>;
  readonly validation: {
    readonly independentHoldout: true;
    readonly holdoutPointCount: number;
    readonly holdoutSampleCount: number;
    readonly maximumObservedToPredictedRatio: number;
    readonly points: ReadonlyArray<ComplexityHoldoutValidationPoint>;
  };
};

export type ComplexityBudgetInconclusiveReason =
  | 'invalid-operation-family'
  | 'missing-complexity-score'
  | 'invalid-complexity-score'
  | 'invalid-elapsed-ms'
  | 'invalid-headroom'
  | 'invalid-minimum-samples'
  | 'invalid-provenance'
  | 'invalid-score-evidence'
  | 'incomparable-operation-family'
  | 'incompatible-score-policy'
  | 'incompatible-physical-dimension'
  | 'tied-complexity-scores'
  | 'insufficient-complexity-points'
  | 'insufficient-samples'
  | 'insufficient-holdout-points'
  | 'holdout-overlaps-calibration'
  | 'holdout-outside-calibrated-range'
  | 'holdout-validation-failed'
  | 'unsupported-extrapolation';

export type ComplexityBudgetInconclusive = {
  readonly status: 'inconclusive';
  readonly reason: ComplexityBudgetInconclusiveReason;
};
export type ComplexityBudgetCalibrationResult =
  | { readonly status: 'calibrated'; readonly model: CalibratedComplexityBudgetModel }
  | ComplexityBudgetInconclusive;
export type ComplexityBudgetPrediction =
  | {
      readonly status: 'predicted';
      readonly operationFamily: string;
      readonly score: number;
      readonly empiricalP95Ms: number;
      readonly maxP95Ms: number;
      readonly lowerScore: number;
      readonly upperScore: number;
    }
  | ComplexityBudgetInconclusive;
export type ComplexityBudgetCalibrationInput = {
  readonly operationFamily: string;
  readonly calibrationRuns: ReadonlyArray<ComplexityRunMeasurement>;
  readonly holdoutRuns: ReadonlyArray<ComplexityRunMeasurement>;
  readonly headroom: number;
  readonly provenance: ComplexityBudgetProvenance;
  readonly minimumSamplesPerPoint?: number;
};
export type ComplexityBudgetPredictionInput = {
  readonly model: CalibratedComplexityBudgetModel;
  readonly operationFamily: string;
  readonly scoreEvidence: ComplexityScoreEvidence;
};

const inconclusive = (
  reason: ComplexityBudgetInconclusiveReason
): ComplexityBudgetInconclusive => ({
  status: 'inconclusive',
  reason,
});
const nonempty = (value: string): boolean => value.trim().length > 0;
const positiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0;
const validComponents = (value: ComplexityScoreComponents): boolean =>
  Number.isFinite(value.structural) &&
  value.structural >= 0 &&
  Number.isFinite(value.dataWork) &&
  value.dataWork >= 0 &&
  Number.isFinite(value.risk) &&
  value.risk >= 0;

const sameScoreEvidence = (
  left: ComplexityScoreEvidence,
  right: ComplexityScoreEvidence
): boolean =>
  left.score === right.score &&
  left.policyVersion === right.policyVersion &&
  left.scoreSemantics === right.scoreSemantics &&
  left.scoreProvenance?.kind === right.scoreProvenance?.kind &&
  left.scoreProvenance?.declaredSource === right.scoreProvenance?.declaredSource &&
  left.scoreProvenance?.evidence === right.scoreProvenance?.evidence &&
  left.declaredChangeRate === right.declaredChangeRate &&
  left.components.structural === right.components.structural &&
  left.components.dataWork === right.components.dataWork &&
  left.components.risk === right.components.risk &&
  left.assessmentKey === right.assessmentKey &&
  left.association === right.association &&
  left.physicalDimension === right.physicalDimension &&
  left.physicalValue === right.physicalValue;

type ScoreGroup = {
  evidence: ComplexityScoreEvidence;
  samples: number[];
};

const groupRuns = (runs: ReadonlyArray<ComplexityRunMeasurement>): Map<number, ScoreGroup> => {
  const groups = new Map<number, ScoreGroup>();
  for (const run of runs) {
    const score = run.scoreEvidence.score!;
    const group = groups.get(score);
    if (group) group.samples.push(run.elapsedMs);
    else groups.set(score, { evidence: run.scoreEvidence, samples: [run.elapsedMs] });
  }
  return groups;
};

const nearestRankP95 = (values: number[]): number => {
  values.sort((left, right) => left - right);
  return values[Math.ceil(values.length * 0.95) - 1]!;
};

const calibrationPoints = (
  groups: ReadonlyMap<number, ScoreGroup>
): ReadonlyArray<ComplexityCalibrationPoint> => {
  let envelope = 0;
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([score, group]) => {
      const observedP95Ms = nearestRankP95(group.samples);
      envelope = Math.max(envelope, observedP95Ms);
      const scoreEvidence = {
        policyVersion: group.evidence.policyVersion,
        scoreSemantics: group.evidence.scoreSemantics,
        scoreProvenance: group.evidence.scoreProvenance,
        declaredChangeRate: group.evidence.declaredChangeRate,
        components: group.evidence.components,
        assessmentKey: group.evidence.assessmentKey,
        association: group.evidence.association,
      };
      return {
        score,
        physicalDimension: group.evidence.physicalDimension,
        physicalValue: group.evidence.physicalValue,
        scoreEvidence,
        sampleCount: group.samples.length,
        observedP95Ms,
        boundedP95Ms: envelope,
      };
    });
};

type EmpiricalInterpolation = {
  readonly empiricalP95Ms: number;
  readonly lowerScore: number;
  readonly upperScore: number;
};
const interpolate = (
  points: ReadonlyArray<ComplexityCalibrationPoint>,
  score: number
): EmpiricalInterpolation | undefined => {
  const upperIndex = points.findIndex((point) => point.score >= score);
  if (upperIndex < 0) return undefined;
  const upper = points[upperIndex]!;
  if (upper.score === score) {
    return { empiricalP95Ms: upper.boundedP95Ms, lowerScore: score, upperScore: score };
  }
  if (upperIndex === 0) return undefined;
  const lower = points[upperIndex - 1]!;
  const position = (score - lower.score) / (upper.score - lower.score);
  return {
    empiricalP95Ms: lower.boundedP95Ms + position * (upper.boundedP95Ms - lower.boundedP95Ms),
    lowerScore: lower.score,
    upperScore: upper.score,
  };
};

function validScoreInputs(evidence: ComplexityScoreEvidence): boolean {
  return (
    nonempty(evidence.policyVersion) &&
    nonempty(evidence.assessmentKey) &&
    nonempty(evidence.physicalDimension) &&
    positiveFinite(evidence.physicalValue) &&
    validComponents(evidence.components) &&
    evidence.scoreSemantics === 'nullable-ranking-index' &&
    evidence.scoreProvenance?.kind === 'assumption-backed' &&
    nonempty(evidence.scoreProvenance.declaredSource) &&
    nonempty(evidence.scoreProvenance.evidence) &&
    Number.isFinite(evidence.declaredChangeRate) &&
    evidence.declaredChangeRate >= 0 &&
    evidence.declaredChangeRate <= 1
  );
}

function measurementProblem(
  run: ComplexityRunMeasurement,
  operationFamily: string
): ComplexityBudgetInconclusiveReason | undefined {
  if (run.operationFamily !== operationFamily) return 'incomparable-operation-family';
  if (run.scoreEvidence.score === null) return 'missing-complexity-score';
  if (!Number.isFinite(run.scoreEvidence.score) || run.scoreEvidence.score < 0) {
    return 'invalid-complexity-score';
  }
  if (!positiveFinite(run.elapsedMs)) return 'invalid-elapsed-ms';
  if (!validScoreInputs(run.scoreEvidence)) return 'invalid-score-evidence';
  return undefined;
}

function repeatedScoreProblem(
  evidence: ComplexityScoreEvidence,
  priorEvidence: ComplexityScoreEvidence | undefined
): ComplexityBudgetInconclusiveReason | undefined {
  if (!priorEvidence) return undefined;
  if (
    priorEvidence.physicalDimension !== evidence.physicalDimension ||
    priorEvidence.physicalValue !== evidence.physicalValue
  ) {
    return 'tied-complexity-scores';
  }
  if (!sameScoreEvidence(priorEvidence, evidence)) return 'invalid-score-evidence';
  return undefined;
}

const invalidRunReason = (
  calibrationRuns: ReadonlyArray<ComplexityRunMeasurement>,
  holdoutRuns: ReadonlyArray<ComplexityRunMeasurement>,
  operationFamily: string
): ComplexityBudgetInconclusiveReason | undefined => {
  const evidenceByScore = new Map<number, ComplexityScoreEvidence>();
  const runCount = calibrationRuns.length + holdoutRuns.length;
  for (let index = 0; index < runCount; index += 1) {
    const run =
      index < calibrationRuns.length
        ? calibrationRuns[index]!
        : holdoutRuns[index - calibrationRuns.length]!;
    const problem = measurementProblem(run, operationFamily);
    if (problem) return problem;
    const evidence = run.scoreEvidence;
    const score = evidence.score!;
    const repeatedProblem = repeatedScoreProblem(evidence, evidenceByScore.get(score));
    if (repeatedProblem) return repeatedProblem;
    evidenceByScore.set(score, evidence);
  }
  return undefined;
};

const compatibleEvidenceReason = (
  calibrationRuns: ReadonlyArray<ComplexityRunMeasurement>,
  holdoutRuns: ReadonlyArray<ComplexityRunMeasurement>
): ComplexityBudgetInconclusiveReason | undefined => {
  const first = calibrationRuns[0]?.scoreEvidence ?? holdoutRuns[0]?.scoreEvidence;
  if (!first) return undefined;
  const runCount = calibrationRuns.length + holdoutRuns.length;
  for (let index = 0; index < runCount; index += 1) {
    const run =
      index < calibrationRuns.length
        ? calibrationRuns[index]!
        : holdoutRuns[index - calibrationRuns.length]!;
    if (run.scoreEvidence.policyVersion !== first.policyVersion) return 'incompatible-score-policy';
    if (run.scoreEvidence.physicalDimension !== first.physicalDimension) {
      return 'incompatible-physical-dimension';
    }
    if (run.scoreEvidence.association !== first.association) return 'invalid-score-evidence';
    if (
      run.scoreEvidence.declaredChangeRate !== first.declaredChangeRate ||
      run.scoreEvidence.scoreProvenance?.declaredSource !== first.scoreProvenance?.declaredSource ||
      run.scoreEvidence.scoreProvenance?.evidence !== first.scoreProvenance?.evidence
    ) {
      return 'invalid-score-evidence';
    }
  }
  return undefined;
};

function calibrationConfigurationProblem(
  input: ComplexityBudgetCalibrationInput,
  minimumSamples: number
): ComplexityBudgetInconclusiveReason | undefined {
  if (!nonempty(input.operationFamily)) return 'invalid-operation-family';
  if (!Number.isFinite(input.headroom) || input.headroom < 1) return 'invalid-headroom';
  if (!Number.isInteger(minimumSamples) || minimumSamples < MINIMUM_COMPLEXITY_SAMPLES_PER_POINT) {
    return 'invalid-minimum-samples';
  }
  if (
    !nonempty(input.provenance.source) ||
    !nonempty(input.provenance.runner) ||
    !nonempty(input.provenance.calibratedAt)
  ) {
    return 'invalid-provenance';
  }
  return undefined;
}

function calibrationGroupsProblem(
  calibrationGroups: ReadonlyMap<number, ScoreGroup>,
  holdoutGroups: ReadonlyMap<number, ScoreGroup>,
  minimumSamples: number
): ComplexityBudgetInconclusiveReason | undefined {
  if (calibrationGroups.size < 2) return 'insufficient-complexity-points';
  if (holdoutGroups.size < 1) return 'insufficient-holdout-points';
  for (const group of calibrationGroups.values()) {
    if (group.samples.length < minimumSamples) return 'insufficient-samples';
  }
  for (const [score, group] of holdoutGroups) {
    if (group.samples.length < minimumSamples) return 'insufficient-samples';
    if (calibrationGroups.has(score)) return 'holdout-overlaps-calibration';
  }
  return undefined;
}

export function calibrateComplexityBudgetModel(
  input: ComplexityBudgetCalibrationInput
): ComplexityBudgetCalibrationResult {
  const minimumSamples = input.minimumSamplesPerPoint ?? MINIMUM_COMPLEXITY_SAMPLES_PER_POINT;
  const configurationProblem = calibrationConfigurationProblem(input, minimumSamples);
  if (configurationProblem) return inconclusive(configurationProblem);
  const runError =
    invalidRunReason(input.calibrationRuns, input.holdoutRuns, input.operationFamily) ??
    compatibleEvidenceReason(input.calibrationRuns, input.holdoutRuns);
  if (runError) return inconclusive(runError);
  const calibrationGroups = groupRuns(input.calibrationRuns);
  const holdoutGroups = groupRuns(input.holdoutRuns);
  const groupsProblem = calibrationGroupsProblem(calibrationGroups, holdoutGroups, minimumSamples);
  if (groupsProblem) return inconclusive(groupsProblem);
  const points = calibrationPoints(calibrationGroups);
  const minimumScore = points[0]!.score;
  const maximumScore = points[points.length - 1]!.score;
  for (const score of holdoutGroups.keys()) {
    if (score <= minimumScore || score >= maximumScore)
      return inconclusive('holdout-outside-calibrated-range');
  }
  const validationPoints = [...holdoutGroups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([score, group]): ComplexityHoldoutValidationPoint => {
      const prediction = interpolate(points, score)!;
      const observedP95Ms = nearestRankP95(group.samples);
      return {
        score,
        physicalDimension: group.evidence.physicalDimension,
        physicalValue: group.evidence.physicalValue,
        sampleCount: group.samples.length,
        observedP95Ms,
        predictedP95Ms: prediction.empiricalP95Ms,
        maxP95Ms: prediction.empiricalP95Ms * input.headroom,
        predictionErrorMs: observedP95Ms - prediction.empiricalP95Ms,
        observedToPredictedRatio: observedP95Ms / prediction.empiricalP95Ms,
      };
    });
  let holdoutSampleCount = 0;
  let maximumObservedToPredictedRatio = 0;
  for (const point of validationPoints) {
    if (point.observedP95Ms > point.maxP95Ms) return inconclusive('holdout-validation-failed');
    holdoutSampleCount += point.sampleCount;
    maximumObservedToPredictedRatio = Math.max(
      maximumObservedToPredictedRatio,
      point.observedToPredictedRatio
    );
  }
  const first = (input.calibrationRuns[0] ?? input.holdoutRuns[0])!.scoreEvidence;
  return {
    status: 'calibrated',
    model: {
      modelVersion: COMPLEXITY_BUDGET_MODEL_VERSION,
      inputKind: 'actual-complexity-assessment-score',
      operationFamily: input.operationFamily,
      headroom: input.headroom,
      headroomSelection: 'preselected-before-independent-holdout',
      minimumSamplesPerPoint: minimumSamples,
      provenance: { ...input.provenance },
      scorePolicyVersion: first.policyVersion,
      physicalDimension: first.physicalDimension,
      assumptions: {
        scoreMeaning: 'ranking-only',
        interpolation: 'empirical-p95-linear-with-monotone-envelope',
        extrapolation: 'forbidden',
        syntheticChangeRate: 'forbidden',
      },
      range: { minimumScore, maximumScore },
      points,
      validation: {
        independentHoldout: true,
        holdoutPointCount: validationPoints.length,
        holdoutSampleCount,
        maximumObservedToPredictedRatio,
        points: validationPoints,
      },
    },
  };
}

export function predictComplexityBudget(
  input: ComplexityBudgetPredictionInput
): ComplexityBudgetPrediction {
  if (input.operationFamily !== input.model.operationFamily)
    return inconclusive('incomparable-operation-family');
  const evidence = input.scoreEvidence;
  if (evidence.score === null) return inconclusive('missing-complexity-score');
  if (!Number.isFinite(evidence.score) || evidence.score < 0)
    return inconclusive('invalid-complexity-score');
  if (
    input.model.modelVersion !== COMPLEXITY_BUDGET_MODEL_VERSION ||
    input.model.inputKind !== 'actual-complexity-assessment-score' ||
    evidence.scoreSemantics !== 'nullable-ranking-index' ||
    evidence.scoreProvenance?.kind !== 'assumption-backed' ||
    !Number.isFinite(evidence.declaredChangeRate) ||
    evidence.declaredChangeRate < 0 ||
    evidence.declaredChangeRate > 1 ||
    !validComponents(evidence.components) ||
    evidence.association !== input.model.points[0]?.scoreEvidence.association ||
    evidence.declaredChangeRate !== input.model.points[0]?.scoreEvidence.declaredChangeRate ||
    evidence.scoreProvenance.declaredSource !==
      input.model.points[0]?.scoreEvidence.scoreProvenance?.declaredSource ||
    evidence.scoreProvenance.evidence !==
      input.model.points[0]?.scoreEvidence.scoreProvenance?.evidence
  ) {
    return inconclusive('invalid-score-evidence');
  }
  if (evidence.policyVersion !== input.model.scorePolicyVersion)
    return inconclusive('incompatible-score-policy');
  if (evidence.physicalDimension !== input.model.physicalDimension) {
    return inconclusive('incompatible-physical-dimension');
  }
  const exactPoint = input.model.points.find((point) => point.score === evidence.score);
  if (exactPoint && exactPoint.physicalValue !== evidence.physicalValue) {
    return inconclusive('tied-complexity-scores');
  }
  if (
    evidence.score < input.model.range.minimumScore ||
    evidence.score > input.model.range.maximumScore
  ) {
    return inconclusive('unsupported-extrapolation');
  }
  const prediction = interpolate(input.model.points, evidence.score);
  if (!prediction) return inconclusive('unsupported-extrapolation');
  return {
    status: 'predicted',
    operationFamily: input.operationFamily,
    score: evidence.score,
    empiricalP95Ms: prediction.empiricalP95Ms,
    maxP95Ms: prediction.empiricalP95Ms * input.model.headroom,
    lowerScore: prediction.lowerScore,
    upperScore: prediction.upperScore,
  };
}
