import { describe, expect, it } from 'vitest';

import type { BenchWorkloadStep } from '../case/manifest';
import { enumerateScenarioCatalogue } from './enumerate';
import { graphTemplateForScenario } from './templatesGraph';

const graphTemplate = (ruleId: string) => {
  const scenario = enumerateScenarioCatalogue().scenarios.find(
    (candidate) => candidate.ruleId === ruleId
  );
  if (!scenario) throw new Error(`Missing graph scenario for ${ruleId}`);
  const template = graphTemplateForScenario(scenario);
  if (!template) throw new Error(`Missing graph template for ${ruleId}`);
  return { scenario, template };
};

const fullRecomputeCheckpoints = (workload: ReadonlyArray<BenchWorkloadStep>) =>
  workload.filter(
    (
      step
    ): step is Extract<BenchWorkloadStep, { kind: 'checkpoint' }> & {
      check: Extract<
        Extract<BenchWorkloadStep, { kind: 'checkpoint' }>['check'],
        { kind: 'full-recompute' }
      >;
    } => step.kind === 'checkpoint' && step.check.kind === 'full-recompute'
  );

const checkpointIdentity = (scenarioId: string, transition: number, suffix: string) => ({
  key: ['transition', transition, 'checkpoint', suffix].join('-'),
  checkId: `${scenarioId}/${['transition', transition].join('-')}/${suffix}`,
});

describe('graph catalogue reference reuse', () => {
  it.each([
    ['R-FORMULA-004', 'FormulaDepth', 'Level'],
    ['R-FORMULA-005', 'FormulaWidth', 'Target'],
  ] as const)(
    'reuses only the deterministic final full recompute for %s',
    (ruleId, table, computedPrefix) => {
      const { scenario, template } = graphTemplate(ruleId);
      const stateChecks = template.workload.filter(
        (
          step
        ): step is Extract<BenchWorkloadStep, { kind: 'checkpoint' }> & {
          check: Extract<
            Extract<BenchWorkloadStep, { kind: 'checkpoint' }>['check'],
            { kind: 'field-values' }
          >;
        } => step.kind === 'checkpoint' && step.check.kind === 'field-values'
      );
      const depthOrWidth =
        ruleId === 'R-FORMULA-004' ? scenario.size.graphDepth : scenario.size.graphWidth;
      const sourceSuffix = ruleId === 'R-FORMULA-004' ? 'root' : 'shared-source';
      const computedSuffix = ruleId === 'R-FORMULA-004' ? 'level' : 'target';
      const suffixWidth = ruleId === 'R-FORMULA-004' ? 2 : 3;
      const expectedStates = [
        {
          ...checkpointIdentity(scenario.scenarioId, 1, sourceSuffix),
          table,
          field: 'Amount',
        },
        ...Array.from({ length: depthOrWidth }, (_, index) => ({
          ...checkpointIdentity(
            scenario.scenarioId,
            2,
            `${computedSuffix}-${String(index + 1).padStart(suffixWidth, '0')}`
          ),
          table,
          field: `${computedPrefix}${index + 1}`,
        })),
      ];

      expect(fullRecomputeCheckpoints(template.workload)).toEqual([]);
      expect(
        stateChecks.map((step) => ({
          key: step.key,
          checkId: step.check.checkId,
          table: step.check.table,
          field: step.check.field,
        }))
      ).toEqual(expectedStates);
      expect(template.oracle).toEqual([
        expect.objectContaining({
          key: 'catalogue-graph-final-oracle',
          kind: 'full-recompute',
          tables: [table],
          reuse: 'identical-state',
        }),
      ]);
    }
  );

  it.each(['R-PROP-001', 'R-PROP-002', 'R-PROP-003'] as const)(
    'keeps every %s propagation state in its own scope while reusing identical samples',
    (ruleId) => {
      const { scenario, template } = graphTemplate(ruleId);
      const checkpoints = fullRecomputeCheckpoints(template.workload);
      const expected = (() => {
        switch (ruleId) {
          case 'R-PROP-001': {
            const tables = [
              'PropagationSource',
              ...Array.from(
                { length: scenario.size.graphDepth },
                (_, index) => `PropagationHop${index + 1}`
              ),
            ];
            return {
              tables,
              states: [
                checkpointIdentity(scenario.scenarioId, 1, 'root-update'),
                ...Array.from({ length: scenario.size.graphDepth }, (_, index) =>
                  checkpointIdentity(scenario.scenarioId, 2, `hop-${index + 1}`)
                ),
              ],
            };
          }
          case 'R-PROP-002':
            return {
              tables: ['DiamondSource', 'DiamondLeft', 'DiamondRight', 'DiamondJoin'],
              states: [
                checkpointIdentity(scenario.scenarioId, 1, 'shared-source'),
                checkpointIdentity(scenario.scenarioId, 2, 'left-branch'),
                checkpointIdentity(scenario.scenarioId, 2, 'right-branch'),
                checkpointIdentity(scenario.scenarioId, 2, 'join'),
              ],
            };
          case 'R-PROP-003':
            return {
              tables: ['FanoutSource', 'FanoutTargets'],
              states: [
                checkpointIdentity(scenario.scenarioId, 1, 'shared-source'),
                checkpointIdentity(
                  scenario.scenarioId,
                  2,
                  `all-${Math.min(scenario.size.fanout, scenario.size.rows)}-targets`
                ),
              ],
            };
        }
      })();

      expect(checkpoints.map((step) => ({ key: step.key, checkId: step.check.checkId }))).toEqual(
        expected.states
      );
      for (const step of checkpoints) {
        expect(step.check).toMatchObject({
          kind: 'full-recompute',
          tables: expected.tables,
          reuse: 'identical-state',
        });
      }
      expect(template.oracle).toEqual([
        expect.objectContaining({
          key: 'catalogue-graph-final-oracle',
          kind: 'full-recompute',
          tables: expected.tables,
          reuse: 'identical-state',
        }),
      ]);
    }
  );

  it('does not infer reference reuse for R-PROP-004 dynamic record mutations', () => {
    const { template } = graphTemplate('R-PROP-004');
    const checkpoints = template.workload.filter((step) => step.kind === 'checkpoint');

    expect(checkpoints.map((step) => [step.key, step.check.kind])).toEqual([
      [checkpointIdentity('', 1, 'deterministic-dataset-aggregate').key, 'query-values'],
      [checkpointIdentity('', 2, 'budgeted-source-update').key, 'query-values'],
      [checkpointIdentity('', 3, 'bounded-independent-aggregate').key, 'query-values'],
    ]);
    expect(fullRecomputeCheckpoints(template.workload)).toEqual([]);
    expect(template.oracle).toEqual([
      expect.objectContaining({
        key: 'catalogue-million-row-row-count-oracle',
        kind: 'invariant',
      }),
    ]);
    expect(template.oracle.some((oracle) => 'reuse' in oracle)).toBe(false);
  });
});
