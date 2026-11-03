import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import { ruleRegistry, ScenarioSchema, type Rule, type Scenario } from '../catalogue';

const CI_VARIANT_KIND = 'bounded-rule-ci/1' as const;

const boundedResourceBudget: Scenario['resourceBudget'] = {
  optIn: false,
  maxDurationMs: 30_000,
  maxMemoryMb: 512,
  maxOperations: 1_000,
};

type BoundedVariantDefinition = {
  readonly size: Scenario['size'];
  readonly mutationSequence: ReadonlyArray<string>;
  readonly exclusionEvidence: string;
};

const boundedVariantByRule: Readonly<Record<string, BoundedVariantDefinition>> = {
  ['R-FORMULA-004']: {
    size: { rows: 100, graphDepth: 4, graphWidth: 1, fanout: 1 },
    mutationSequence: [
      '更新 100 行的根源值',
      '核对全部 4 层公式结果；不把该结果外推为深度 32 的容量证据',
    ],
    exclusionEvidence: 'CI 只执行 100 行、深度 4；不验证注册规则声明的深度 32 资源极值。',
  },
  ['R-FORMULA-005']: {
    size: { rows: 100, graphDepth: 1, graphWidth: 8, fanout: 8 },
    mutationSequence: [
      '更新 100 行的共享源值',
      '核对全部 8 个同记录公式目标；不把该结果外推为宽度 128 的容量证据',
    ],
    exclusionEvidence: 'CI 只执行 100 行、宽度 8；不验证注册规则声明的宽度 128 资源极值。',
  },
  ['R-PROP-003']: {
    size: { rows: 100, graphDepth: 2, graphWidth: 8, fanout: 100 },
    mutationSequence: [
      '更新唯一共享源值',
      '核对有界夹具中的全部 100 个关联目标；不把该结果外推为扇出 10000 的容量证据',
    ],
    exclusionEvidence:
      'CI 连接并核对有界夹具的全部 100 个目标；不验证扇出 10000 或 100000 行资源极值。',
  },
  ['R-PROP-004']: {
    size: { rows: 100, graphDepth: 4, graphWidth: 8, fanout: 100 },
    mutationSequence: [
      '生成确定性 100 行数据并记录独立聚合基线',
      '更新预算内的一条源记录',
      '用独立聚合核对 100 行内的目标数量和值；不把该结果外推为百万行容量证据',
    ],
    exclusionEvidence: 'CI 只执行 100 行聚合传播；不验证 1000000 行的容量、时长或内存行为。',
  },
};

const stringCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const cardinalityCost: Readonly<Record<Scenario['profile']['cardinality'], number>> = {
  low: 0,
  medium: 1,
  high: 2,
};
const distributionCost: Readonly<Record<Scenario['profile']['distribution'], number>> = {
  uniform: 0,
  sparse: 1,
  hotspot: 2,
  zipf: 3,
};

function compareScenarioCost(left: Scenario, right: Scenario): number {
  const costs: ReadonlyArray<readonly [number, number]> = [
    [left.profile.textWidth, right.profile.textWidth],
    [cardinalityCost[left.profile.cardinality], cardinalityCost[right.profile.cardinality]],
    [distributionCost[left.profile.distribution], distributionCost[right.profile.distribution]],
    [left.size.rows, right.size.rows],
    [left.size.graphDepth, right.size.graphDepth],
    [left.size.graphWidth, right.size.graphWidth],
    [left.size.fanout, right.size.fanout],
  ];
  for (const [leftCost, rightCost] of costs) {
    if (leftCost !== rightCost) return leftCost - rightCost;
  }
  return stringCompare(left.scenarioId, right.scenarioId);
}

function boundedVariant(source: Scenario, definition: BoundedVariantDefinition): Scenario {
  const structuralIdentity = canonicalJson({
    variantKind: CI_VARIANT_KIND,
    sourceFullScaleScenarioId: source.scenarioId,
    ruleId: source.ruleId,
    profile: source.profile,
    size: definition.size,
    exclusionEvidence: definition.exclusionEvidence,
  });
  const identity = {
    schemaVersion: source.schemaVersion,
    generatorVersion: source.generatorVersion,
    ruleRegistryVersion: source.ruleRegistryVersion,
    structuralIdentity,
  };
  const scenarioId = `scn_${sha256Hex(canonicalJson(identity))}`;
  const coverageObligationKey = `ci-bounded:${source.ruleId}:${source.scenarioId}`;

  return ScenarioSchema.parse({
    ...source,
    ...identity,
    scenarioId,
    title: `${source.title}（CI 有界变体，不代表完整资源档位）`,
    description: `复用规则 ${source.ruleId} 的真实模板验证有界语义，不宣称覆盖完整资源档位。排除证据：${definition.exclusionEvidence}`,
    distinctnessReason: {
      behaviorInput: `${source.ruleId} 的 CI 有界语义变体`,
      shapeInput: `100 行、深度 ${definition.size.graphDepth}、宽度 ${definition.size.graphWidth}、扇出 ${definition.size.fanout}`,
      workloadInput: definition.mutationSequence.join(' → '),
      oracleInput: `${source.oracle.strategy} 有界断言；${definition.exclusionEvidence}`,
    },
    coverageObligationKeys: [coverageObligationKey],
    applicability: {
      applicable: true,
      reason: `复用 ${source.fixture.reference} 的真实物化器执行有界语义；${definition.exclusionEvidence}`,
    },
    size: definition.size,
    resourceBudget: boundedResourceBudget,
    fixture: {
      ...source.fixture,
      parameters: {
        ...source.fixture.parameters,
        rows: definition.size.rows,
        graphDepth: definition.size.graphDepth,
        graphWidth: definition.size.graphWidth,
        fanout: definition.size.fanout,
        ciVariantKind: CI_VARIANT_KIND,
        sourceFullScaleScenarioId: source.scenarioId,
        ciExclusionEvidence: definition.exclusionEvidence,
      },
    },
    workload: {
      ...source.workload,
      mutationSequence: definition.mutationSequence,
      targetRows: definition.size.rows,
      queryShape: `ci-bounded:${source.ruleId}`,
    },
    oracle: {
      ...source.oracle,
      expected: `仅核对 CI 有界夹具；${definition.exclusionEvidence}`,
      expectedRows: definition.size.rows,
      assertions: [...source.oracle.assertions, `CI 有界排除：${definition.exclusionEvidence}`],
    },
  });
}

function requestedRules(families: ReadonlyArray<string> | undefined): ReadonlyArray<Rule> {
  const knownFamilies: ReadonlySet<string> = new Set(ruleRegistry.rules.map((rule) => rule.family));
  if (families !== undefined && families.length === 0) {
    throw new Error('bench.ci.families.empty: an explicit family filter must contain a family');
  }
  const requestedFamilies = families === undefined ? knownFamilies : new Set(families);
  const unknown = [...requestedFamilies].filter((family) => !knownFamilies.has(family)).sort();
  if (unknown.length > 0) {
    throw new Error(`bench.ci.families.unknown: ${unknown.join(', ')}`);
  }
  return ruleRegistry.rules.filter((rule) => requestedFamilies.has(rule.family));
}

/**
 * Selects one deterministic, materializable CI case for every requested registered rule.
 * Full-scale opt-in rules are represented by explicit bounded variants, never by relabeling
 * the full-scale catalogue scenario as CI-safe.
 */
export function selectCiScenarios(
  scenarios: ReadonlyArray<Scenario>,
  families?: ReadonlyArray<string>
): ReadonlyArray<Scenario> {
  const rules = requestedRules(families);
  const familySet = new Set(rules.map((rule) => rule.family));
  const runnable = scenarios.filter(
    (scenario) =>
      familySet.has(scenario.family) &&
      scenario.executionStatus === 'planned' &&
      scenario.applicability.applicable
  );
  if (runnable.length === 0) {
    throw new Error(
      `bench.ci.scenarios.none: no runnable cases for families ${[...familySet].sort().join(', ')}`
    );
  }

  const familiesWithoutCases = [...familySet]
    .filter((family) => !runnable.some((scenario) => scenario.family === family))
    .sort();
  if (familiesWithoutCases.length > 0) {
    throw new Error(`bench.ci.families.no_cases: ${familiesWithoutCases.join(', ')}`);
  }

  const candidatesByRule = new Map<string, Scenario[]>();
  for (const scenario of runnable) {
    const candidates = candidatesByRule.get(scenario.ruleId) ?? [];
    candidates.push(scenario);
    candidatesByRule.set(scenario.ruleId, candidates);
  }
  const missingRuleIds = rules
    .filter((rule) => !candidatesByRule.has(rule.ruleId))
    .map((rule) => rule.ruleId)
    .sort();
  if (missingRuleIds.length > 0) {
    throw new Error(`bench.ci.rules.missing: ${missingRuleIds.join(', ')}`);
  }

  return rules
    .map((rule) => {
      const source = [...candidatesByRule.get(rule.ruleId)!].sort(compareScenarioCost)[0]!;
      if (!source.resourceBudget.optIn) return source;
      const definition = boundedVariantByRule[rule.ruleId];
      if (!definition) {
        throw new Error(
          `bench.ci.rules.unbounded_opt_in: ${rule.ruleId} has no explicit bounded CI variant`
        );
      }
      return boundedVariant(source, definition);
    })
    .sort(
      (left, right) =>
        stringCompare(left.family, right.family) || stringCompare(left.ruleId, right.ruleId)
    );
}
