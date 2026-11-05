import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strToU8, unzipSync, zipSync } from 'fflate';

import { afterEach, describe, expect, it } from 'vitest';

import { parseBenchCaseManifest } from '../case/manifest';
import { writeTeaArchive } from '../tea/teaZip';
import { deriveCases } from './deriveFromSchema';
import { richDerivedStructure } from './deriveFromSchema.fixture';

const temps: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function richTea(): Promise<string> {
  const teaPath = join(await tempDir('derive-tea-'), 'rich.tea');
  await writeFile(teaPath, writeTeaArchive(richDerivedStructure));
  return teaPath;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('deriveCases', () => {
  it('keeps pair coverage empty when the schema has no computed dependency motifs', async () => {
    const directory = await tempDir('derive-plain-');
    const teaPath = join(directory, 'plain.tea');
    await writeFile(
      teaPath,
      writeTeaArchive({
        tables: [
          {
            id: 'tblPlain',
            name: 'Plain',
            fields: [{ id: 'fldName', name: 'Name', type: 'singleLineText', isPrimary: true }],
          },
        ],
      })
    );
    const result = await deriveCases({ teaPath, outDir: join(directory, 'cases') });
    expect(result.cases).toEqual([]);
    expect(result.coverage.totalPairs).toBe(0);
    expect(result.coverage.coveredPairs).toBe(0);
    expect(result.coverage.uncoveredPairs).toEqual([]);
    expect(result.coverage.receipt.pairs.covered).toBe(0);
  });

  it('classifies every computed field and deduplicates motif tuples', async () => {
    const outDir = join(await tempDir('derive-out-'), 'cases');
    const result = await deriveCases({ teaPath: await richTea(), outDir });
    expect(Object.keys(result.schema.motifs).sort()).toEqual([
      'origin=conditional,depth=1,hops=1,relationship=none,source=select',
      'origin=conditional,depth=1,hops=1,relationship=none,source=text',
      'origin=formula,depth=1,hops=0,relationship=none,source=number',
      'origin=formula,depth=2,hops=0,relationship=none,source=number',
      'origin=lookup,depth=1,hops=1,relationship=manyOne,source=select',
      'origin=lookup,depth=1,hops=1,relationship=manyOne,source=text',
      'origin=lookup,depth=2,hops=1,relationship=manyOne,source=number',
      'origin=rollup,depth=1,hops=1,relationship=manyMany,source=number',
      'origin=rollup,depth=1,hops=1,relationship=manyMany,source=text',
    ]);

    for (const entry of result.coverage.computedFields) {
      if (entry.coveredBy.length === 0) expect(entry.reason).toBeDefined();
      else expect(entry.reason).toBeUndefined();
      expect(entry.tableId).toMatch(/^tbl/);
      expect(entry.fieldId).toMatch(/^fld/);
    }
    expect(result.coverage.obligations.some((item) => item.status === 'planned-gap')).toBe(true);
    expect(result.coverage.computedFields.map((entry) => `${entry.table}.${entry.field}`)).toEqual([
      'Parents.Double',
      'Parents.Label',
      'Parents.Children',
      'Parents.ChildTotal',
      'Children.Parent',
      'Children.ParentLabel',
      'Children.ParentStatus',
      'Children.MatchingParents',
    ]);
    expect(result.coverage.uncoveredPairs.some((pair) => pair.includes('reason=maxRows'))).toBe(
      true
    );
    expect(result.coverage.receipt.data).toEqual({
      requested: 'recipe',
      selected: 'recipe',
      provenance: 'schema-synthetic-recipe',
      archiveCsvEntries: 0,
    });
    expect(result.coverage.obligations.length).toBeGreaterThanOrEqual(
      result.coverage.computedFields.length
    );
    expect(
      result.coverage.obligations.every((obligation) =>
        obligation.status === 'planned-gap'
          ? obligation.coveredBy.length === 0 &&
            (obligation.edge.conditionFieldIds.length > 0 || obligation.edge.linkFieldId !== null)
          : obligation.status === 'planned' &&
            obligation.coveredBy.length > 0 &&
            obligation.edge.fromFieldId.length > 0
      )
    ).toBe(true);
    for (const generated of result.cases) {
      const manifest = parseBenchCaseManifest(
        JSON.parse(await readFile(generated.manifestPath, 'utf8'))
      );
      expect(manifest.caseId).toBe(generated.caseId);
      expect(manifest.source.dataMode).toBe('recipe');
      expect(manifest.workload.some((step) => step.kind === 'write-update')).toBe(true);
      expect(manifest.workload.some((step) => step.kind === 'flush-computed')).toBe(true);
      const update = manifest.workload.find((step) => step.kind === 'write-update')!;
      if (update.kind !== 'write-update') throw new Error('unreachable');
      expect(update.table === 'Parents' || update.table === 'Children').toBe(true);
      const keys = manifest.workload.map((step) => step.key);
      expect(keys.indexOf('flush-computed')).toBeGreaterThan(keys.indexOf('update-source'));
      expect(keys.findIndex((key) => key.startsWith('query-target-'))).toBeGreaterThan(
        keys.indexOf('flush-computed')
      );
      expect(manifest.oracle).toEqual([
        expect.objectContaining({
          kind: 'full-recompute',
          obligationIds: expect.any(Array),
        }),
      ]);
      expect(
        manifest.oracle.some(
          (entry) =>
            entry.kind === 'invariant' &&
            entry.checks.some(
              (check) => check.type === 'computed-not-null' || check.type === 'unique-primary'
            )
        )
      ).toBe(false);
    }
  });

  it('drives cross-table motifs from the parent storage field', async () => {
    const outDir = join(await tempDir('derive-cross-'), 'cases');
    const result = await deriveCases({ teaPath: await richTea(), outDir });
    const lookupOfFormula = result.cases.find((generated) => {
      return generated.manifestPath.length > 0;
    })!;
    const manifests = await Promise.all(
      result.cases.map(async (generated) =>
        parseBenchCaseManifest(JSON.parse(await readFile(generated.manifestPath, 'utf8')))
      )
    );
    expect(lookupOfFormula).toBeDefined();
    const parentWrites = manifests.filter((manifest) =>
      manifest.workload.some((step) => step.kind === 'write-update' && step.table === 'Parents')
    );
    expect(parentWrites.length).toBeGreaterThan(0);
    // Every cross-table case must flush computed before the invariant oracle.
    for (const manifest of parentWrites) {
      const keys = manifest.workload.map((step) => step.key);
      expect(keys.indexOf('flush-computed')).toBeGreaterThan(keys.indexOf('update-source'));
    }
  });

  it('emits the same case ids for the same schema and limits', async () => {
    const teaPath = await richTea();
    const first = await deriveCases({
      teaPath,
      outDir: join(await tempDir('derive-a-'), 'cases'),
      limits: { maxCases: 6, maxRows: 10 },
    });
    const second = await deriveCases({
      teaPath,
      outDir: join(await tempDir('derive-b-'), 'cases'),
      limits: { maxCases: 6, maxRows: 10 },
    });
    expect(first.cases.map((item) => item.caseId)).toEqual(second.cases.map((item) => item.caseId));
    expect(first.coverage).toEqual(second.coverage);
  });

  it('reports truncation instead of silently dropping cases', async () => {
    const result = await deriveCases({
      teaPath: await richTea(),
      outDir: join(await tempDir('derive-trunc-'), 'cases'),
      limits: { maxCases: 1 },
    });
    expect(result.cases).toHaveLength(1);
    const truncated = result.coverage.uncoveredPairs.filter((pair) =>
      pair.includes('reason=maxCases')
    );
    expect(truncated.length).toBeGreaterThan(0);
    const overMax = result.coverage.computedFields.filter(
      (entry) => entry.reason === 'over maxCases'
    );
    // With one case only one motif tuple is representable; the remaining
    // computed fields keep an explicit reason rather than a silent gap.
    expect(overMax.length).toBeGreaterThan(0);
    expect(
      result.coverage.computedFields.every(
        (entry) => entry.coveredBy.length > 0 || entry.reason !== undefined
      )
    ).toBe(true);
  });

  it('reports only resource-admissible rows as covered', async () => {
    const maxRows = 10;
    const result = await deriveCases({
      teaPath: await richTea(),
      outDir: join(await tempDir('derive-rows-'), 'cases'),
      limits: { maxRows },
    });
    expect(result.cases).toHaveLength(0);
    expect(result.coverage.totalPairs).toBeGreaterThan(0);
    expect(result.coverage.coveredPairs).toBe(0);
    expect(result.coverage.receipt.pairs.covered).toBe(0);
    expect(result.coverage.uncoveredPairs).toHaveLength(result.coverage.totalPairs);
    expect(result.coverage.uncoveredPairs.every((pair) => pair.includes('reason=maxRows'))).toBe(
      true
    );
    expect(result.coverage.receipt.gaps).toEqual(
      expect.arrayContaining([expect.stringContaining(`exceeds configured maxRows ${maxRows}`)])
    );
    expect(
      result.coverage.computedFields.every(
        (entry) => entry.coveredBy.length === 0 && entry.reason !== undefined
      )
    ).toBe(true);
  });

  it('makes graph truncation and unknown sources explicit', async () => {
    const result = await deriveCases({
      teaPath: await richTea(),
      outDir: join(await tempDir('derive-graph-trunc-'), 'cases'),
      limits: { maxGraphStates: 1, maxMillis: 10_000 },
    });
    expect(result.coverage.receipt.graph.truncated).toBe(true);
    expect(result.coverage.receipt.graph.truncatedBy).toEqual(['maxGraphStates']);
    expect(result.coverage.receipt.graph.unknownSourceIds.length).toBeGreaterThan(0);
    expect(
      result.coverage.computedFields.some((entry) =>
        entry.reason?.includes('graph search truncated')
      )
    ).toBe(true);
    expect(result.coverage.uncoveredPairs.some((pair) => pair.includes('absent'))).toBe(false);
  });

  it('preserves materialized CSV mode and reports archive provenance', async () => {
    const teaPath = join(await tempDir('derive-materialized-tea-'), 'rich.tea');
    const csv: Record<string, string> = {};
    for (const table of richDerivedStructure.tables) {
      csv[`tables/${table.id}.csv`] = `${table.fields[0]!.id}\nrow-1\n`;
    }
    await writeFile(teaPath, writeTeaArchive(richDerivedStructure, csv));
    const result = await deriveCases({
      teaPath,
      outDir: join(await tempDir('derive-materialized-out-'), 'cases'),
      dataMode: 'materialized',
    });
    expect(result.coverage.receipt.data).toEqual({
      requested: 'materialized',
      selected: 'materialized',
      provenance: 'archive-materialized-csv',
      archiveCsvEntries: 2,
    });
    const manifest = parseBenchCaseManifest(
      JSON.parse(await readFile(result.cases[0]!.manifestPath, 'utf8'))
    );
    expect(manifest.source.dataMode).toBe('materialized');
    expect(manifest.dataset.recipe).toBeUndefined();
  });

  it('keeps recipe fixtures structure-only while materialized fixtures preserve input bytes', async () => {
    const csvEntries = (suffix: string): Record<string, Uint8Array> => {
      const entries: Record<string, Uint8Array> = {};
      entries['structure.json'] = strToU8(JSON.stringify(richDerivedStructure));
      entries['attachments/private.txt'] = strToU8(`private-${suffix}`);
      for (const table of richDerivedStructure.tables) {
        entries[`tables/${table.id}.csv`] = strToU8(`${table.fields[0]!.id}\ncustomer-${suffix}\n`);
      }
      return entries;
    };
    const inputDir = await tempDir('derive-private-tea-');
    const firstBytes = Buffer.from(zipSync(csvEntries('first')));
    const secondBytes = Buffer.from(zipSync(csvEntries('second')));
    const firstPath = join(inputDir, 'first.tea');
    const secondPath = join(inputDir, 'second.tea');
    await writeFile(firstPath, firstBytes);
    await writeFile(secondPath, secondBytes);

    const firstRecipe = await deriveCases({
      teaPath: firstPath,
      outDir: join(await tempDir('derive-private-recipe-a-'), 'cases'),
      limits: { maxCases: 6, maxRows: 10 },
    });
    const secondRecipe = await deriveCases({
      teaPath: secondPath,
      outDir: join(await tempDir('derive-private-recipe-b-'), 'cases'),
      limits: { maxCases: 6, maxRows: 10 },
    });
    const firstRecipeManifests = await Promise.all(
      firstRecipe.cases.map(async (generated) =>
        parseBenchCaseManifest(JSON.parse(await readFile(generated.manifestPath, 'utf8')))
      )
    );
    const secondRecipeManifests = await Promise.all(
      secondRecipe.cases.map(async (generated) =>
        parseBenchCaseManifest(JSON.parse(await readFile(generated.manifestPath, 'utf8')))
      )
    );
    expect(firstRecipeManifests.map((manifest) => manifest.caseId)).toEqual(
      secondRecipeManifests.map((manifest) => manifest.caseId)
    );
    expect(firstRecipeManifests.map((manifest) => manifest.dataset.dataHash)).toEqual(
      secondRecipeManifests.map((manifest) => manifest.dataset.dataHash)
    );
    for (const generated of [...firstRecipe.cases, ...secondRecipe.cases]) {
      const recipeBytes = await readFile(generated.teaPath);
      expect(Object.keys(unzipSync(recipeBytes))).toEqual(['structure.json']);
      expect(recipeBytes.includes('customer-')).toBe(false);
      expect(recipeBytes.includes('private-')).toBe(false);
    }

    const firstMaterialized = await deriveCases({
      teaPath: firstPath,
      outDir: join(await tempDir('derive-private-materialized-a-'), 'cases'),
      dataMode: 'materialized',
      limits: { maxCases: 6, maxRows: 100 },
    });
    const secondMaterialized = await deriveCases({
      teaPath: secondPath,
      outDir: join(await tempDir('derive-private-materialized-b-'), 'cases'),
      dataMode: 'materialized',
      limits: { maxCases: 6, maxRows: 100 },
    });
    const firstMaterializedBytes = await readFile(firstMaterialized.cases[0]!.teaPath);
    const secondMaterializedBytes = await readFile(secondMaterialized.cases[0]!.teaPath);
    expect(firstMaterializedBytes).toEqual(firstBytes);
    expect(secondMaterializedBytes).toEqual(secondBytes);
    expect(Object.keys(unzipSync(firstMaterializedBytes)).sort()).toEqual(
      Object.keys(csvEntries('first')).sort()
    );
    const firstMaterializedManifest = parseBenchCaseManifest(
      JSON.parse(await readFile(firstMaterialized.cases[0]!.manifestPath, 'utf8'))
    );
    const secondMaterializedManifest = parseBenchCaseManifest(
      JSON.parse(await readFile(secondMaterialized.cases[0]!.manifestPath, 'utf8'))
    );
    expect(firstMaterializedManifest.dataset.dataHash).not.toBe(
      secondMaterializedManifest.dataset.dataHash
    );
    expect(firstMaterializedManifest.caseId).not.toBe(secondMaterializedManifest.caseId);
  });

  it('summarizes diamonds without path enumeration and keeps each writable source', async () => {
    const structure = {
      id: 'bse-diamond',
      tables: [
        {
          id: 'tbl-diamond',
          name: 'Diamond',
          fields: [
            { id: 'fld-title', name: 'Title', type: 'singleLineText', isPrimary: true },
            { id: 'fld-a', name: 'A', type: 'number' },
            { id: 'fld-b', name: 'B', type: 'number' },
            {
              id: 'fld-c',
              name: 'C',
              type: 'formula',
              options: { expression: '{fld-a} + {fld-b}' },
            },
            {
              id: 'fld-d',
              name: 'D',
              type: 'formula',
              options: { expression: '{fld-c} * 2' },
            },
            {
              id: 'fld-e',
              name: 'E',
              type: 'formula',
              options: { expression: '{fld-c} * 3' },
            },
            {
              id: 'fld-f',
              name: 'F',
              type: 'formula',
              options: { expression: '{fld-d} + {fld-e}' },
            },
          ],
          views: [{ type: 'grid', name: 'Grid' }],
        },
      ],
    } as const;
    const teaPath = join(await tempDir('derive-diamond-tea-'), 'diamond.tea');
    await writeFile(teaPath, writeTeaArchive(structure));
    const result = await deriveCases({
      teaPath,
      outDir: join(await tempDir('derive-diamond-out-'), 'cases'),
    });
    const finalObligations = result.coverage.obligations.filter(
      (obligation) => obligation.target.fieldId === 'fld-f'
    );
    expect(new Set(finalObligations.map((obligation) => obligation.source.fieldId))).toEqual(
      new Set(['fld-a', 'fld-b'])
    );
    expect(new Set(finalObligations.map((obligation) => obligation.edge.fromFieldId))).toEqual(
      new Set(['fld-d', 'fld-e'])
    );
    expect(result.coverage.receipt.graph.searchStates).toBeLessThanOrEqual(42);
    expect(result.coverage.receipt.graph.truncated).toBe(false);
    expect(finalObligations.every((obligation) => obligation.status === 'planned')).toBe(true);
  });
});
