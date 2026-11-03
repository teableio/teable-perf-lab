import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../case/canonicalJson';
import { enumerateScenarioCatalogue, renderCatalogueMarkdown } from './enumerate';
import { deriveCoverageObligations, findCoverageGaps, receiptForCoveragePlan } from './obligations';
import { ruleRegistry } from './registry';
import { ScenarioCatalogueSchema, type CatalogueGraph } from './schema';

const diamondGraph: CatalogueGraph = {
  schemaId: 'schema-diamond',
  replayMode: 'synthetic-data',
  tables: [
    {
      tableId: 'tbl_source',
      name: '源表',
      fields: [
        {
          fieldId: 'fld_source',
          name: '源值',
          kind: 'number',
          writable: true,
          nullable: true,
          dependencies: [],
        },
        {
          fieldId: 'fld_left',
          name: '左分支',
          kind: 'formula',
          writable: false,
          nullable: true,
          dependencies: [
            {
              tableId: 'tbl_source',
              fieldId: 'fld_source',
              edgeId: 'edge_source_left',
              relationship: 'same-record',
            },
          ],
        },
        {
          fieldId: 'fld_right',
          name: '右分支',
          kind: 'formula',
          writable: false,
          nullable: true,
          dependencies: [
            {
              tableId: 'tbl_source',
              fieldId: 'fld_source',
              edgeId: 'edge_source_right',
              relationship: 'same-record',
            },
          ],
        },
        {
          fieldId: 'fld_join',
          name: '汇合值',
          kind: 'formula',
          writable: false,
          nullable: true,
          dependencies: [
            {
              tableId: 'tbl_source',
              fieldId: 'fld_left',
              edgeId: 'edge_left_join',
              relationship: 'same-record',
            },
            {
              tableId: 'tbl_source',
              fieldId: 'fld_right',
              edgeId: 'edge_right_join',
              relationship: 'same-record',
            },
          ],
        },
      ],
    },
  ],
};

describe('scenario catalogue', () => {
  it('is deterministic, schema-valid and has no identity or semantic aliases', () => {
    const first = enumerateScenarioCatalogue();
    const second = enumerateScenarioCatalogue();

    expect(second).toEqual(first);
    expect(() => ScenarioCatalogueSchema.parse(first)).not.toThrow();
    expect(new Set(first.scenarios.map((scenario) => scenario.scenarioId)).size).toBe(
      first.scenarios.length
    );
    expect(new Set(first.scenarios.map((scenario) => scenario.structuralIdentity)).size).toBe(
      first.scenarios.length
    );
    expect(first.scenarios).toHaveLength(first.receipt.requested);
  });

  it('covers every registry family and forces every rare or extreme transition', () => {
    const catalogue = enumerateScenarioCatalogue();
    const families = new Set(catalogue.scenarios.map((scenario) => scenario.family));
    expect(families).toEqual(new Set(ruleRegistry.rules.map((rule) => rule.family)));

    const required = ruleRegistry.rules.filter(
      (rule) => rule.severity.includes('rare') || rule.severity.includes('extreme')
    );
    for (const rule of required) {
      const scenario = catalogue.scenarios.find((item) => item.ruleId === rule.ruleId);
      expect(scenario?.interaction.kind).toBe('forced');
      expect(scenario?.workload.mutationSequence).toEqual(rule.transitionSequence);
    }
    expect(
      catalogue.scenarios.find((item) => item.ruleId === 'R-WRITE-007')?.workload.mutationSequence
    ).toEqual(['写入初始值并断言初始值', '清空为 null 并断言精确空值', '恢复为不同值并断言恢复值']);
    expect(
      catalogue.scenarios
        .find((item) => item.ruleId === 'R-LINK-002')
        ?.workload.mutationSequence.at(-1)
    ).toContain('最后一个');
    expect(
      catalogue.scenarios.find((item) => item.ruleId === 'R-COND-001')?.distinctnessReason
        .behaviorInput
    ).toContain('false→true→false');
  });

  it('keeps 100k and 1M resource extremes opt-in', () => {
    const catalogue = enumerateScenarioCatalogue();
    for (const scenario of catalogue.scenarios) {
      if (scenario.size.rows >= 100_000) expect(scenario.resourceBudget.optIn).toBe(true);
    }
    expect(catalogue.scenarios.some((scenario) => scenario.size.rows === 1_000_000)).toBe(true);
  });

  it('reports exact factor domains, pair arithmetic and bounded truncation', () => {
    const catalogue = enumerateScenarioCatalogue();
    expect(catalogue.receipt.factorDomains).toEqual([
      { name: 'distribution', values: ['uniform', 'zipf', 'hotspot', 'sparse'] },
      { name: 'cardinality', values: ['low', 'medium', 'high'] },
      { name: 'textWidth', values: [16, 256, 4096] },
    ]);
    const pairwiseRules = ruleRegistry.rules.filter(
      (rule) => rule.interaction.kind === 'pairwise'
    ).length;
    expect(catalogue.receipt.rawPairCount).toBe(pairwiseRules * (4 * 3 + 4 * 3 + 3 * 3));
    expect(catalogue.receipt.plannedPairCount).toBe(catalogue.receipt.completable);
    expect(catalogue.receipt.executedPairVerifiedCount).toBe(0);
    expect(catalogue.receipt.completable + catalogue.receipt.nonCompletable).toBe(
      catalogue.receipt.rawPairCount
    );
    expect(catalogue.receipt.executed).toBe(0);
    expect(catalogue.receipt.planned).toBe(catalogue.scenarios.length);
    expect(catalogue.receipt.unsupported).toBe(0);
    expect(
      catalogue.scenarios
        .filter((scenario) => scenario.executionStatus === 'planned')
        .every(
          (scenario) =>
            scenario.fixture.kind === 'deterministic-template' &&
            scenario.evidenceKind === 'exact-test-data'
        )
    ).toBe(true);
    expect(
      catalogue.scenarios.find((scenario) => scenario.size.rows === 1_000_000)?.oracle.expectedRows
    ).toBe(1_000_000);

    for (const scenario of catalogue.scenarios) {
      expect(scenario.fixture.reference).toMatch(/^(materializer|catalogue):[^@]+@/);
    }
    const bounded = enumerateScenarioCatalogue({ maxCases: 2, maxSearchStates: 100_000 });
    expect(bounded.scenarios).toHaveLength(2);
    expect(bounded.receipt.truncated).toBe(true);
    expect(bounded.receipt.applicable).toBe(catalogue.receipt.applicable);
    expect(bounded.receipt.gaps.join('\n')).toContain('目录上限省略');
    expect(bounded.receipt.gaps.join('\n')).toMatch(/R-[A-Z]+-\d{3}\/scn_/);
    expect(() => enumerateScenarioCatalogue({ maxCases: 0 })).toThrow(
      'maxCases must be a positive integer'
    );
  });

  it('renders a Chinese index from the validated catalogue', () => {
    const markdown = renderCatalogueMarkdown(enumerateScenarioCatalogue());
    expect(markdown).toContain('# Teable Headless 场景目录');
    expect(markdown).toContain('完整性只相对于');
    expect(markdown).toContain('## 已知缺口');
  });
});

describe('schema coverage obligations', () => {
  it('accounts for every exact reachable edge without enumerating diamond paths', () => {
    const first = deriveCoverageObligations(diamondGraph);
    const second = deriveCoverageObligations(diamondGraph);
    expect(second).toEqual(first);
    expect(first.receipt.discoveredEdges).toBe(4);
    expect(first.receipt.declaredSources).toBe(1);
    expect(first.receipt.truncated).toBe(false);
    expect(first.receipt.searchStates).toBeLessThanOrEqual(8);

    const formula = first.obligations.filter(
      (item) => item.ruleId === 'R-FORMULA-001' && item.applicability === 'applicable'
    );
    expect(new Set(formula.map((item) => item.impactedTarget.edgeId))).toEqual(
      new Set(['edge_source_left', 'edge_source_right', 'edge_left_join', 'edge_right_join'])
    );
    expect(new Set(formula.map((item) => item.obligationKey)).size).toBe(formula.length);
  });

  it('makes a missed edge, mutation or rule visible instead of treating a peer as representative', () => {
    const derived = deriveCoverageObligations(diamondGraph);
    const applicable = derived.obligations.filter((item) => item.applicability === 'applicable');
    const planned = new Set(applicable.map((item) => item.obligationKey));
    const removedEdge = applicable.find(
      (item) => item.impactedTarget.edgeId === 'edge_right_join'
    )!;
    const removedMutation = applicable.find((item) => item.mutationClass === 'clear-restore')!;
    const removedRule = applicable.find((item) => item.ruleId === 'R-PROP-002')!;
    planned.delete(removedEdge.obligationKey);
    planned.delete(removedMutation.obligationKey);
    planned.delete(removedRule.obligationKey);

    const gaps = findCoverageGaps(derived.obligations, planned, new Set());
    expect(gaps.some((gap) => gap.includes(removedEdge.obligationKey))).toBe(true);
    expect(gaps.some((gap) => gap.includes(removedMutation.obligationKey))).toBe(true);
    expect(gaps.some((gap) => gap.includes(removedRule.obligationKey))).toBe(true);

    const receipt = receiptForCoveragePlan({
      derived,
      plannedObligationKeys: planned,
      executedObligationKeys: new Set([applicable[0]!.obligationKey]),
      verifiedObligationKeys: new Set(),
    });
    expect(receipt.plannedObligations).toBe(applicable.length - 3);
    expect(receipt.executedObligations).toBe(1);
    expect(receipt.assertionVerifiedObligations).toBe(0);
    expect(receipt.gaps.length).toBeGreaterThanOrEqual(3);
  });

  it('reports unsupported source kinds and explicit search truncation', () => {
    const graph: CatalogueGraph = {
      schemaId: 'unsupported',
      replayMode: 'original-csv',
      tables: [
        {
          tableId: 'tbl',
          name: '表',
          fields: [
            {
              fieldId: 'fld_attachment',
              name: '附件',
              kind: 'attachment',
              writable: true,
              nullable: true,
              dependencies: [],
            },
          ],
        },
      ],
    };
    const unsupported = deriveCoverageObligations(graph);
    expect(unsupported.receipt.unsupportedObligations).toBe(ruleRegistry.rules.length);
    expect(unsupported.obligations.every((item) => item.reason.includes('没有声明'))).toBe(true);

    const truncated = deriveCoverageObligations(diamondGraph, { maxSearchStates: 1 });
    expect(truncated.receipt.truncated).toBe(true);
    expect(truncated.receipt.gaps).not.toEqual([]);
  });

  it('uses stable obligation keys over canonical semantic inputs', () => {
    const keys = deriveCoverageObligations(diamondGraph).obligations.map(
      (item) => item.obligationKey
    );
    expect(canonicalJson([...keys].sort())).toBe(
      canonicalJson(
        [
          ...deriveCoverageObligations(diamondGraph).obligations.map((item) => item.obligationKey),
        ].sort()
      )
    );
  });
});
