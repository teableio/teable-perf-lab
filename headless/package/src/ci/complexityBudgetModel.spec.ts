import { describe, expect, it } from 'vitest';

import {
  calibrateComplexityBudgetModel,
  predictComplexityBudget,
  type CalibratedComplexityBudgetModel,
  type ComplexityRunMeasurement,
  type ComplexityScoreEvidence,
} from './complexityBudgetModel';

const family = 'R-FORMULA-004/transition-2-wait-computed';
const provenance = {
  source: 'ci-calibration-artifact',
  runner: 'ubuntu-24.04-x64-8-core',
  calibratedAt: '2026-10-29T00:00:00.000Z',
} as const;

const evidence = (
  score: number | null,
  physicalValue: number,
  overrides: Partial<ComplexityScoreEvidence> = {}
): ComplexityScoreEvidence => ({
  score,
  policyVersion: 'v2-complexity-policy-2',
  components: { structural: physicalValue, dataWork: 20, risk: 0 },
  assessmentKey: `write-${physicalValue}`,
  association: 'flush-preceding-write',
  physicalDimension: 'graphDepth',
  physicalValue,
  ...overrides,
  scoreSemantics: 'nullable-ranking-index',
  scoreProvenance: {
    kind: 'assumption-backed',
    assumption: 'changeRate',
    source: 'manifest.dimensions.complexityAssumptions.changeRateByOperation',
    declaredSource: 'complexity-series-conservative-upper-bound',
    evidence: 'Declared planning bound; not an observed change rate.',
  },
  declaredChangeRate: 1,
});

const runs = (
  score: number | null,
  physicalValue: number,
  elapsedMs: number,
  count = 20,
  operationFamily = family,
  overrides: Partial<ComplexityScoreEvidence> = {}
): ReadonlyArray<ComplexityRunMeasurement> =>
  Array.from({ length: count }, () => ({
    operationFamily,
    scoreEvidence: evidence(score, physicalValue, overrides),
    elapsedMs,
  }));

const calibratedModel = (): CalibratedComplexityBudgetModel => {
  const result = calibrateComplexityBudgetModel({
    operationFamily: family,
    calibrationRuns: [...runs(10, 2, 10), ...runs(30, 8, 30)],
    holdoutRuns: runs(20, 6, 22),
    headroom: 1.2,
    provenance,
  });
  if (result.status !== 'calibrated') throw new Error(`unexpected calibration: ${result.reason}`);
  return result.model;
};

describe('score-driven complexity budget calibration', () => {
  it('changes the empirical p95 prediction at distinct actual assessment scores', () => {
    const model = calibratedModel();
    const low = predictComplexityBudget({
      model,
      operationFamily: family,
      scoreEvidence: evidence(12, 3),
    });
    const high = predictComplexityBudget({
      model,
      operationFamily: family,
      scoreEvidence: evidence(28, 7),
    });

    expect(low).toMatchObject({ status: 'predicted', score: 12, empiricalP95Ms: 12 });
    expect(high).toMatchObject({ status: 'predicted', score: 28, empiricalP95Ms: 28 });
    expect(model).toMatchObject({
      inputKind: 'actual-complexity-assessment-score',
      scorePolicyVersion: 'v2-complexity-policy-2',
      physicalDimension: 'graphDepth',
      range: { minimumScore: 10, maximumScore: 30 },
      headroomSelection: 'preselected-before-independent-holdout',
      assumptions: { scoreMeaning: 'ranking-only', syntheticChangeRate: 'forbidden' },
    });
  });

  it('fails closed when distinct physical points have tied scores', () => {
    expect(
      calibrateComplexityBudgetModel({
        operationFamily: family,
        calibrationRuns: [...runs(10, 2, 10), ...runs(10, 8, 30)],
        holdoutRuns: runs(8, 6, 20),
        headroom: 1.2,
        provenance,
      })
    ).toEqual({ status: 'inconclusive', reason: 'tied-complexity-scores' });

    expect(
      predictComplexityBudget({
        model: calibratedModel(),
        operationFamily: family,
        scoreEvidence: evidence(10, 3),
      })
    ).toEqual({ status: 'inconclusive', reason: 'tied-complexity-scores' });
  });

  it('fails closed instead of inventing a score or change rate when an assessment score is null', () => {
    expect(
      calibrateComplexityBudgetModel({
        operationFamily: family,
        calibrationRuns: [...runs(null, 2, 10), ...runs(30, 8, 30)],
        holdoutRuns: runs(20, 6, 20),
        headroom: 1.2,
        provenance,
      })
    ).toEqual({ status: 'inconclusive', reason: 'missing-complexity-score' });

    expect(
      predictComplexityBudget({
        model: calibratedModel(),
        operationFamily: family,
        scoreEvidence: evidence(null, 4),
      })
    ).toEqual({ status: 'inconclusive', reason: 'missing-complexity-score' });
  });

  it('keeps the independent holdout out of calibration points and applies preselected headroom', () => {
    const model = calibratedModel();

    expect(model.points.map((point) => point.score)).toEqual([10, 30]);
    expect(model.validation).toMatchObject({
      independentHoldout: true,
      holdoutPointCount: 1,
      holdoutSampleCount: 20,
      points: [
        {
          score: 20,
          observedP95Ms: 22,
          predictedP95Ms: 20,
          maxP95Ms: 24,
          predictionErrorMs: 2,
          observedToPredictedRatio: 1.1,
        },
      ],
    });
  });

  it('rejects a holdout that exceeds the separately preselected gate', () => {
    expect(
      calibrateComplexityBudgetModel({
        operationFamily: family,
        calibrationRuns: [...runs(10, 2, 10), ...runs(30, 8, 30)],
        holdoutRuns: runs(20, 6, 25),
        headroom: 1.2,
        provenance,
      })
    ).toEqual({ status: 'inconclusive', reason: 'holdout-validation-failed' });
  });

  it('fails closed on incompatible families, policy versions, dimensions, and extrapolation', () => {
    expect(
      calibrateComplexityBudgetModel({
        operationFamily: family,
        calibrationRuns: [
          ...runs(10, 2, 10),
          ...runs(30, 8, 30, 20, family, { policyVersion: 'other-policy' }),
        ],
        holdoutRuns: runs(20, 6, 20),
        headroom: 1.2,
        provenance,
      })
    ).toEqual({ status: 'inconclusive', reason: 'incompatible-score-policy' });

    expect(
      predictComplexityBudget({
        model: calibratedModel(),
        operationFamily: 'R-FORMULA-005/transition-2-wait-computed',
        scoreEvidence: evidence(20, 6),
      })
    ).toEqual({ status: 'inconclusive', reason: 'incomparable-operation-family' });
    expect(
      predictComplexityBudget({
        model: calibratedModel(),
        operationFamily: family,
        scoreEvidence: evidence(31, 9),
      })
    ).toEqual({ status: 'inconclusive', reason: 'unsupported-extrapolation' });
    expect(
      predictComplexityBudget({
        model: calibratedModel(),
        operationFamily: family,
        scoreEvidence: evidence(20, 6, { physicalDimension: 'graphWidth' }),
      })
    ).toEqual({ status: 'inconclusive', reason: 'incompatible-physical-dimension' });
  });

  it('preserves actual score components and association provenance at calibration points', () => {
    const model = calibratedModel();
    expect(model.points[0]).toMatchObject({
      score: 10,
      physicalDimension: 'graphDepth',
      physicalValue: 2,
      scoreEvidence: {
        policyVersion: 'v2-complexity-policy-2',
        scoreSemantics: 'nullable-ranking-index',
        declaredChangeRate: 1,
        scoreProvenance: {
          kind: 'assumption-backed',
          declaredSource: 'complexity-series-conservative-upper-bound',
          evidence: 'Declared planning bound; not an observed change rate.',
        },
        components: { structural: 2, dataWork: 20, risk: 0 },
        assessmentKey: 'write-2',
        association: 'flush-preceding-write',
      },
    });
  });
});
