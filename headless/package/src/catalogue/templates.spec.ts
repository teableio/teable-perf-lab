import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import { parseBenchCaseManifest, verifyCaseId, type BenchWorkloadStep } from '../case/manifest';
import { runCase } from '../runner/BenchRunner';
import { readTeaArchive } from '../tea/teaZip';
import { enumerateScenarioCatalogue } from './enumerate';
import { materializeCatalogueScenario } from './materialize';

const generatedStructureSchema = z.object({
  tables: z.array(
    z.object({
      fields: z.array(
        z
          .object({
            name: z.string(),
            type: z.string(),
            cellValueType: z.string().optional(),
            options: z.object({ expression: z.string().optional() }).passthrough().optional(),
          })
          .passthrough()
      ),
    })
  ),
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

const materializeRule = async (ruleId: string) => {
  const scenario = enumerateScenarioCatalogue().scenarios.find(
    (candidate) => candidate.ruleId === ruleId
  );
  if (!scenario) throw new Error(`Missing scenario for ${ruleId}`);
  const outDir = await mkdtemp(join(tmpdir(), `headless-${ruleId.toLowerCase()}-`));
  temporaryDirectories.push(outDir);
  const result = await materializeCatalogueScenario({ scenario, outDir });
  const generated = result.cases[0]!;
  const manifest = parseBenchCaseManifest(
    JSON.parse(await readFile(generated.manifestPath, 'utf8')) as unknown
  );
  const archive = readTeaArchive(new Uint8Array(await readFile(generated.teaPath)));
  expect(manifest.caseId).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(() =>
    verifyCaseId(manifest, sha256Hex(canonicalJson(archive.structure)), archive.csvByEntry)
  ).not.toThrow();
  return {
    scenario,
    manifest,
    structure: generatedStructureSchema.parse(archive.structure),
    generated,
  };
};

const fieldValueChecks = (workload: ReadonlyArray<BenchWorkloadStep>, field: string) =>
  workload.filter(
    (
      step
    ): step is Extract<BenchWorkloadStep, { kind: 'checkpoint' }> & {
      check: { kind: 'field-values' };
    } =>
      step.kind === 'checkpoint' && step.check.kind === 'field-values' && step.check.field === field
  );

describe('catalogue semantic templates', () => {
  it('materializes formula null clearing and restoration as exact values', async () => {
    const { scenario, manifest, structure } = await materializeRule('R-FORMULA-002');
    const table = structure.tables[0]!;
    const formula = table.fields.find((field) => field.name === 'NullableDouble')!;
    expect(formula).toMatchObject({ type: 'formula' });
    expect(formula.options?.expression).toContain('BLANK()');

    const updates = manifest.workload.filter(
      (step): step is Extract<BenchWorkloadStep, { kind: 'write-update' }> =>
        step.kind === 'write-update'
    );
    expect(updates.map((step) => [step.field, step.value])).toEqual([
      ['Amount', { kind: 'literal', value: null }],
      ['Amount', { kind: 'literal', value: 7 }],
    ]);
    expect(
      fieldValueChecks(manifest.workload, 'NullableDouble').map((step) => step.check.expected)
    ).toEqual([
      Array.from({ length: scenario.size.rows }, () => null),
      Array.from({ length: scenario.size.rows }, () => 14),
    ]);
  });

  it('materializes an actual formula error value followed by recovery', async () => {
    const { scenario, manifest, structure } = await materializeRule('R-FORMULA-003');
    const table = structure.tables[0]!;
    const formula = table.fields.find((field) => field.name === 'DivisionStatus')!;
    expect(formula.options?.expression).toContain('ERROR("division by zero")');
    expect(formula.options?.expression).toContain('IS_ERROR(12/');

    const expected = fieldValueChecks(manifest.workload, 'DivisionStatus').map(
      (step) => step.check.expected
    );
    expect(expected).toEqual([
      Array.from({ length: scenario.size.rows }, () => 'quotient available'),
      Array.from({ length: scenario.size.rows }, () => '#ERROR: division by zero'),
      Array.from({ length: scenario.size.rows }, () => 'quotient available'),
    ]);
    expect(
      manifest.workload
        .filter((step) => step.kind === 'write-update')
        .map((step) => (step.kind === 'write-update' ? step.value : undefined))
    ).toEqual([
      { kind: 'literal', value: 3 },
      { kind: 'literal', value: 0 },
      { kind: 'literal', value: 4 },
    ]);
  });

  it('materializes numeric, text, date, boolean and select formula boundaries', async () => {
    const { scenario, manifest, structure } = await materializeRule('R-FORMULA-006');
    const fields = structure.tables[0]!.fields;
    expect(
      ['NumberSource', 'TextSource', 'DateSource', 'BooleanSource', 'SelectSource'].map(
        (name) => fields.find((field) => field.name === name)?.type
      )
    ).toEqual(['number', 'singleLineText', 'date', 'checkbox', 'singleSelect']);
    expect(
      ['NumberFormula', 'TextFormula', 'DateFormula', 'BooleanFormula', 'SelectFormula'].map(
        (name) => fields.find((field) => field.name === name)?.cellValueType
      )
    ).toEqual(['number', 'string', 'string', 'string', 'string']);

    const expectedByField = {
      NumberFormula: [-25, 25, null],
      TextFormula: ['ALPHA', 'OMEGA', null],
      DateFormula: ['1970-01-02', '2100-01-01', null],
      BooleanFormula: ['unchecked', 'checked', 'unchecked'],
      SelectFormula: ['initial', 'terminal', null],
    } as const;
    for (const [field, expected] of Object.entries(expectedByField)) {
      const checks = fieldValueChecks(manifest.workload, field);
      const actual = checks.map((step) => {
        const values = step.check.expected;
        expect(Array.isArray(values)).toBe(true);
        return Array.isArray(values) ? values[0] : undefined;
      });
      expect(actual).toEqual(expected);
      expect(checks).toHaveLength(3);
      expect(checks[0]!.check.expected).toHaveLength(scenario.size.rows);
    }
  });

  it('materializes separate equality, range and null filters with exact hit counts', async () => {
    const { scenario, manifest } = await materializeRule('R-QUERY-002');
    const queries = manifest.workload.filter(
      (step): step is Extract<BenchWorkloadStep, { kind: 'query-core' }> =>
        step.kind === 'query-core'
    );
    expect(queries.map((step) => step.query.filter)).toEqual([
      {
        conjunction: 'and',
        filterSet: [{ fieldId: 'Amount', operator: 'is', value: 7 }],
      },
      {
        conjunction: 'and',
        filterSet: [
          { fieldId: 'Amount', operator: 'isGreaterEqual', value: 6 },
          { fieldId: 'Amount', operator: 'isLessEqual', value: 8 },
        ],
      },
      {
        conjunction: 'and',
        filterSet: [{ fieldId: 'Noise', operator: 'isEmpty' }],
      },
    ]);
    const checks = manifest.workload.filter(
      (step): step is Extract<BenchWorkloadStep, { kind: 'checkpoint' }> =>
        step.kind === 'checkpoint' && step.check.kind === 'query-record-ids'
    );
    expect(
      checks.map((step) =>
        step.check.kind === 'query-record-ids' ? step.check.expectedTotal : undefined
      )
    ).toEqual([scenario.size.rows, scenario.size.rows, scenario.size.rows]);
    expect(manifest.dataset.recipe?.tables.Records?.fields.Noise?.nullFraction).toBe(1);
  });

  it('deletes the final remaining record and asserts the empty table', async () => {
    const { scenario, manifest } = await materializeRule('R-WRITE-003');
    const deletes = manifest.workload.filter(
      (step): step is Extract<BenchWorkloadStep, { kind: 'write-delete' }> =>
        step.kind === 'write-delete'
    );
    expect(deletes.map((step) => [step.key, step.rows])).toEqual([
      ['transition-2-delete-existing', scenario.size.rows],
      ['transition-2-delete-last-row', 1],
    ]);
    expect(
      manifest.workload
        .filter(
          (step): step is Extract<BenchWorkloadStep, { kind: 'checkpoint' }> =>
            step.kind === 'checkpoint' && step.check.kind === 'row-count'
        )
        .map((step) => (step.check.kind === 'row-count' ? step.check.expected : undefined))
    ).toEqual([scenario.size.rows + 1, 1, 0, 0]);
  });

  it('reuses references for every deterministic relation and conditional state', async () => {
    const cardinality = await materializeRule('R-ROLLUP-001');
    const propagation = await materializeRule('R-ROLLUP-002');
    const lookup = await materializeRule('R-LINK-001');
    const membership = await materializeRule('R-LINK-002');
    const clearAll = await materializeRule('R-LINK-003');
    const conditionalTransitions = await materializeRule('R-COND-001');
    const conditionalEmpty = await materializeRule('R-COND-002');

    expect(
      fieldValueChecks(cardinality.manifest.workload, 'MemberSum').map((step) =>
        Array.isArray(step.check.expected) ? step.check.expected[0] : undefined
      )
    ).toEqual([0, 7, 21, 14, 7, 0]);
    expect(
      fieldValueChecks(propagation.manifest.workload, 'MemberSum').map((step) =>
        Array.isArray(step.check.expected) ? step.check.expected[0] : undefined
      )
    ).toEqual([21, 25, 14, 27]);
    expect(
      fieldValueChecks(lookup.manifest.workload, 'ParentTotal').map((step) =>
        Array.isArray(step.check.expected) ? step.check.expected[0] : undefined
      )
    ).toEqual([7, 11, 11]);
    expect(
      fieldValueChecks(membership.manifest.workload, 'MemberSum').map((step) =>
        Array.isArray(step.check.expected) ? step.check.expected[0] : undefined
      )
    ).toEqual([0, 7, 21, 14, 7, 0]);
    expect(
      fieldValueChecks(clearAll.manifest.workload, 'MemberSum').map((step) =>
        Array.isArray(step.check.expected) ? step.check.expected[0] : undefined
      )
    ).toEqual([21, 0]);
    const conditionalRows = Math.max(3, Math.round(conditionalTransitions.scenario.size.rows / 10));
    const conditionalEmptyRows = Math.max(3, Math.round(conditionalEmpty.scenario.size.rows / 10));
    expect(
      fieldValueChecks(conditionalTransitions.manifest.workload, 'EligibleTotal').map((step) =>
        Array.isArray(step.check.expected) ? step.check.expected[0] : undefined
      )
    ).toEqual([0, conditionalRows * 7, 0]);
    expect(
      fieldValueChecks(conditionalEmpty.manifest.workload, 'EligibleTotal').map((step) =>
        Array.isArray(step.check.expected) ? step.check.expected[0] : undefined
      )
    ).toEqual([conditionalEmptyRows * 7, 0, 7]);

    for (const { manifest } of [
      cardinality,
      propagation,
      lookup,
      membership,
      clearAll,
      conditionalTransitions,
      conditionalEmpty,
    ]) {
      const checkpoints = manifest.workload.filter(
        (step) => step.kind === 'checkpoint' && step.check.kind === 'full-recompute'
      );
      expect(checkpoints.length).toBeGreaterThan(0);
      expect(
        checkpoints.every(
          (step) =>
            step.kind === 'checkpoint' &&
            step.check.kind === 'full-recompute' &&
            step.check.reuse === 'identical-state'
        )
      ).toBe(true);
      expect(manifest.oracle).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'full-recompute', reuse: 'identical-state' }),
        ])
      );
    }
  });

  it.each(['R-FORMULA-001', 'R-FORMULA-002', 'R-FORMULA-003', 'R-FORMULA-006'] as const)(
    'reuses only the deterministic final full recompute for %s',
    async (ruleId) => {
      const { manifest } = await materializeRule(ruleId);
      expect(
        manifest.workload.some(
          (step) => step.kind === 'checkpoint' && step.check.kind === 'full-recompute'
        )
      ).toBe(false);
      expect(manifest.oracle).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'full-recompute', reuse: 'identical-state' }),
        ])
      );
    }
  );

  it.each([
    ['R-WRITE-001', ['write-create']],
    ['R-WRITE-003', ['write-create', 'write-delete', 'write-delete']],
  ] as const)(
    'does not opt dynamic record mutations in %s into reference reuse',
    async (ruleId, kinds) => {
      const { manifest } = await materializeRule(ruleId);
      expect(
        manifest.workload
          .filter((step) => step.kind === 'write-create' || step.kind === 'write-delete')
          .map((step) => step.kind)
      ).toEqual(kinds);
      expect(
        manifest.workload.some(
          (step) =>
            step.kind === 'checkpoint' &&
            step.check.kind === 'full-recompute' &&
            step.check.reuse !== undefined
        )
      ).toBe(false);
      expect(
        manifest.oracle.some(
          (oracle) => oracle.kind === 'full-recompute' && oracle.reuse !== undefined
        )
      ).toBe(false);
    }
  );

  it.each(['R-FORMULA-002', 'R-FORMULA-003', 'R-FORMULA-006', 'R-QUERY-002', 'R-WRITE-003'])(
    'executes %s semantic assertions on the PGlite runtime',
    async (ruleId) => {
      const { generated } = await materializeRule(ruleId);
      const report = await runCase({
        teaPath: generated.teaPath,
        manifestPath: generated.manifestPath,
        backendOverride: 'pglite',
        samples: 1,
        warmup: 0,
      });
      const diagnostic = JSON.stringify({ errors: report.errors, oracle: report.oracle });
      expect(report.verdict, diagnostic).toBe('pass');
      expect(report.oracle.status, diagnostic).toBe('pass');
    },
    120_000
  );
});
