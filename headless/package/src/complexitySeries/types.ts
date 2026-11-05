import type {
  CalibratedComplexityBudgetModel,
  ComplexityBudgetInconclusiveReason,
  ComplexityBudgetPrediction,
  ComplexityBudgetProvenance,
} from '../ci/complexityBudgetModel';
import type { BenchMeasurementProtocol } from '../runner/BenchRunner';

export const COMPLEXITY_CALIBRATION_SCHEMA = 'tea-bench-complexity-score-calibration/3' as const;
export const COMPLEXITY_GATE_SCHEMA = 'tea-bench-complexity-score-gate/3' as const;
export type ComplexitySeriesMeasurementProtocol = BenchMeasurementProtocol & {
  readonly samplesPerPoint: number;
  readonly warmup: number;
  readonly repetitions: number;
};

export type ComplexitySeriesRuleId = 'R-FORMULA-004' | 'R-FORMULA-005' | 'R-PROP-003';
export type ComplexitySeriesDimension = 'graphDepth' | 'graphWidth' | 'fanout';
export type ComplexitySeriesRole = 'calibration' | 'holdout' | 'gate';

export type ComplexitySeriesDefinition = {
  readonly ruleId: ComplexitySeriesRuleId;
  /** Exact measured workload key. A series never combines measurements from another key. */
  readonly operationKey: string;
  /** Stable identity containing both rule and operation key. */
  readonly operationFamily: string;
  /** The schema dimension used directly as model work units. */
  readonly dimension: ComplexitySeriesDimension;
  readonly calibrationWorkUnits: readonly [number, number, ...number[]];
  readonly holdoutWorkUnits: number;
  readonly gateWorkUnits: number;
};

export type ComplexitySeriesSchemaSize = {
  readonly tableCount: number;
  readonly fieldCount: number;
  readonly computedFieldCount: number;
  readonly rowsByTable: Readonly<Record<string, number>>;
  readonly totalRows: number;
  readonly groundedDimension: {
    readonly name: ComplexitySeriesDimension;
    readonly workUnits: number;
  };
};

export type ComplexitySeriesRunProvenance = {
  readonly commit: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly runtime: string;
  readonly postgresVersion: string;
  readonly startedAt: string;
  readonly completedAt: string;
};
export type ComplexitySeriesAssessmentEvidence = {
  readonly assessmentKey: string;
  readonly policyVersion: string;
  readonly score: number | null;
  readonly scoreSemantics: 'nullable-ranking-index';
  readonly scoreProvenance:
    | {
        readonly kind: 'assumption-backed';
        readonly assumption: 'changeRate';
        readonly source: 'manifest.dimensions.complexityAssumptions.changeRateByOperation';
        readonly declaredSource: string;
        readonly evidence: string;
      }
    | { readonly kind: 'incomplete-input'; readonly missingAssumption: 'changeRate' }
    | { readonly kind: 'schema-only' }
    | null;
  readonly declaredChangeRate: number | null;
  readonly components: {
    readonly structural: number;
    readonly dataWork: number | null;
    readonly risk: number;
  };
  readonly association: {
    readonly strategy: 'writes-since-previous-flush';
    readonly linkedWriteKeys: ReadonlyArray<string>;
  };
  /** Inputs and provenance emitted by the actual complexity simulation; never synthesized here. */
  readonly simulation: unknown;
  readonly assumptions: {
    readonly scoreMeaning: 'ranking-only';
    readonly syntheticChangeRate: 'forbidden';
  };
};

export type ComplexitySeriesSampleReceipt = {
  readonly role: ComplexitySeriesRole;
  readonly ruleId: ComplexitySeriesRuleId;
  readonly scenarioId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly backend: 'postgres';
  readonly runProvenance: ComplexitySeriesRunProvenance;
  readonly measurementProtocol: ComplexitySeriesMeasurementProtocol;
  readonly operationKey: string;
  readonly operationFamily: string;
  readonly workUnits: number;
  readonly schemaSize: ComplexitySeriesSchemaSize;
  readonly complexityAssociation: {
    readonly strategy: 'writes-since-previous-flush';
    readonly linkedWriteKeys: ReadonlyArray<string>;
  } | null;
  readonly complexityAssessmentCount: number;
  readonly complexityAssessment: ComplexitySeriesAssessmentEvidence | null;
  readonly correctnessVerdict: 'pass' | 'fail' | 'inconclusive';
  readonly operationFound: boolean;
  readonly operationErrors: number;
  readonly sampleCount: number;
  readonly samplesMs: ReadonlyArray<number>;
  readonly actualP95Ms: number | null;
};

export type ComplexitySeriesUnknownReason =
  | ComplexityBudgetInconclusiveReason
  | 'multiple-complexity-assessments'
  | 'missing-complexity-assessment'
  | 'incompatible-complexity-assessment'
  | 'correctness-failure'
  | 'correctness-inconclusive'
  | 'operation-not-found'
  | 'operation-errors'
  | 'receipt-mismatch'
  | 'calibration-artifact-missing'
  | 'calibration-artifact-invalid'
  | 'calibration-artifact-hash-mismatch'
  | 'calibration-model-missing'
  | 'incompatible-runner'
  | 'calibration-model-version-mismatch';

export type ComplexitySeriesCalibration =
  | {
      readonly status: 'calibrated';
      readonly model: CalibratedComplexityBudgetModel;
    }
  | {
      readonly status: 'unknown';
      readonly reason: ComplexitySeriesUnknownReason;
      readonly model: null;
    };

export type ComplexityCalibrationSeriesResult = {
  readonly ruleId: ComplexitySeriesRuleId;
  readonly operationKey: string;
  readonly operationFamily: string;
  readonly dimension: ComplexitySeriesDimension;
  readonly requestedWorkUnits: {
    readonly calibration: ReadonlyArray<number>;
    readonly holdout: number;
  };
  readonly receipts: ReadonlyArray<ComplexitySeriesSampleReceipt>;
  readonly calibration: ComplexitySeriesCalibration;
};

export type ComplexitySeriesExecutionError = {
  readonly ruleId: ComplexitySeriesRuleId;
  readonly role: ComplexitySeriesRole;
  readonly workUnits: number;
  readonly message: string;
};

export type ComplexityCalibrationArtifact = {
  readonly schema: typeof COMPLEXITY_CALIBRATION_SCHEMA;
  readonly mode: 'calibrate';
  readonly backend: 'postgres';
  readonly modelVersion: CalibratedComplexityBudgetModel['modelVersion'];
  readonly generatedAt: string;
  readonly requestedSamplesPerPoint: number;
  readonly measurementProtocol: ComplexitySeriesMeasurementProtocol;
  readonly headroom: number;
  readonly provenance: ComplexityBudgetProvenance;
  readonly verdict: 'pass' | 'fail' | 'inconclusive';
  readonly executionErrors: ReadonlyArray<ComplexitySeriesExecutionError>;
  readonly series: ReadonlyArray<ComplexityCalibrationSeriesResult>;
};

export type ComplexitySeriesGate =
  | {
      readonly verdict: 'pass' | 'fail';
      readonly reason: null;
      readonly actualP95Ms: number;
      readonly maxP95Ms: number;
      readonly prediction: Extract<ComplexityBudgetPrediction, { status: 'predicted' }>;
    }
  | {
      readonly verdict: 'unknown';
      readonly reason: ComplexitySeriesUnknownReason;
      readonly actualP95Ms: number | null;
      readonly maxP95Ms: null;
      readonly prediction: null;
    };

export type ComplexityGateSeriesResult = {
  readonly ruleId: ComplexitySeriesRuleId;
  readonly operationKey: string;
  readonly operationFamily: string;
  readonly dimension: ComplexitySeriesDimension;
  readonly requestedWorkUnits: { readonly gate: number };
  readonly receipt: ComplexitySeriesSampleReceipt | null;
  readonly calibrationModel: CalibratedComplexityBudgetModel | null;
  readonly gate: ComplexitySeriesGate;
};

export type ComplexityCalibrationEvidence =
  | {
      readonly status: 'loaded';
      readonly path: string;
      readonly sha256: string;
      readonly expectedSha256: string;
      readonly provenance: ComplexityBudgetProvenance;
      readonly generatedAt: string;
    }
  | {
      readonly status: 'unknown';
      readonly path: string;
      readonly sha256: string | null;
      readonly expectedSha256: string;
      readonly reason: ComplexitySeriesUnknownReason;
      readonly message?: string;
    };

export type ComplexityGateReport = {
  readonly schema: typeof COMPLEXITY_GATE_SCHEMA;
  readonly mode: 'gate';
  readonly backend: 'postgres';
  readonly modelVersion: CalibratedComplexityBudgetModel['modelVersion'];
  readonly generatedAt: string;
  readonly runner: string;
  readonly requestedSamplesPerPoint: number;
  readonly measurementProtocol: ComplexitySeriesMeasurementProtocol;
  readonly calibrationEvidence: ComplexityCalibrationEvidence;
  readonly verdict: 'pass' | 'fail' | 'inconclusive';
  readonly executionErrors: ReadonlyArray<ComplexitySeriesExecutionError>;
  readonly series: ReadonlyArray<ComplexityGateSeriesResult>;
};

export type ComplexityCalibrationRunInput = {
  readonly connectionString: string;
  readonly outDir: string;
  readonly headroom: number;
  readonly provenance: ComplexityBudgetProvenance;
  /** Defaults to exactly 20; values below the empirical p95 requirement are rejected. */
  readonly samplesPerPoint?: number;
};

export type ComplexityGateRunInput = {
  readonly connectionString: string;
  readonly outDir: string;
  /** Stable current runner class; it must equal the pinned calibration runner. */
  readonly runner: string;
  readonly calibrationArtifactPath: string;
  /** External immutable digest designating the baseline; never learned from the current run. */
  readonly expectedCalibrationSha256: string;
  /** Defaults to exactly 20; values below the empirical p95 requirement are rejected. */
  readonly samplesPerPoint?: number;
};

export type ComplexitySeriesEvaluationInput = {
  readonly definition: ComplexitySeriesDefinition;
  readonly receipts: ReadonlyArray<ComplexitySeriesSampleReceipt>;
  readonly measurementProtocol: ComplexitySeriesMeasurementProtocol;
  readonly headroom: number;
  readonly provenance: ComplexityBudgetProvenance;
  readonly minimumSamplesPerPoint?: number;
};
