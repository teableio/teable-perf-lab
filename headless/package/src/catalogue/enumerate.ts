import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import { generateCoveringArray, pairLabel, type CoveringRow } from '../generator/coveringArray';
import {
  isMaterializableRule,
  runnableTemplateByRule,
  unsupportedReasonByRule,
} from './materialize';
import { ruleRegistry } from './registry';
import {
  CATALOGUE_GENERATOR_VERSION,
  CATALOGUE_SCHEMA_VERSION,
  RULE_REGISTRY_VERSION,
  ScenarioCatalogueSchema,
  ScenarioSchema,
  type CatalogueReceipt,
  type Rule,
  type Scenario,
  type ScenarioCatalogue,
} from './schema';

export type CatalogueBounds = {
  readonly maxCases?: number;
  readonly maxSearchStates?: number;
  readonly maxMillis?: number;
};

const nuisanceDomains = [
  { name: 'distribution', values: ['uniform', 'zipf', 'hotspot', 'sparse'] },
  { name: 'cardinality', values: ['low', 'medium', 'high'] },
  { name: 'textWidth', values: [16, 256, 4096] },
] as const;

function profileFromRow(row: CoveringRow): Scenario['profile'] {
  return {
    distribution: row.distribution as Scenario['profile']['distribution'],
    cardinality: row.cardinality as Scenario['profile']['cardinality'],
    textWidth: row.textWidth as Scenario['profile']['textWidth'],
  };
}

const baseProfile: Scenario['profile'] = {
  distribution: 'uniform',
  cardinality: 'low',
  textWidth: 16,
};

function coveredPairLabels(profiles: ReadonlyArray<Scenario['profile']>): ReadonlySet<string> {
  const labels = new Set<string>();
  for (const profile of profiles) {
    for (let left = 0; left < nuisanceDomains.length; left += 1) {
      for (let right = left + 1; right < nuisanceDomains.length; right += 1) {
        const leftDomain = nuisanceDomains[left]!;
        const rightDomain = nuisanceDomains[right]!;
        labels.add(
          pairLabel(
            leftDomain.name,
            profile[leftDomain.name],
            rightDomain.name,
            profile[rightDomain.name]
          )
        );
      }
    }
  }
  return labels;
}

function structuralValues(rule: Rule): Pick<Scenario, 'size' | 'resourceBudget'> {
  if (rule.templateId === 'million-row-propagation') {
    return {
      size: { rows: 1_000_000, graphDepth: 4, graphWidth: 8, fanout: 10_000 },
      resourceBudget: {
        optIn: true,
        maxDurationMs: 1_800_000,
        maxMemoryMb: 8192,
        maxOperations: 100_000,
      },
    };
  }
  if (rule.templateId === 'high-fanout') {
    return {
      size: { rows: 100_000, graphDepth: 2, graphWidth: 8, fanout: 10_000 },
      resourceBudget: {
        optIn: true,
        maxDurationMs: 900_000,
        maxMemoryMb: 4096,
        maxOperations: 100_000,
      },
    };
  }
  if (rule.templateId === 'formula-depth') {
    return {
      size: { rows: 10_000, graphDepth: 32, graphWidth: 1, fanout: 1 },
      resourceBudget: {
        optIn: true,
        maxDurationMs: 300_000,
        maxMemoryMb: 2048,
        maxOperations: 50_000,
      },
    };
  }
  if (rule.templateId === 'formula-width') {
    return {
      size: { rows: 10_000, graphDepth: 1, graphWidth: 128, fanout: 128 },
      resourceBudget: {
        optIn: true,
        maxDurationMs: 300_000,
        maxMemoryMb: 2048,
        maxOperations: 50_000,
      },
    };
  }
  if (rule.templateId.includes('empty')) {
    return {
      size: {
        rows: rule.templateId === 'conditional-empty' ? 100 : 0,
        graphDepth: 1,
        graphWidth: 1,
        fanout: 0,
      },
      resourceBudget: {
        optIn: false,
        maxDurationMs: 30_000,
        maxMemoryMb: 512,
        maxOperations: 1000,
      },
    };
  }
  return {
    size: {
      rows: 100,
      graphDepth: rule.family === 'propagation' ? 4 : 1,
      graphWidth: 4,
      fanout: 4,
    },
    resourceBudget: { optIn: false, maxDurationMs: 30_000, maxMemoryMb: 512, maxOperations: 1000 },
  };
}

function scenarioFor(rule: Rule, profile: Scenario['profile']): Scenario {
  const structural = structuralValues(rule);
  const materializable = isMaterializableRule(rule.ruleId);
  const structuralIdentity = canonicalJson({
    ruleId: rule.ruleId,
    templateId: rule.templateId,
    mutationBoundary: rule.mutationBoundary,
    transitionSequence: rule.transitionSequence,
    oracle: rule.oracle,
    size: structural.size,
    profile,
  });
  const identity = {
    schemaVersion: CATALOGUE_SCHEMA_VERSION,
    generatorVersion: CATALOGUE_GENERATOR_VERSION,
    ruleRegistryVersion: RULE_REGISTRY_VERSION,
    structuralIdentity,
  };
  const scenarioId = `scn_${sha256Hex(canonicalJson(identity))}`;
  const expectedRows = structural.size.rows;
  return ScenarioSchema.parse({
    ...identity,
    scenarioId,
    ruleId: rule.ruleId,
    title: rule.title,
    description: `${rule.description} 数据和操作均由 ${rule.templateId} 模板确定性生成。`,
    severity: rule.severity,
    family: rule.family,
    executionStatus: materializable ? 'planned' : 'unsupported',
    evidenceKind: 'exact-test-data',
    ...(materializable
      ? {}
      : {
          unsupportedReason:
            unsupportedReasonByRule[rule.ruleId] ??
            '规则已进入注册表，但当前 typed workload/oracle 尚不能逐状态证明该规则',
        }),
    distinctnessReason: {
      behaviorInput: `${rule.ruleId}：${rule.mutationBoundary}`,
      shapeInput: `深度 ${structural.size.graphDepth}、宽度 ${structural.size.graphWidth}、扇出 ${structural.size.fanout}`,
      workloadInput: rule.transitionSequence.join(' → '),
      oracleInput: `${rule.oracle.strategy}：${rule.oracle.assertions.join('；')}`,
    },
    structuralIdentity,
    coverageObligationKeys: [`synthetic:${rule.ruleId}:${rule.templateId}`],
    applicability: {
      applicable: rule.supported,
      reason: materializable
        ? `使用现有真实模板 ${runnableTemplateByRule[rule.ruleId]} 物化为 manifest、workload 与 full-recompute oracle`
        : rule.supported
          ? (unsupportedReasonByRule[rule.ruleId] ??
            '规则结构适用，但 typed workload/oracle 尚不能逐状态证明')
          : (rule.unsupportedReason ?? '规则没有可执行适配器'),
    },
    interaction: rule.interaction,
    profile,
    ...structural,
    fixture: {
      kind: materializable ? 'deterministic-template' : 'named-unsupported-gap',
      reference: materializable
        ? `materializer:${runnableTemplateByRule[rule.ruleId]}@${CATALOGUE_GENERATOR_VERSION}`
        : `catalogue:${rule.templateId}@${RULE_REGISTRY_VERSION}`,
      revision: RULE_REGISTRY_VERSION,
      parameters: {
        distribution: profile.distribution,
        cardinality: profile.cardinality,
        textWidth: profile.textWidth,
        rows: structural.size.rows,
      },
    },
    workload: {
      mutationSequence: rule.transitionSequence,
      operation: rule.mutationClass,
      targetRows: expectedRows,
      batchSize: rule.mutationClass === 'batch' ? 100 : 1,
      queryShape: rule.templateId,
    },
    oracle: {
      strategy: rule.oracle.strategy,
      expected: rule.oracle.assertions.join('；'),
      expectedRows,
      permitsNull: rule.oracle.permitsNull,
      assertions: rule.oracle.assertions,
    },
  });
}

function pairwiseCompatible(rule: Rule): boolean {
  return rule.interaction.kind === 'pairwise';
}

function positiveBound(name: keyof CatalogueBounds, value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function enumerateScenarioCatalogue(bounds: CatalogueBounds = {}): ScenarioCatalogue {
  const maxCases = positiveBound('maxCases', bounds.maxCases ?? 10_000);
  const maxSearchStates = positiveBound('maxSearchStates', bounds.maxSearchStates ?? 100_000);
  const maxMillis = positiveBound('maxMillis', bounds.maxMillis ?? 1000);
  const gaps: string[] = ruleRegistry.knownGaps.map(
    (gap) => `${gap.gapId}：${gap.title}；${gap.reason}`
  );
  const pairwiseRules = ruleRegistry.rules.filter(pairwiseCompatible);
  const mandatoryRules = ruleRegistry.rules.filter((rule) => !pairwiseCompatible(rule));
  const pairwise = generateCoveringArray({
    dimensions: nuisanceDomains.map((domain) => ({ name: domain.name, values: domain.values })),
    maxSearchStates,
    maxMillis,
  });
  const pairProfiles = pairwise.rows.map(profileFromRow);
  const candidates = [
    ...mandatoryRules.map((rule) => scenarioFor(rule, baseProfile)),
    ...pairwiseRules.flatMap((rule) => pairProfiles.map((profile) => scenarioFor(rule, profile))),
  ];
  const scenarios = candidates.slice(0, maxCases);
  const omitted = candidates.slice(maxCases);
  const truncated = omitted.length > 0 || pairwise.receipt.truncated;
  if (omitted.length > 0) {
    gaps.push(
      `目录上限省略 ${omitted.length} 个场景：${omitted.map((scenario) => `${scenario.ruleId}/${scenario.scenarioId}`).join('、')}`
    );
  }
  if (pairwise.receipt.truncated) {
    gaps.push(`成对因素搜索达到边界，未知因素对：${pairwise.receipt.unknownPairs.join('、')}`);
  }

  const plannedPairCount = pairwiseRules.reduce((total, rule) => {
    const profiles = scenarios
      .filter((scenario) => scenario.ruleId === rule.ruleId)
      .map((scenario) => scenario.profile);
    return total + coveredPairLabels(profiles).size;
  }, 0);
  const unsupported = scenarios.filter(
    (scenario) => scenario.executionStatus === 'unsupported'
  ).length;
  const planned = scenarios.filter((scenario) => scenario.executionStatus === 'planned').length;
  const rawPairs = pairwise.receipt.rawPairCount * pairwiseRules.length;
  const completable = pairwise.receipt.completable * pairwiseRules.length;
  const nonCompletable = pairwise.receipt.nonCompletable * pairwiseRules.length;
  const receipt: CatalogueReceipt = {
    requested: candidates.length,
    applicable: candidates.filter((scenario) => scenario.applicability.applicable).length,
    planned,
    executed: 0,
    pass: 0,
    fail: 0,
    skipped: omitted.length,
    unsupported,
    requestedRules: ruleRegistry.rules.length,
    applicableRules: new Set(
      candidates
        .filter((scenario) => scenario.applicability.applicable)
        .map((scenario) => scenario.ruleId)
    ).size,
    pairwiseRuleIds: pairwiseRules.map((rule) => rule.ruleId),
    factorDomains: nuisanceDomains.map((domain) => ({
      name: domain.name,
      values: [...domain.values],
    })),
    rawPairCountFormula: `逐规则计算：${pairwiseRules.length}×(${pairwise.receipt.rawPairCountFormula}) = ${rawPairs}`,
    rawPairCount: rawPairs,
    completable,
    plannedPairCount,
    executedPairVerifiedCount: 0,
    nonCompletable,
    truncated,
    searchStates: pairwise.receipt.searchStates,
    bounds: { maxCases, maxSearchStates, maxMillis },
    gaps,
  };
  return ScenarioCatalogueSchema.parse({
    schemaVersion: CATALOGUE_SCHEMA_VERSION,
    generatorVersion: CATALOGUE_GENERATOR_VERSION,
    ruleRegistryVersion: RULE_REGISTRY_VERSION,
    scenarios,
    receipt,
  });
}

export function renderCatalogueMarkdown(catalogueInput: ScenarioCatalogue): string {
  const catalogue = ScenarioCatalogueSchema.parse(catalogueInput);
  const lines = [
    '# Teable Headless 场景目录',
    '',
    `- 规则版本：${catalogue.ruleRegistryVersion}`,
    `- 生成器版本：${catalogue.generatorVersion}`,
    `- 请求规则：${catalogue.receipt.requestedRules}`,
    `- 已计划场景：${catalogue.receipt.planned}`,
    `- 已执行：${catalogue.receipt.executed}（通过 ${catalogue.receipt.pass}，失败 ${catalogue.receipt.fail}）`,
    `- 截断：${catalogue.receipt.truncated ? '是' : '否'}`,
    '',
    '完整性只相对于上述规则版本、输入结构和资源边界，不代表覆盖所有 Teable 行为。',
    '',
    '## 场景',
    '',
    '| 场景 | 规则 | 严重度 | 状态 | 测什么 | 为什么不同 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const scenario of catalogue.scenarios) {
    lines.push(
      `| ${scenario.title} | ${scenario.ruleId} | ${scenario.severity.join('、')} | ${scenario.executionStatus} | ${scenario.description} | ${scenario.distinctnessReason.behaviorInput}；${scenario.distinctnessReason.shapeInput}；${scenario.distinctnessReason.workloadInput} |`
    );
  }
  lines.push('', '## 已知缺口', '');
  for (const gap of catalogue.receipt.gaps) lines.push(`- ${gap}`);
  lines.push(
    '',
    '## 覆盖计算',
    '',
    `- 原始因素对：${catalogue.receipt.rawPairCountFormula}`,
    `- 可完成因素对：${catalogue.receipt.completable}`,
    `- 已纳入计划：${catalogue.receipt.plannedPairCount}`,
    `- 已执行并由断言验证：${catalogue.receipt.executedPairVerifiedCount}`,
    `- 不可完成：${catalogue.receipt.nonCompletable}`,
    ''
  );
  return lines.join('\n');
}
