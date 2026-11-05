import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import { enumerateScenarioCatalogue, ScenarioSchema, type Scenario } from '../catalogue';
import { selectCiScenarios } from '../ci/scenarios';
import type {
  ComplexitySeriesDefinition,
  ComplexitySeriesRole,
  ComplexitySeriesRuleId,
} from './types';

const SERIES_VARIANT_KIND = 'bounded-complexity-series/1' as const;

export const COMPLEXITY_SERIES_DEFINITIONS: ReadonlyArray<ComplexitySeriesDefinition> = [
  {
    ruleId: 'R-FORMULA-004',
    operationKey: 'transition-2-wait-computed',
    operationFamily: 'R-FORMULA-004/transition-2-wait-computed',
    dimension: 'graphDepth',
    calibrationWorkUnits: [2, 8],
    holdoutWorkUnits: 6,
    gateWorkUnits: 4,
  },
  {
    ruleId: 'R-FORMULA-005',
    operationKey: 'transition-2-wait-computed',
    operationFamily: 'R-FORMULA-005/transition-2-wait-computed',
    dimension: 'graphWidth',
    calibrationWorkUnits: [4, 16],
    holdoutWorkUnits: 12,
    gateWorkUnits: 8,
  },
  {
    ruleId: 'R-PROP-003',
    operationKey: 'transition-1-flush-computed',
    operationFamily: 'R-PROP-003/transition-1-flush-computed',
    dimension: 'fanout',
    calibrationWorkUnits: [20, 100],
    holdoutWorkUnits: 60,
    gateWorkUnits: 100,
  },
];

export function complexitySeriesBaseScenarios(): ReadonlyMap<ComplexitySeriesRuleId, Scenario> {
  const selected = selectCiScenarios(enumerateScenarioCatalogue().scenarios);
  const bases = new Map<ComplexitySeriesRuleId, Scenario>();
  for (const definition of COMPLEXITY_SERIES_DEFINITIONS) {
    const scenario = selected.find((candidate) => candidate.ruleId === definition.ruleId);
    if (!scenario) throw new Error(`Missing bounded scenario for ${definition.ruleId}`);
    bases.set(definition.ruleId, scenario);
  }
  return bases;
}

export function createComplexitySeriesScenario(input: {
  readonly source: Scenario;
  readonly definition: ComplexitySeriesDefinition;
  readonly role: ComplexitySeriesRole;
  readonly workUnits: number;
}): Scenario {
  if (input.source.ruleId !== input.definition.ruleId) {
    throw new Error(
      `Series ${input.definition.ruleId} cannot use scenario for ${input.source.ruleId}`
    );
  }
  if (!Number.isInteger(input.workUnits) || input.workUnits <= 0) {
    throw new Error(`Complexity work units must be a positive integer: ${input.workUnits}`);
  }
  const size = {
    ...input.source.size,
    [input.definition.dimension]: input.workUnits,
  };
  const complexityAssumptionWriteKey =
    input.definition.ruleId === 'R-FORMULA-004'
      ? 'transition-1-update-root'
      : 'transition-1-update-shared-source';
  const complexityAssumption = {
    writeKey: complexityAssumptionWriteKey,
    changeRate: 1,
    source: 'complexity-series-conservative-upper-bound',
    evidence:
      'Declared planning bound: score calibration assumes every dirty computed output changes; this is not an observed change rate.',
  } as const;
  const structuralIdentity = canonicalJson({
    variantKind: SERIES_VARIANT_KIND,
    sourceBoundedScenarioId: input.source.scenarioId,
    ruleId: input.definition.ruleId,
    operationKey: input.definition.operationKey,
    dimension: input.definition.dimension,
    role: input.role,
    workUnits: input.workUnits,
    size,
    complexityAssumption,
  });
  const identity = {
    schemaVersion: input.source.schemaVersion,
    generatorVersion: input.source.generatorVersion,
    ruleRegistryVersion: input.source.ruleRegistryVersion,
    structuralIdentity,
  };
  const scenarioId = `scn_${sha256Hex(canonicalJson(identity))}`;
  const roleLabel = `${input.role}:${input.definition.dimension}=${input.workUnits}`;
  const mutationSequence =
    input.definition.ruleId === 'R-FORMULA-004'
      ? [
          `更新 ${size.rows} 行的根源值`,
          `核对全部 ${input.workUnits} 层公式结果；仅作为 ${input.definition.operationFamily} 的有界证据`,
        ]
      : input.definition.ruleId === 'R-FORMULA-005'
        ? [
            `更新 ${size.rows} 行的共享源值`,
            `核对全部 ${input.workUnits} 个同记录公式目标；仅作为 ${input.definition.operationFamily} 的有界证据`,
          ]
        : [
            '更新唯一共享源值',
            `核对有界夹具中的全部 ${input.workUnits} 个关联目标；不外推到其他扇出`,
          ];
  const exclusionEvidence = `${roleLabel}; only ${input.definition.dimension} varies, and no result is extrapolated beyond the calibrated range.`;

  return ScenarioSchema.parse({
    ...input.source,
    ...identity,
    scenarioId,
    title: `${input.source.title}（${roleLabel}）`,
    description: `Reuses ${input.source.fixture.reference} for ${input.definition.ruleId} at ${roleLabel}; measurements are comparable only within ${input.definition.operationFamily}.`,
    distinctnessReason: {
      behaviorInput: `${input.definition.ruleId} bounded template`,
      shapeInput: `${input.definition.dimension}=${input.workUnits}; other bounded dimensions unchanged`,
      workloadInput: `${input.definition.operationKey}; role=${input.role}`,
      oracleInput: `${input.source.oracle.strategy}; every measured sample retains the bounded correctness oracle`,
    },
    coverageObligationKeys: [
      `complexity-series:${input.definition.ruleId}:${input.role}:${input.workUnits}`,
    ],
    size,
    applicability: {
      applicable: true,
      reason: `The existing bounded materializer is executed at ${roleLabel}; ${exclusionEvidence}`,
    },
    fixture: {
      ...input.source.fixture,
      parameters: {
        ...input.source.fixture.parameters,
        rows: size.rows,
        graphDepth: size.graphDepth,
        graphWidth: size.graphWidth,
        fanout: size.fanout,
        complexitySeriesVariantKind: SERIES_VARIANT_KIND,
        complexitySeriesRole: input.role,
        complexitySeriesDimension: input.definition.dimension,
        complexitySeriesWorkUnits: input.workUnits,
        ciExclusionEvidence: exclusionEvidence,
        sourceBoundedScenarioId: input.source.scenarioId,
        complexityAssumptionWriteKey: complexityAssumption.writeKey,
        complexityAssumptionChangeRate: complexityAssumption.changeRate,
        complexityAssumptionSource: complexityAssumption.source,
        complexityAssumptionEvidence: complexityAssumption.evidence,
      },
    },
    workload: {
      ...input.source.workload,
      mutationSequence,
      queryShape: `complexity-series:${input.definition.operationFamily}`,
    },
    oracle: {
      ...input.source.oracle,
      expected: `Every measured sample must pass the bounded correctness oracle at ${roleLabel}.`,
      assertions: [
        `Bounded correctness at ${input.definition.dimension}=${input.workUnits}`,
        `Complexity series receipt: ${roleLabel}`,
      ],
    },
  });
}
