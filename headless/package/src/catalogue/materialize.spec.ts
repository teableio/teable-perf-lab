import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import { parseBenchCaseManifest, verifyCaseId, type BenchWorkloadStep } from '../case/manifest';
import { readTeaArchive } from '../tea/teaZip';
import { enumerateScenarioCatalogue } from './enumerate';
import {
  materializeCatalogueScenario,
  runnableTemplateByRule,
  supportedRuleIds,
} from './materialize';
import { ruleRegistry } from './registry';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

const assertExpectedValues = (input: unknown, expectedRows: number): void => {
  expect(Array.isArray(input)).toBe(true);
  expect(input).toHaveLength(expectedRows);
};

const transitionNumber = (step: BenchWorkloadStep): number | undefined => {
  const match = /^transition-(\d+)-/.exec(step.key);
  return match ? Number(match[1]) : undefined;
};

describe('catalogue scenario materialization', () => {
  it('advertises exactly the rules with complete sequence templates', () => {
    expect(supportedRuleIds).toEqual(Object.keys(runnableTemplateByRule).sort());
    expect(new Set(supportedRuleIds).size).toBe(supportedRuleIds.length);
    expect(supportedRuleIds).toEqual(
      ruleRegistry.rules
        .filter((rule) => rule.ruleId in runnableTemplateByRule)
        .map((rule) => rule.ruleId)
        .sort()
    );
  });

  it('writes deterministic valid archives and manifests with ordered transition checkpoints', async () => {
    const scenarios = [
      ...new Map(
        enumerateScenarioCatalogue()
          .scenarios.filter((scenario) => supportedRuleIds.includes(scenario.ruleId))
          .map((scenario) => [scenario.ruleId, scenario])
      ).values(),
    ];
    expect(scenarios.map((scenario) => scenario.ruleId).sort()).toEqual([...supportedRuleIds]);

    for (const scenario of scenarios) {
      const firstDirectory = await mkdtemp(join(tmpdir(), 'headless-catalogue-first-'));
      const secondDirectory = await mkdtemp(join(tmpdir(), 'headless-catalogue-second-'));
      temporaryDirectories.push(firstDirectory, secondDirectory);
      const first = await materializeCatalogueScenario({
        scenario,
        outDir: firstDirectory,
      });
      const second = await materializeCatalogueScenario({
        scenario,
        outDir: secondDirectory,
      });

      expect(first.cases).toHaveLength(1);
      expect(second.cases).toHaveLength(1);
      expect(first.cases[0]!.caseId).toBe(second.cases[0]!.caseId);
      expect(new Uint8Array(await readFile(first.cases[0]!.teaPath))).toEqual(
        new Uint8Array(await readFile(second.cases[0]!.teaPath))
      );
      expect(
        readTeaArchive(new Uint8Array(await readFile(first.cases[0]!.teaPath))).structure
      ).toBeTruthy();

      const firstText = await readFile(first.cases[0]!.manifestPath, 'utf8');
      const secondText = await readFile(second.cases[0]!.manifestPath, 'utf8');
      expect(firstText).toBe(secondText);
      const manifest = parseBenchCaseManifest(JSON.parse(firstText) as unknown);
      expect(Object.values(manifest.dataset.rows)).toContain(scenario.size.rows);
      expect(manifest.dimensions).toMatchObject({
        scenarioId: scenario.scenarioId,
        ruleId: scenario.ruleId,
        coverageObligationKeys: scenario.coverageObligationKeys,
      });
      expect(manifest.links?.requirementIds).toEqual(scenario.coverageObligationKeys);
      const archive = readTeaArchive(new Uint8Array(await readFile(first.cases[0]!.teaPath)));
      expect(() =>
        verifyCaseId(manifest, sha256Hex(canonicalJson(archive.structure)), archive.csvByEntry)
      ).not.toThrow();
      const structure = archive.structure as {
        tables: Array<{
          id: string;
          fields: Array<{ id: string; type: string; cellValueType?: string }>;
        }>;
      };
      const ids = structure.tables.flatMap((table) => [
        table.id,
        ...table.fields.map((field) => field.id),
      ]);
      expect(ids.every((id) => /^(?:tbl|fld)[A-Za-z0-9]{16}$/.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      expect(
        structure.tables
          .flatMap((table) => table.fields)
          .filter((field) => field.type === 'formula')
          .every((field) => field.cellValueType)
      ).toBe(true);

      const checkpoints = manifest.workload.filter(
        (step): step is Extract<BenchWorkloadStep, { kind: 'checkpoint' }> =>
          step.kind === 'checkpoint'
      );
      const transitions = checkpoints.map((step) => transitionNumber(step));
      expect([...new Set(transitions)]).toEqual(
        scenario.workload.mutationSequence
          .map((_, index) => index + 1)
          .filter((index) => transitions.includes(index))
      );
      expect(transitions).toEqual([...transitions].sort((left, right) => left! - right!));
      expect(new Set(checkpoints.map((step) => step.check.checkId)).size).toBe(checkpoints.length);
      for (const checkpoint of checkpoints) {
        const index = transitionNumber(checkpoint)! - 1;
        expect(checkpoint.check.description).toContain(scenario.workload.mutationSequence[index]!);
        expect(checkpoint.check.checkId).toContain(
          `${scenario.scenarioId}/transition-${index + 1}`
        );
        expect(checkpoint.check.obligationIds).toEqual(scenario.coverageObligationKeys);
        expect(manifest.workload.indexOf(checkpoint)).toBeGreaterThanOrEqual(index);
        if (checkpoint.check.kind === 'field-values') {
          assertExpectedValues(checkpoint.check.expected, scenario.size.rows);
        }
      }
    }
  });

  it('materializes exact clear, null and restored values in sequence', async () => {
    const scenario = enumerateScenarioCatalogue().scenarios.find(
      (candidate) => candidate.ruleId === 'R-WRITE-007'
    )!;
    const outDir = await mkdtemp(join(tmpdir(), 'headless-catalogue-values-'));
    temporaryDirectories.push(outDir);
    const result = await materializeCatalogueScenario({
      scenario,
      outDir,
    });
    const manifest = parseBenchCaseManifest(
      JSON.parse(await readFile(result.cases[0]!.manifestPath, 'utf8')) as unknown
    );
    const expected = manifest.workload
      .filter(
        (step): step is Extract<BenchWorkloadStep, { kind: 'checkpoint' }> =>
          step.kind === 'checkpoint' && step.check.kind === 'field-values'
      )
      .map((step) => {
        if (step.check.kind !== 'field-values') return undefined;
        assertExpectedValues(step.check.expected, scenario.size.rows);
        return new Set(step.check.expected as ReadonlyArray<unknown>);
      });
    expect(expected).toEqual([new Set([7]), new Set([null]), new Set([11])]);
  });
});
