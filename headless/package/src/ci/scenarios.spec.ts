import { describe, expect, it } from 'vitest';

import {
  enumerateScenarioCatalogue,
  isMaterializableRule,
  ruleRegistry,
  type Scenario,
} from '../catalogue';
import { selectCiScenarios } from './scenarios';

const boundedSizes: Readonly<Record<string, Scenario['size']>> = {
  ['R-FORMULA-004']: { rows: 100, graphDepth: 4, graphWidth: 1, fanout: 1 },
  ['R-FORMULA-005']: { rows: 100, graphDepth: 1, graphWidth: 8, fanout: 8 },
  ['R-PROP-003']: { rows: 100, graphDepth: 2, graphWidth: 8, fanout: 100 },
  ['R-PROP-004']: { rows: 100, graphDepth: 4, graphWidth: 8, fanout: 100 },
};

const profileCost = (scenario: Scenario): ReadonlyArray<number> => [
  scenario.profile.textWidth,
  { low: 0, medium: 1, high: 2 }[scenario.profile.cardinality],
  { uniform: 0, sparse: 1, hotspot: 2, zipf: 3 }[scenario.profile.distribution],
];

const compareNumbers = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): number => {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
};

describe('selectCiScenarios', () => {
  it('selects one materializable bounded case for every one of the 31 registered rules', () => {
    const catalogue = enumerateScenarioCatalogue();
    const selected = selectCiScenarios(catalogue.scenarios);

    expect(catalogue.scenarios).toHaveLength(82);
    expect(ruleRegistry.rules).toHaveLength(31);
    expect(selected).toHaveLength(ruleRegistry.rules.length);
    expect(new Set(selected.map((scenario) => scenario.ruleId))).toEqual(
      new Set(ruleRegistry.rules.map((rule) => rule.ruleId))
    );
    expect(selected.every((scenario) => scenario.executionStatus === 'planned')).toBe(true);
    expect(selected.every((scenario) => scenario.applicability.applicable)).toBe(true);
    expect(selected.every((scenario) => !scenario.resourceBudget.optIn)).toBe(true);
    expect(selected.every((scenario) => isMaterializableRule(scenario.ruleId))).toBe(true);
    expect(selected.map((scenario) => `${scenario.family}/${scenario.ruleId}`)).toEqual(
      [...selected]
        .sort(
          (left, right) =>
            left.family.localeCompare(right.family) || left.ruleId.localeCompare(right.ruleId)
        )
        .map((scenario) => `${scenario.family}/${scenario.ruleId}`)
    );
  });

  it('derives explicit bounded variants for the four opt-in rules without changing the catalogue', () => {
    const catalogue = enumerateScenarioCatalogue();
    const selected = selectCiScenarios(catalogue.scenarios);
    const optInSources = catalogue.scenarios.filter((scenario) => scenario.resourceBudget.optIn);

    expect(optInSources.map((scenario) => scenario.ruleId).sort()).toEqual(
      Object.keys(boundedSizes).sort()
    );
    for (const source of optInSources) {
      const variant = selected.find((scenario) => scenario.ruleId === source.ruleId)!;
      expect(variant.scenarioId).not.toBe(source.scenarioId);
      expect(variant.size).toEqual(boundedSizes[source.ruleId]);
      expect(variant.resourceBudget).toEqual({
        optIn: false,
        maxDurationMs: 30_000,
        maxMemoryMb: 512,
        maxOperations: 1_000,
      });
      expect(variant.fixture.reference).toBe(source.fixture.reference);
      expect(variant.fixture.parameters).toMatchObject({
        ciVariantKind: 'bounded-rule-ci/1',
        sourceFullScaleScenarioId: source.scenarioId,
        rows: 100,
      });
      expect(variant.fixture.parameters.ciExclusionEvidence).toEqual(
        expect.stringContaining('不验证')
      );
      expect(variant.description).toContain('验证有界语义，不宣称覆盖完整资源档位');
      expect(variant.description).toContain(String(variant.fixture.parameters.ciExclusionEvidence));
      expect(variant.coverageObligationKeys).toEqual([
        `ci-bounded:${source.ruleId}:${source.scenarioId}`,
      ]);
      expect(variant.workload.targetRows).toBe(100);
      expect(variant.oracle.expectedRows).toBe(100);
      expect(variant.workload.mutationSequence.join('；')).toContain('不把该结果外推');
    }

    expect(enumerateScenarioCatalogue()).toEqual(catalogue);
  });

  it('chooses the cheapest profile deterministically instead of selecting by scenario hash', () => {
    const catalogue = enumerateScenarioCatalogue();
    const selected = selectCiScenarios(catalogue.scenarios);
    const reversed = selectCiScenarios([...catalogue.scenarios].reverse());

    expect(reversed.map((scenario) => scenario.scenarioId)).toEqual(
      selected.map((scenario) => scenario.scenarioId)
    );
    for (const rule of ruleRegistry.rules) {
      const candidates = catalogue.scenarios.filter(
        (scenario) =>
          scenario.ruleId === rule.ruleId &&
          scenario.executionStatus === 'planned' &&
          scenario.applicability.applicable
      );
      const minimumProfileCost = candidates.map(profileCost).sort(compareNumbers)[0]!;
      expect(profileCost(selected.find((scenario) => scenario.ruleId === rule.ruleId)!)).toEqual(
        minimumProfileCost
      );
    }
  });

  it('keeps family legs grouped while selecting every rule in the requested families', () => {
    const catalogue = enumerateScenarioCatalogue();
    const selected = selectCiScenarios(catalogue.scenarios, ['formula', 'lookup']);
    const expectedRuleIds = ruleRegistry.rules
      .filter((rule) => rule.family === 'formula' || rule.family === 'lookup')
      .map((rule) => rule.ruleId);

    expect(new Set(selected.map((scenario) => scenario.ruleId))).toEqual(new Set(expectedRuleIds));
    expect(selected.map((scenario) => scenario.family)).toEqual(
      [...selected.map((scenario) => scenario.family)].sort()
    );
  });

  it('rejects empty or unknown family filters, families without cases, and missing rules', () => {
    const catalogue = enumerateScenarioCatalogue();
    const formulaScenarios = catalogue.scenarios.filter(
      (scenario) => scenario.family === 'formula'
    );

    expect(() => selectCiScenarios(catalogue.scenarios, [])).toThrow('bench.ci.families.empty');
    expect(() => selectCiScenarios(catalogue.scenarios, ['unknown-family'])).toThrow(
      'bench.ci.families.unknown'
    );
    expect(() => selectCiScenarios([], ['formula'])).toThrow('bench.ci.scenarios.none');
    expect(() => selectCiScenarios(formulaScenarios, ['formula', 'lookup'])).toThrow(
      'bench.ci.families.no_cases: lookup'
    );
    expect(() =>
      selectCiScenarios(
        formulaScenarios.filter((scenario) => scenario.ruleId !== 'R-FORMULA-006'),
        ['formula']
      )
    ).toThrow('bench.ci.rules.missing: R-FORMULA-006');
  });
});
