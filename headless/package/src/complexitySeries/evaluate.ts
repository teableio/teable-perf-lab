import {
  calibrateComplexityBudgetModel,
  COMPLEXITY_BUDGET_MODEL_VERSION,
  MINIMUM_COMPLEXITY_SAMPLES_PER_POINT,
  predictComplexityBudget,
  type CalibratedComplexityBudgetModel,
  type ComplexityRunMeasurement,
} from '../ci/complexityBudgetModel';
import type {
  ComplexityCalibrationSeriesResult,
  ComplexityGateSeriesResult,
  ComplexitySeriesDefinition,
  ComplexitySeriesEvaluationInput,
  ComplexitySeriesMeasurementProtocol,
  ComplexitySeriesSampleReceipt,
  ComplexitySeriesUnknownReason,
} from './types';

const unknownCalibration = (reason: ComplexitySeriesUnknownReason) => ({
  status: 'unknown' as const,
  reason,
  model: null,
});

const unknownGate = (reason: ComplexitySeriesUnknownReason, actualP95Ms: number | null = null) => ({
  verdict: 'unknown' as const,
  reason,
  actualP95Ms,
  maxP95Ms: null,
  prediction: null,
});

function associationMatchesAssessment(
  association: NonNullable<ComplexitySeriesSampleReceipt['complexityAssociation']>,
  assessment: NonNullable<ComplexitySeriesSampleReceipt['complexityAssessment']>
): boolean {
  return (
    assessment.association.strategy === 'writes-since-previous-flush' &&
    assessment.association.linkedWriteKeys.length === 1 &&
    assessment.association.linkedWriteKeys[0] === assessment.assessmentKey &&
    association.linkedWriteKeys.length === 1 &&
    association.linkedWriteKeys[0] === assessment.assessmentKey
  );
}

function receiptAssessmentProblem(
  receipt: ComplexitySeriesSampleReceipt
): ComplexitySeriesUnknownReason | undefined {
  if (!receipt.complexityAssociation) return 'incompatible-complexity-assessment';
  if (receipt.complexityAssessmentCount > 1) return 'multiple-complexity-assessments';
  if (receipt.complexityAssessmentCount < 1 || !receipt.complexityAssessment) {
    return 'missing-complexity-assessment';
  }
  const assessment = receipt.complexityAssessment;
  if (assessment.score === null) return 'missing-complexity-score';
  if (
    assessment.components.dataWork === null ||
    assessment.scoreSemantics !== 'nullable-ranking-index' ||
    assessment.scoreProvenance?.kind !== 'assumption-backed' ||
    assessment.declaredChangeRate === null ||
    !Number.isFinite(assessment.declaredChangeRate) ||
    assessment.declaredChangeRate < 0 ||
    assessment.declaredChangeRate > 1
  ) {
    return 'incompatible-complexity-assessment';
  }
  if (!associationMatchesAssessment(receipt.complexityAssociation, assessment)) {
    return 'incompatible-complexity-assessment';
  }
  return undefined;
}

function receiptProblem(input: {
  readonly definition: ComplexitySeriesDefinition;
  readonly receipt: ComplexitySeriesSampleReceipt;
  readonly role: ComplexitySeriesSampleReceipt['role'];
  readonly workUnits: number;
  readonly minimumSamples: number;
  readonly measurementProtocol: ComplexitySeriesMeasurementProtocol;
}): ComplexitySeriesUnknownReason | undefined {
  const { definition, receipt } = input;
  const protocolFields = Object.keys(input.measurementProtocol) as Array<
    keyof ComplexitySeriesMeasurementProtocol
  >;
  if (
    receipt.ruleId !== definition.ruleId ||
    receipt.role !== input.role ||
    receipt.operationKey !== definition.operationKey ||
    receipt.operationFamily !== definition.operationFamily ||
    receipt.workUnits !== input.workUnits ||
    receipt.schemaSize.groundedDimension.name !== definition.dimension ||
    receipt.schemaSize.groundedDimension.workUnits !== input.workUnits ||
    receipt.backend !== 'postgres'
  ) {
    return 'receipt-mismatch';
  }
  if (
    protocolFields.some(
      (field) => receipt.measurementProtocol[field] !== input.measurementProtocol[field]
    )
  ) {
    return 'receipt-mismatch';
  }
  if (receipt.correctnessVerdict === 'fail') return 'correctness-failure';
  if (receipt.correctnessVerdict !== 'pass') return 'correctness-inconclusive';
  if (!receipt.operationFound) return 'operation-not-found';
  if (receipt.operationErrors > 0) return 'operation-errors';
  const assessmentProblem = receiptAssessmentProblem(receipt);
  if (assessmentProblem) return assessmentProblem;
  if (
    receipt.sampleCount !==
      input.measurementProtocol.samplesPerPoint * input.measurementProtocol.repetitions ||
    receipt.sampleCount < input.minimumSamples ||
    receipt.samplesMs.length !== receipt.sampleCount ||
    receipt.samplesMs.some((sample) => !Number.isFinite(sample) || sample <= 0) ||
    receipt.actualP95Ms === null ||
    !Number.isFinite(receipt.actualP95Ms) ||
    receipt.actualP95Ms <= 0
  ) {
    return 'insufficient-samples';
  }
  return undefined;
}

function exactReceipt(input: {
  readonly receipts: ReadonlyArray<ComplexitySeriesSampleReceipt>;
  readonly role: ComplexitySeriesSampleReceipt['role'];
  readonly workUnits: number;
}): ComplexitySeriesSampleReceipt | undefined {
  const matches = input.receipts.filter(
    (receipt) => receipt.role === input.role && receipt.workUnits === input.workUnits
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function measurements(
  definition: ComplexitySeriesDefinition,
  receipts: ReadonlyArray<ComplexitySeriesSampleReceipt>
): ReadonlyArray<ComplexityRunMeasurement> {
  return receipts.flatMap((receipt) => {
    const assessment = receipt.complexityAssessment!;
    return receipt.samplesMs.map((elapsedMs) => ({
      operationFamily: definition.operationFamily,
      scoreEvidence: {
        score: assessment.score,
        policyVersion: assessment.policyVersion,
        scoreSemantics: assessment.scoreSemantics,
        scoreProvenance:
          assessment.scoreProvenance?.kind === 'assumption-backed'
            ? assessment.scoreProvenance
            : null,
        declaredChangeRate: assessment.declaredChangeRate!,
        components: {
          structural: assessment.components.structural,
          dataWork: assessment.components.dataWork!,
          risk: assessment.components.risk,
        },
        assessmentKey: assessment.assessmentKey,
        association: 'flush-preceding-write' as const,
        physicalDimension: definition.dimension,
        physicalValue: receipt.workUnits,
      },
      elapsedMs,
    }));
  });
}

export function evaluateComplexityCalibration(
  input: ComplexitySeriesEvaluationInput
): ComplexityCalibrationSeriesResult {
  const minimumSamples = input.minimumSamplesPerPoint ?? MINIMUM_COMPLEXITY_SAMPLES_PER_POINT;
  const calibrationReceipts: ComplexitySeriesSampleReceipt[] = [];
  for (const workUnits of input.definition.calibrationWorkUnits) {
    const receipt = exactReceipt({ receipts: input.receipts, role: 'calibration', workUnits });
    if (!receipt) {
      return {
        ...seriesIdentity(input.definition),
        requestedWorkUnits: {
          calibration: [...input.definition.calibrationWorkUnits],
          holdout: input.definition.holdoutWorkUnits,
        },
        receipts: input.receipts,
        calibration: unknownCalibration('receipt-mismatch'),
      };
    }
    const problem = receiptProblem({
      definition: input.definition,
      receipt,
      role: 'calibration',
      workUnits,
      measurementProtocol: input.measurementProtocol,
      minimumSamples,
    });
    if (problem) {
      return {
        ...seriesIdentity(input.definition),
        requestedWorkUnits: {
          calibration: [...input.definition.calibrationWorkUnits],
          holdout: input.definition.holdoutWorkUnits,
        },
        receipts: input.receipts,
        calibration: unknownCalibration(problem),
      };
    }
    calibrationReceipts.push(receipt);
  }
  const holdout = exactReceipt({
    receipts: input.receipts,
    role: 'holdout',
    workUnits: input.definition.holdoutWorkUnits,
  });
  if (!holdout) {
    return {
      ...seriesIdentity(input.definition),
      requestedWorkUnits: {
        calibration: [...input.definition.calibrationWorkUnits],
        holdout: input.definition.holdoutWorkUnits,
      },
      receipts: input.receipts,
      calibration: unknownCalibration('receipt-mismatch'),
    };
  }
  const holdoutProblem = receiptProblem({
    definition: input.definition,
    receipt: holdout,
    role: 'holdout',
    workUnits: input.definition.holdoutWorkUnits,
    measurementProtocol: input.measurementProtocol,
    minimumSamples,
  });
  if (holdoutProblem) {
    return {
      ...seriesIdentity(input.definition),
      requestedWorkUnits: {
        calibration: [...input.definition.calibrationWorkUnits],
        holdout: input.definition.holdoutWorkUnits,
      },
      receipts: input.receipts,
      calibration: unknownCalibration(holdoutProblem),
    };
  }

  const calibrated = calibrateComplexityBudgetModel({
    operationFamily: input.definition.operationFamily,
    calibrationRuns: measurements(input.definition, calibrationReceipts),
    holdoutRuns: measurements(input.definition, [holdout]),
    headroom: input.headroom,
    provenance: input.provenance,
    minimumSamplesPerPoint: minimumSamples,
  });
  return {
    ...seriesIdentity(input.definition),
    requestedWorkUnits: {
      calibration: [...input.definition.calibrationWorkUnits],
      holdout: input.definition.holdoutWorkUnits,
    },
    receipts: input.receipts,
    calibration:
      calibrated.status === 'calibrated'
        ? { status: 'calibrated', model: calibrated.model }
        : unknownCalibration(calibrated.reason),
  };
}

export function evaluateComplexityGate(input: {
  readonly definition: ComplexitySeriesDefinition;
  readonly receipt: ComplexitySeriesSampleReceipt | null;
  readonly model: CalibratedComplexityBudgetModel | null;
  readonly modelUnavailableReason?: ComplexitySeriesUnknownReason;
  readonly blockingReason?: ComplexitySeriesUnknownReason;
  readonly minimumSamplesPerPoint?: number;
  readonly measurementProtocol: ComplexitySeriesMeasurementProtocol;
}): ComplexityGateSeriesResult {
  const identity = seriesIdentity(input.definition);
  const base = {
    ...identity,
    requestedWorkUnits: { gate: input.definition.gateWorkUnits },
    receipt: input.receipt,
    calibrationModel: input.model,
  };
  if (!input.model) {
    return {
      ...base,
      gate: unknownGate(
        input.modelUnavailableReason ?? 'calibration-model-missing',
        input.receipt?.actualP95Ms ?? null
      ),
    };
  }
  if (input.blockingReason) {
    return {
      ...base,
      gate: unknownGate(input.blockingReason, input.receipt?.actualP95Ms ?? null),
    };
  }
  if (input.model.modelVersion !== COMPLEXITY_BUDGET_MODEL_VERSION) {
    return { ...base, gate: unknownGate('calibration-model-version-mismatch') };
  }
  if (!input.receipt) return { ...base, gate: unknownGate('operation-not-found') };
  const problem = receiptProblem({
    definition: input.definition,
    receipt: input.receipt,
    role: 'gate',
    workUnits: input.definition.gateWorkUnits,
    minimumSamples: input.minimumSamplesPerPoint ?? MINIMUM_COMPLEXITY_SAMPLES_PER_POINT,
    measurementProtocol: input.measurementProtocol,
  });
  if (problem) {
    return { ...base, gate: unknownGate(problem, input.receipt.actualP95Ms) };
  }
  const assessment = input.receipt.complexityAssessment!;
  const prediction = predictComplexityBudget({
    model: input.model,
    operationFamily: input.definition.operationFamily,
    scoreEvidence: {
      score: assessment.score,
      policyVersion: assessment.policyVersion,
      scoreSemantics: assessment.scoreSemantics,
      scoreProvenance:
        assessment.scoreProvenance?.kind === 'assumption-backed'
          ? assessment.scoreProvenance
          : null,
      declaredChangeRate: assessment.declaredChangeRate!,
      components: {
        structural: assessment.components.structural,
        dataWork: assessment.components.dataWork!,
        risk: assessment.components.risk,
      },
      assessmentKey: assessment.assessmentKey,
      association: 'flush-preceding-write',
      physicalDimension: input.definition.dimension,
      physicalValue: input.receipt.workUnits,
    },
  });
  if (prediction.status !== 'predicted') {
    return { ...base, gate: unknownGate(prediction.reason, input.receipt.actualP95Ms) };
  }
  const actualP95Ms = input.receipt.actualP95Ms!;
  return {
    ...base,
    gate: {
      verdict: actualP95Ms <= prediction.maxP95Ms ? 'pass' : 'fail',
      reason: null,
      actualP95Ms,
      maxP95Ms: prediction.maxP95Ms,
      prediction,
    },
  };
}

function seriesIdentity(definition: ComplexitySeriesDefinition) {
  return {
    ruleId: definition.ruleId,
    operationKey: definition.operationKey,
    operationFamily: definition.operationFamily,
    dimension: definition.dimension,
  } as const;
}
