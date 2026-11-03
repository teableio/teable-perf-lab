import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import {
  computeCaseId,
  computeDatasetHash,
  type BenchCaseManifest,
  type BenchDatasetRecipe,
  type BenchOracle,
  type BenchWorkloadStep,
} from '../case/manifest';
import { BenchError } from '../errors';
import { writeTeaArchive } from '../tea/teaZip';
import {
  generateCoveringArray,
  type CoveringDimension,
  type CoveringRow,
  type PairSearchReceipt,
} from './coveringArray';

export type GeneratorTemplate = {
  readonly id: string;
  readonly rootTable: string;
  readonly structure: unknown;
  readonly dataset: BenchDatasetRecipe;
  readonly workload: ReadonlyArray<BenchWorkloadStep>;
  readonly oracle: ReadonlyArray<BenchOracle>;
  /** Optional fixed business-scale row counts; unspecified tables keep the rows/rootRows÷10 rule. */
  readonly rowCounts?: Readonly<Record<string, number>>;
};

export type GeneratorSpec = {
  readonly generatorVersion: string;
  readonly seed: number;
  readonly outDir: string;
  readonly strength: 2;
  readonly maxRows?: number;
  readonly maxSearchStates?: number;
  readonly maxMillis?: number;
  readonly templates: ReadonlyArray<GeneratorTemplate>;
  readonly dimensions: Readonly<Record<string, ReadonlyArray<unknown>>>;
  readonly forcedRows?: ReadonlyArray<Readonly<Record<string, unknown>>>;
};

export type GeneratedCase = {
  readonly caseId: string;
  readonly dir: string;
  readonly manifestPath: string;
  readonly teaPath: string;
};

export type GeneratorCoverage = {
  readonly totalPairs: number;
  readonly coveredPairs: number;
  readonly uncoveredPairs: ReadonlyArray<string>;
  readonly receipt: PairSearchReceipt & { readonly covered: number };
};

function structureTables(structure: unknown): ReadonlyArray<{ name: string }> {
  if (typeof structure !== 'object' || structure === null || !('tables' in structure)) {
    throw new BenchError('bench.generator.structure_invalid', 'template structure has no tables', {
      structure,
    });
  }
  const tables = structure.tables;
  if (!Array.isArray(tables)) {
    throw new BenchError('bench.generator.structure_invalid', 'template structure has no tables', {
      structure,
    });
  }
  return tables.map((raw: unknown) => {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('name' in raw) ||
      typeof raw.name !== 'string'
    ) {
      throw new BenchError(
        'bench.generator.structure_invalid',
        'template table is missing id or name',
        { table: raw }
      );
    }
    return { name: raw.name };
  });
}

function applyWriteDimensions(
  workload: ReadonlyArray<BenchWorkloadStep>,
  dimensions: Readonly<Record<string, unknown>>
): BenchWorkloadStep[] {
  const typecast = dimensions.typecast;
  const batchSize = dimensions.batchSize;
  if (typecast !== undefined && typeof typecast !== 'boolean') {
    throw new BenchError(
      'bench.generator.dimension_value_invalid',
      'typecast dimension must be a boolean',
      { typecast }
    );
  }
  if (
    batchSize !== undefined &&
    (typeof batchSize !== 'number' || !Number.isInteger(batchSize) || batchSize <= 0)
  ) {
    throw new BenchError(
      'bench.generator.dimension_value_invalid',
      'batchSize dimension must be a positive integer',
      { batchSize }
    );
  }

  return workload.map((step) => {
    switch (step.kind) {
      case 'write-delete':
        return batchSize === undefined ? step : { ...step, batchSize };
      case 'write-create':
      case 'write-update':
        return {
          ...step,
          batchSize: batchSize === undefined ? step.batchSize : batchSize,
          typecast: typecast === undefined ? step.typecast : typecast,
        };
      default:
        return step;
    }
  });
}

function normalizeWrites(
  workload: ReadonlyArray<BenchWorkloadStep>,
  rowsByTable: Readonly<Record<string, number>>
): BenchWorkloadStep[] {
  const result: BenchWorkloadStep[] = [];
  for (const step of workload) {
    if ((step.kind === 'write-create' || step.kind === 'write-delete') && step.rows === 0) {
      continue;
    }
    if (step.kind !== 'write-update') {
      result.push(step);
      continue;
    }
    const available = rowsByTable[step.table];
    if (available === undefined) {
      throw new BenchError('bench.generator.rows_missing', 'dataset rows missing for write step', {
        table: step.table,
        key: step.key,
      });
    }
    const rows = Math.min(step.rows, available);
    if (rows > 0) result.push({ ...step, rows });
  }
  return result;
}

function finalRowCounts(input: {
  initial: Readonly<Record<string, number>>;
  workload: ReadonlyArray<BenchWorkloadStep>;
}): Readonly<Record<string, number>> {
  const counts = { ...input.initial };
  for (const step of input.workload) {
    if (step.kind !== 'write-create' && step.kind !== 'write-delete') continue;
    const current = counts[step.table];
    if (current === undefined) {
      throw new BenchError('bench.generator.rows_missing', 'dataset rows missing for write step', {
        table: step.table,
        key: step.key,
      });
    }
    const changedRows = step.rows;
    if (step.kind === 'write-create') {
      counts[step.table] = current + changedRows;
      continue;
    }
    if (changedRows > current) {
      throw new BenchError(
        'bench.generator.delete_exceeds_rows',
        'write-delete cannot delete more rows than one fresh sample contains',
        { key: step.key, table: step.table, available: current, requested: changedRows }
      );
    }
    counts[step.table] = current - changedRows;
  }
  return counts;
}

function rewriteInvariants(
  oracle: ReadonlyArray<BenchOracle>,
  finalRowsByTable: Readonly<Record<string, number>>
): BenchOracle[] {
  return oracle.map((entry) => {
    if (entry.kind !== 'invariant') return entry;
    return {
      ...entry,
      checks: entry.checks.map((check) => {
        if (check.type !== 'row-count') return check;
        const expected = finalRowsByTable[check.table];
        if (expected === undefined) {
          throw new BenchError(
            'bench.generator.rows_missing',
            'dataset rows missing for invariant table',
            { table: check.table, key: entry.key }
          );
        }
        return { ...check, expected };
      }),
    };
  });
}

export async function generateCases(spec: GeneratorSpec): Promise<{
  cases: ReadonlyArray<GeneratedCase>;
  coverage: GeneratorCoverage;
}> {
  if (spec.strength !== 2) {
    throw new BenchError(
      'bench.generator.strength_unsupported',
      'only pairwise (strength 2) generation is supported',
      { strength: spec.strength }
    );
  }

  const templatesById = new Map<string, GeneratorTemplate>();
  for (const template of spec.templates) {
    if (templatesById.has(template.id)) {
      throw new BenchError(
        'bench.generator.template_duplicate',
        'duplicate generator template id',
        { templateId: template.id }
      );
    }
    templatesById.set(template.id, template);
  }

  const dimensionEntries = Object.entries(spec.dimensions);
  const allowedDimensions: Record<string, true> = {
    motif: true,
    rows: true,
    typecast: true,
    batchSize: true,
    backend: true,
  };
  for (const [name] of dimensionEntries) {
    if (!allowedDimensions[name]) {
      throw new BenchError('bench.generator.dimension_unknown', 'unknown generator dimension', {
        dimension: name,
      });
    }
  }
  const motifDimension = dimensionEntries.find(([name]) => name === 'motif');
  if (!motifDimension) {
    throw new BenchError(
      'bench.generator.motif_missing',
      'generator spec requires a motif dimension'
    );
  }
  for (const motif of motifDimension[1]) {
    if (typeof motif !== 'string' || !templatesById.has(motif)) {
      throw new BenchError('bench.generator.template_missing', 'no template for motif value', {
        motif,
      });
    }
  }

  const dimensions: CoveringDimension[] = dimensionEntries.map(([name, values]) => ({
    name,
    values,
  }));
  const constraints = [
    (row: CoveringRow) =>
      row.rows === undefined ||
      (typeof row.rows === 'number' && Number.isInteger(row.rows) && row.rows > 0),
    (row: CoveringRow) =>
      row.batchSize === undefined ||
      (typeof row.batchSize === 'number' && Number.isInteger(row.batchSize) && row.batchSize > 0),
    (row: CoveringRow) =>
      row.batchSize === undefined ||
      row.rows === undefined ||
      (typeof row.batchSize === 'number' &&
        typeof row.rows === 'number' &&
        row.batchSize <= row.rows),
    (row: CoveringRow) =>
      row.motif === undefined || (typeof row.motif === 'string' && templatesById.has(row.motif)),
    (row: CoveringRow) =>
      row.backend === undefined || row.backend === 'pglite' || row.backend === 'postgres',
  ];

  const covering = generateCoveringArray({
    dimensions,
    constraints,
    forcedRows: spec.forcedRows,
    maxRows: spec.maxRows,
    maxSearchStates: spec.maxSearchStates,
    maxMillis: spec.maxMillis,
  });
  const { rows: coveringRows, uncoveredPairs } = covering;
  const totalPairs = covering.receipt.completable;
  const cases: GeneratedCase[] = [];

  for (const coveringRow of coveringRows) {
    const templateId = coveringRow.motif;
    if (typeof templateId !== 'string') {
      throw new BenchError('bench.generator.template_missing', 'covering row has no motif', {
        row: coveringRow,
      });
    }
    const template = templatesById.get(templateId);
    if (!template) {
      throw new BenchError('bench.generator.template_missing', 'no template for motif value', {
        motif: templateId,
      });
    }

    const structure = structuredClone(template.structure);
    const recipe = structuredClone(template.dataset);
    const tables = structureTables(structure);
    const rowsDimension = coveringRow.rows;
    if (
      typeof rowsDimension !== 'number' ||
      !Number.isInteger(rowsDimension) ||
      rowsDimension <= 0
    ) {
      throw new BenchError(
        'bench.generator.dimension_value_invalid',
        'rows dimension must be a positive integer',
        { rows: rowsDimension }
      );
    }
    if (!tables.some((table) => table.name === template.rootTable)) {
      throw new BenchError('bench.generator.structure_invalid', 'root table is not in template', {
        rootTable: template.rootTable,
      });
    }
    const datasetRows: Record<string, number> = {};
    for (const table of tables) {
      const explicitRows = template.rowCounts?.[table.name];
      if (explicitRows !== undefined && (!Number.isInteger(explicitRows) || explicitRows <= 0)) {
        throw new BenchError(
          'bench.generator.dimension_value_invalid',
          'template rowCounts values must be positive integers',
          { table: table.name, rows: explicitRows }
        );
      }
      datasetRows[table.name] =
        explicitRows ??
        (table.name === template.rootTable
          ? rowsDimension
          : Math.max(1, Math.round(rowsDimension / 10)));
    }
    for (const tableName of Object.keys(template.rowCounts ?? {})) {
      if (!tables.some((table) => table.name === tableName)) {
        throw new BenchError(
          'bench.generator.rows_missing',
          'template rowCounts references an unknown table',
          { table: tableName }
        );
      }
    }

    const samples = 5;
    const workload = normalizeWrites(
      applyWriteDimensions(template.workload, coveringRow),
      datasetRows
    );
    const finalRows = finalRowCounts({ initial: datasetRows, workload });
    const oracle = rewriteInvariants(structuredClone(template.oracle), finalRows);
    const backendValue = coveringRow.backend;
    if (backendValue !== undefined && backendValue !== 'pglite' && backendValue !== 'postgres') {
      throw new BenchError(
        'bench.generator.dimension_value_invalid',
        'backend dimension must be pglite or postgres',
        { backend: backendValue }
      );
    }
    const backend = backendValue ?? 'pglite';

    const teaBytes = writeTeaArchive(structure);
    const schemaHash = sha256Hex(canonicalJson(structure));
    const seed = {
      schema: spec.seed,
      data: spec.seed,
      query: spec.seed,
      schedule: spec.seed,
    };
    const datasetHash = computeDatasetHash({
      dataMode: 'recipe',
      rows: datasetRows,
      seed,
      recipe,
    });
    const caseId = computeCaseId({
      specVersion: 1,
      generatorVersion: spec.generatorVersion,
      schemaHash,
      datasetHash,
      workload,
      oracle,
    });

    const manifest: BenchCaseManifest = {
      caseId,
      specVersion: 1,
      generatorVersion: spec.generatorVersion,
      title: template.id,
      dimensions: coveringRow,
      source: { tea: 'fixture.tea', dataMode: 'recipe' },
      dataset: {
        rows: datasetRows,
        seed,
        recipe,
        dataHash: datasetHash,
      },
      run: {
        backend,
        samples,
        warmup: 2,
        repetitions: 1,
        seedBatchSize: 1000,
        actorId: 'usr_headless',
      },
      workload,
      oracle,
    };

    const dir = join(spec.outDir, caseId, backend);
    await mkdir(dir, { recursive: true });
    const teaPath = join(dir, 'fixture.tea');
    const manifestPath = join(dir, 'case.manifest.json');
    await writeFile(teaPath, teaBytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    cases.push({ caseId, dir, manifestPath, teaPath });
  }

  return {
    cases,
    coverage: {
      totalPairs,
      coveredPairs: covering.receipt.covered,
      uncoveredPairs,
      receipt: covering.receipt,
    },
  };
}
