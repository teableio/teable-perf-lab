/* eslint-disable sonarjs/cognitive-complexity -- bounded graph classification and deterministic case materialization intentionally keep traversal state local */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { schemaFromDotTeaStructure, type SchemaComplexityEdge } from '@teable/v2-complexity';

import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import {
  computeCaseId,
  computeDatasetHash,
  type BenchBackend,
  type BenchCaseManifest,
  type BenchDatasetRecipe,
  type BenchWorkloadStep,
  type BenchWriteValue,
} from '../case/manifest';
import { BenchError } from '../errors';
import { parseCsv } from '../tea/csv';
import { readTeaArchive, writeTeaArchive } from '../tea/teaZip';
import {
  generateCoveringArray,
  pairLabel,
  type CoveringDimension,
  type CoveringRow,
  type PairSearchReceipt,
} from './coveringArray';
import type { GeneratedCase } from './generate';

export type DerivedObligation = {
  readonly id: string;
  readonly source: { readonly tableId: string; readonly fieldId: string };
  readonly target: { readonly tableId: string; readonly fieldId: string };
  readonly edge: {
    readonly id: string;
    readonly fromTableId: string;
    readonly fromFieldId: string;
    readonly toTableId: string;
    readonly toFieldId: string;
    readonly conditionFieldIds: ReadonlyArray<string>;
    readonly linkFieldId: string | null;
  };
  readonly status: 'applicable' | 'planned' | 'planned-gap';
  readonly reason: string;
  readonly coveredBy: ReadonlyArray<string>;
};

export type DerivationReceipt = {
  readonly graph: {
    readonly eligibleSources: number;
    readonly discoveredObligations: number;
    readonly searchStates: number;
    readonly truncated: boolean;
    readonly truncatedBy: ReadonlyArray<'maxGraphStates' | 'maxMillis'>;
    readonly unknownSourceIds: ReadonlyArray<string>;
    readonly bounds: { readonly maxGraphStates: number; readonly maxMillis: number };
  };
  readonly pairs: PairSearchReceipt & { readonly covered: number };
  readonly data: {
    readonly requested: 'recipe' | 'materialized';
    readonly selected: 'recipe' | 'materialized';
    readonly provenance: 'schema-synthetic-recipe' | 'archive-materialized-csv';
    readonly archiveCsvEntries: number;
  };
  readonly gaps: ReadonlyArray<string>;
};

export type DerivedCoverage = {
  totalPairs: number;
  coveredPairs: number;
  uncoveredPairs: ReadonlyArray<string>;
  computedFields: ReadonlyArray<{
    table: string;
    field: string;
    tableId: string;
    fieldId: string;
    coveredBy: ReadonlyArray<string>;
    reason?: string;
  }>;
  obligations: ReadonlyArray<DerivedObligation>;
  receipt: DerivationReceipt;
};

export type DerivedCasesResult = {
  cases: ReadonlyArray<GeneratedCase>;
  coverage: DerivedCoverage;
  schema: {
    tables: number;
    fields: number;
    computedFields: number;
    motifs: Readonly<Record<string, number>>;
  };
};

type JsonObject = Record<string, unknown>;
type SourceType = 'number' | 'text' | 'select' | 'date' | 'checkbox';
type Origin = 'formula' | 'lookup' | 'rollup' | 'conditional';
type Relationship = 'manyOne' | 'manyMany' | 'none';
type FieldMetadata = {
  readonly id: string;
  readonly name: string;
  readonly tableId: string;
  readonly tableName: string;
  readonly type: string;
  readonly isComputed: boolean;
  readonly raw: JsonObject;
};
type RawSchema = {
  readonly fieldsById: ReadonlyMap<string, FieldMetadata>;
  readonly rawTables: ReadonlyArray<JsonObject>;
};
type GraphObligation = {
  readonly id: string;
  readonly edgeId: string;
  readonly source: FieldMetadata;
  readonly target: FieldMetadata;
  readonly edge: SchemaComplexityEdge;
  readonly conditionFieldIds: ReadonlyArray<string>;
  readonly linkFieldId: string | null;
  readonly sameTableDepth: number;
  readonly crossTableHops: number;
};
type Motif = {
  readonly key: string;
  readonly tuple: string;
  readonly origin: Origin;
  readonly depthBucket: '1' | '2' | '3+';
  readonly hopBucket: '0' | '1' | '2+';
  readonly relationship: Relationship;
  readonly sourceType: SourceType;
  readonly source: FieldMetadata;
  readonly obligations: ReadonlyArray<GraphObligation>;
  readonly fields: ReadonlyArray<FieldMetadata>;
};

type GraphBudget = {
  readonly maxGraphStates: number;
  readonly maxMillis: number;
  readonly startedAt: number;
  searchStates: number;
  readonly truncatedBy: Set<'maxGraphStates' | 'maxMillis'>;
};

const asObject = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

function readRawSchema(structure: unknown): RawSchema {
  const rawTables = asArray(asObject(structure).tables).map(asObject);
  const fieldsById = new Map<string, FieldMetadata>();
  for (const table of rawTables) {
    const tableId = asText(table.id);
    const tableName = asText(table.name);
    if (!tableId || !tableName) continue;
    for (const value of asArray(table.fields)) {
      const raw = asObject(value);
      const id = asText(raw.id);
      const name = asText(raw.name);
      if (!id || !name) continue;
      const physicalType = asText(raw.type) ?? '';
      const type =
        raw.isConditionalLookup === true || physicalType === 'conditionalLookup'
          ? 'conditionalLookup'
          : physicalType === 'conditionalRollup'
            ? 'conditionalRollup'
            : raw.isLookup === true
              ? 'lookup'
              : physicalType;
      fieldsById.set(id, {
        id,
        name,
        tableId,
        tableName,
        type,
        isComputed: [
          'formula',
          'lookup',
          'rollup',
          'conditionalLookup',
          'conditionalRollup',
        ].includes(type),
        raw,
      });
    }
  }
  return { fieldsById, rawTables };
}

const originOf = (field: FieldMetadata): Origin | undefined => {
  switch (field.type) {
    case 'formula':
    case 'lookup':
    case 'rollup':
      return field.type;
    case 'conditionalLookup':
      return 'conditional';
    default:
      return undefined;
  }
};

const sourceTypeOf = (field: FieldMetadata): SourceType | undefined => {
  switch (field.type) {
    case 'number':
      return 'number';
    case 'singleLineText':
    case 'longText':
      return 'text';
    case 'singleSelect':
    case 'multipleSelect':
      return 'select';
    case 'date':
      return 'date';
    case 'checkbox':
      return 'checkbox';
    default:
      return undefined;
  }
};

function relationshipOf(
  field: FieldMetadata,
  fieldsById: ReadonlyMap<string, FieldMetadata>
): Relationship {
  if (!['lookup', 'rollup'].includes(field.type)) return 'none';
  const linkFieldId = asText(asObject(field.raw.lookupOptions).linkFieldId);
  const link = linkFieldId ? fieldsById.get(linkFieldId) : undefined;
  const relationship = asText(asObject(link?.raw.options).relationship);
  return relationship === 'manyOne' || relationship === 'manyMany' ? relationship : 'none';
}

const bucket = (count: number): '1' | '2' | '3+' => (count >= 3 ? '3+' : count <= 1 ? '1' : '2');
const hopBucket = (count: number): '0' | '1' | '2+' =>
  count >= 2 ? '2+' : count === 1 ? '1' : '0';

function tupleKey(input: {
  origin: Origin;
  depthBucket: Motif['depthBucket'];
  hopBucket: Motif['hopBucket'];
  relationship: Relationship;
  sourceType: SourceType;
}): string {
  return [
    `origin=${input.origin}`,
    `depth=${input.depthBucket}`,
    `hops=${input.hopBucket}`,
    `relationship=${input.relationship}`,
    `source=${input.sourceType}`,
  ].join(',');
}

function edgeId(edge: SchemaComplexityEdge): string {
  return `edge_${sha256Hex(
    canonicalJson({
      fromTableId: edge.fromTableId,
      fromFieldId: edge.fromFieldId,
      toTableId: edge.toTableId,
      toFieldId: edge.toFieldId,
      kind: edge.kind,
      linkFieldId: edge.linkFieldId ?? null,
      conditional: edge.conditional ?? false,
    })
  )}`;
}

function obligationId(source: FieldMetadata, edge: SchemaComplexityEdge): string {
  return `derived_${sha256Hex(
    canonicalJson({
      source: { tableId: source.tableId, fieldId: source.id },
      target: { tableId: edge.toTableId, fieldId: edge.toFieldId },
      edgeId: edgeId(edge),
    })
  )}`;
}

function graphBudgetAvailable(budget: GraphBudget): boolean {
  if (budget.searchStates >= budget.maxGraphStates) {
    budget.truncatedBy.add('maxGraphStates');
    return false;
  }
  if (Date.now() - budget.startedAt >= budget.maxMillis) {
    budget.truncatedBy.add('maxMillis');
    return false;
  }
  return true;
}

/**
 * Summarizes bounded reachability. State is memoized by field and capped depth/hop buckets,
 * so diamonds merge and cycles cannot enumerate paths.
 */
function summarizeGraph(input: {
  edges: ReadonlyArray<SchemaComplexityEdge>;
  fieldsById: ReadonlyMap<string, FieldMetadata>;
  maxGraphStates: number;
  maxMillis: number;
}): {
  obligations: ReadonlyArray<GraphObligation>;
  eligibleSources: ReadonlyArray<FieldMetadata>;
  unknownSourceIds: ReadonlyArray<string>;
  budget: GraphBudget;
} {
  const outgoing = new Map<string, SchemaComplexityEdge[]>();
  for (const edge of input.edges) {
    const list = outgoing.get(edge.fromFieldId) ?? [];
    list.push(edge);
    outgoing.set(edge.fromFieldId, list);
  }
  for (const list of outgoing.values()) {
    list.sort(
      (left, right) =>
        left.toTableId.localeCompare(right.toTableId) ||
        left.toFieldId.localeCompare(right.toFieldId) ||
        edgeId(left).localeCompare(edgeId(right))
    );
  }
  const eligibleSources = [...input.fieldsById.values()]
    .filter((field) => !field.isComputed && sourceTypeOf(field) !== undefined)
    .sort(
      (left, right) => left.tableId.localeCompare(right.tableId) || left.id.localeCompare(right.id)
    );
  const budget: GraphBudget = {
    maxGraphStates: input.maxGraphStates,
    maxMillis: input.maxMillis,
    startedAt: Date.now(),
    searchStates: 0,
    truncatedBy: new Set(),
  };
  const obligations = new Map<string, GraphObligation>();
  const unknownSourceIds: string[] = [];

  for (const source of eligibleSources) {
    const queue: Array<{ fieldId: string; sameTableDepth: number; crossTableHops: number }> = [
      { fieldId: source.id, sameTableDepth: 0, crossTableHops: 0 },
    ];
    const visited = new Set<string>();
    let cursor = 0;
    let sourceTruncated = false;
    while (cursor < queue.length) {
      if (!graphBudgetAvailable(budget)) {
        sourceTruncated = true;
        break;
      }
      const state = queue[cursor++]!;
      const stateKey = `${state.fieldId}|${Math.min(state.sameTableDepth, 3)}|${Math.min(
        state.crossTableHops,
        2
      )}`;
      if (visited.has(stateKey)) continue;
      visited.add(stateKey);
      budget.searchStates += 1;
      for (const edge of outgoing.get(state.fieldId) ?? []) {
        const target = input.fieldsById.get(edge.toFieldId);
        if (!target) continue;
        const sameTableDepth = Math.min(
          3,
          state.sameTableDepth + (edge.kind === 'same_record' && target.isComputed ? 1 : 0)
        );
        const crossTableHops = Math.min(
          2,
          state.crossTableHops + (edge.kind === 'cross_record' ? 1 : 0)
        );
        if (target.isComputed && originOf(target)) {
          const id = obligationId(source, edge);
          const prior = obligations.get(id);
          if (
            !prior ||
            sameTableDepth > prior.sameTableDepth ||
            crossTableHops > prior.crossTableHops
          ) {
            obligations.set(id, {
              id,
              edgeId: edgeId(edge),
              source,
              target,
              edge,
              conditionFieldIds: edge.conditionFieldIds ?? [],
              linkFieldId: edge.linkFieldId ?? null,
              sameTableDepth: Math.max(1, sameTableDepth),
              crossTableHops,
            });
          }
        }
        queue.push({ fieldId: target.id, sameTableDepth, crossTableHops });
      }
    }
    if (sourceTruncated) unknownSourceIds.push(source.id);
  }
  return {
    obligations: [...obligations.values()].sort((left, right) => left.id.localeCompare(right.id)),
    eligibleSources,
    unknownSourceIds,
    budget,
  };
}

function classifyMotifs(input: {
  obligations: ReadonlyArray<GraphObligation>;
  fieldsById: ReadonlyMap<string, FieldMetadata>;
}): ReadonlyArray<Motif> {
  const grouped = new Map<
    string,
    Omit<Motif, 'obligations' | 'fields'> & {
      obligations: GraphObligation[];
      fields: Map<string, FieldMetadata>;
    }
  >();
  for (const obligation of input.obligations) {
    const origin = originOf(obligation.target);
    const sourceType = sourceTypeOf(obligation.source);
    if (!origin || !sourceType) continue;
    const shape = {
      origin,
      depthBucket: bucket(obligation.sameTableDepth),
      hopBucket: hopBucket(obligation.crossTableHops),
      relationship: relationshipOf(obligation.target, input.fieldsById),
      sourceType,
    } as const;
    const tuple = tupleKey(shape);
    // Only obligations with exactly the same source and shape share a mutation case.
    const key = `${obligation.source.tableId}/${obligation.source.id}|${tuple}`;
    const current = grouped.get(key);
    if (current) {
      current.obligations.push(obligation);
      current.fields.set(obligation.target.id, obligation.target);
    } else {
      grouped.set(key, {
        key,
        tuple,
        ...shape,
        source: obligation.source,
        obligations: [obligation],
        fields: new Map([[obligation.target.id, obligation.target]]),
      });
    }
  }
  return [...grouped.values()]
    .map((motif) => ({
      ...motif,
      obligations: motif.obligations.sort((left, right) => left.id.localeCompare(right.id)),
      fields: [...motif.fields.values()].sort(
        (left, right) =>
          left.tableId.localeCompare(right.tableId) || left.id.localeCompare(right.id)
      ),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function choiceNames(field: FieldMetadata): ReadonlyArray<string> {
  return asArray(asObject(field.raw.options).choices)
    .map((choice) => asText(asObject(choice).name))
    .filter((choice): choice is string => Boolean(choice));
}

function writeValue(field: FieldMetadata, sourceType: SourceType): BenchWriteValue {
  switch (sourceType) {
    case 'number':
      return { kind: 'number-increment', start: 1, step: 1 };
    case 'text':
      return { kind: 'text-suffix', prefix: 'derived-' };
    case 'select': {
      const choices = choiceNames(field);
      return choices.length === 0
        ? { kind: 'literal', value: null }
        : { kind: 'select-cycle', choices };
    }
    case 'date':
      return { kind: 'literal', value: '2024-01-01T00:00:00.000Z' };
    case 'checkbox':
      return { kind: 'literal', value: true };
  }
}

function recipeFor(schema: RawSchema): BenchDatasetRecipe {
  const tables: Record<string, { fields: Record<string, JsonObject> }> = {};
  for (const table of schema.rawTables) {
    const tableName = asText(table.name);
    if (!tableName) continue;
    const fields: Record<string, JsonObject> = {};
    for (const fieldValue of asArray(table.fields)) {
      const raw = asObject(fieldValue);
      const name = asText(raw.name);
      if (!name) continue;
      const type = asText(raw.type);
      if (type === 'number') fields[name] = { min: 1, max: 100 };
      else if (type === 'singleLineText' || type === 'longText') fields[name] = { width: 16 };
      else if (type === 'singleSelect' || type === 'multipleSelect') {
        const choices = asArray(asObject(raw.options).choices)
          .map((choice) => asText(asObject(choice).name))
          .filter((choice): choice is string => Boolean(choice));
        fields[name] = { choices };
      } else if (type === 'link') {
        const options = asObject(raw.options);
        const foreignTableId = asText(options.foreignTableId);
        const target = schema.rawTables.find((candidate) => candidate.id === foreignTableId);
        const targetName = asText(target?.name);
        const relationship = asText(options.relationship);
        if (targetName && (relationship === 'manyOne' || relationship === 'manyMany')) {
          fields[name] = { link: { table: targetName, relationship, fanout: 1 } };
        }
      }
    }
    tables[tableName] = { fields };
  }
  return { tables };
}

function rowValues(maxRows: number): ReadonlyArray<number> {
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new BenchError('bench.generator.limit_invalid', 'maxRows must be a positive integer', {
      maxRows,
    });
  }
  return maxRows >= 100 ? [10, 100] : maxRows > 10 ? [10, maxRows] : [maxRows];
}

type PairCoverage = {
  readonly label: string;
  readonly covers: (row: CoveringRow) => boolean;
};

function pairLabels(dimensions: ReadonlyArray<CoveringDimension>): ReadonlyArray<PairCoverage> {
  const pairs: PairCoverage[] = [];
  for (let left = 0; left < dimensions.length; left += 1) {
    for (let right = left + 1; right < dimensions.length; right += 1) {
      const leftDimension = dimensions[left]!;
      const rightDimension = dimensions[right]!;
      for (const leftValue of leftDimension.values) {
        for (const rightValue of rightDimension.values) {
          const label = pairLabel(leftDimension.name, leftValue, rightDimension.name, rightValue);
          pairs.push({
            label,
            covers: (row) =>
              row[leftDimension.name] === leftValue && row[rightDimension.name] === rightValue,
          });
        }
      }
    }
  }
  return pairs;
}

function workloadFor(motif: Motif, rowCount: number, typecast: boolean): BenchWorkloadStep[] {
  const queries: BenchWorkloadStep[] = [];
  const byTable = new Map<string, FieldMetadata[]>();
  for (const field of motif.fields) {
    const list = byTable.get(field.tableId) ?? [];
    list.push(field);
    byTable.set(field.tableId, list);
  }
  for (const fields of byTable.values()) {
    queries.push({
      key: `query-target-${fields[0]!.tableId}`,
      kind: 'query-core',
      table: fields[0]!.tableName,
      query: { projection: fields.map((field) => field.name), limit: 50 },
    });
  }
  return [
    {
      key: 'update-source',
      kind: 'write-update',
      table: motif.source.tableName,
      field: motif.source.name,
      rows: Math.min(5, rowCount),
      batchSize: Math.min(5, rowCount),
      typecast,
      selection: 'first',
      value: writeValue(motif.source, motif.sourceType),
    },
    { key: 'flush-computed', kind: 'flush-computed' },
    ...queries,
  ];
}

function materializedRows(
  schema: RawSchema,
  csvByEntry: ReadonlyMap<string, string>
): Record<string, number> {
  const rows: Record<string, number> = {};
  for (const table of schema.rawTables) {
    const tableId = asText(table.id);
    const tableName = asText(table.name);
    if (!tableId || !tableName) continue;
    const csv =
      csvByEntry.get(`tables/${tableId}.csv`) ?? csvByEntry.get(`tables/${tableName}.csv`);
    if (!csv) {
      throw new BenchError(
        'bench.dataset.csv_missing',
        `materialized derivation requires CSV for ${tableName}`
      );
    }
    rows[tableName] = parseCsv(csv).rows.length;
  }
  return rows;
}

export async function deriveCases(input: {
  teaPath: string;
  outDir: string;
  dataMode?: 'recipe' | 'materialized';
  limits?: {
    maxCases?: number;
    maxRows?: number;
    maxSearchStates?: number;
    maxGraphStates?: number;
    maxMillis?: number;
  };
}): Promise<DerivedCasesResult> {
  const maxCases = input.limits?.maxCases ?? 40;
  const maxRows = input.limits?.maxRows ?? 100;
  const maxSearchStates = input.limits?.maxSearchStates ?? 100_000;
  const maxGraphStates = input.limits?.maxGraphStates ?? 100_000;
  const maxMillis = input.limits?.maxMillis ?? 5_000;
  for (const [name, value] of Object.entries({
    maxCases,
    maxRows,
    maxSearchStates,
    maxGraphStates,
    maxMillis,
  })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new BenchError('bench.generator.limit_invalid', `${name} must be a positive integer`, {
        [name]: value,
      });
    }
  }

  const teaBytes = await readFile(input.teaPath);
  const archive = readTeaArchive(teaBytes);
  const rawSchema = readRawSchema(archive.structure);
  const profile = schemaFromDotTeaStructure(archive.structure);
  const graph = summarizeGraph({
    edges: profile.edges,
    fieldsById: rawSchema.fieldsById,
    maxGraphStates,
    maxMillis,
  });
  const motifs = classifyMotifs({
    obligations: graph.obligations,
    fieldsById: rawSchema.fieldsById,
  });
  const motifByKey = new Map(motifs.map((motif) => [motif.key, motif]));
  const dataMode = input.dataMode ?? 'recipe';
  const archiveRows =
    dataMode === 'materialized' ? materializedRows(rawSchema, archive.csvByEntry) : undefined;
  const rowsDomain =
    dataMode === 'materialized'
      ? [Math.max(0, ...Object.values(archiveRows!))]
      : rowValues(maxRows);
  const dimensions: CoveringDimension[] = [
    { name: 'motif', values: motifs.map((motif) => motif.key) },
    { name: 'rows', values: rowsDomain },
    { name: 'typecast', values: [false, true] },
    { name: 'backend', values: ['pglite', 'postgres'] },
  ];
  const covering =
    motifs.length === 0
      ? undefined
      : generateCoveringArray({ dimensions, maxSearchStates, maxMillis });
  const selectedRows = covering?.rows.slice(0, maxCases) ?? [];
  const droppedRows = covering?.rows.slice(maxCases) ?? [];
  const recipe = dataMode === 'recipe' ? recipeFor(rawSchema) : undefined;
  const schemaHash = sha256Hex(canonicalJson(archive.structure));
  const seed = { schema: 1, data: 1, query: 1, schedule: 1 } as const;
  const fixtureBytes = dataMode === 'recipe' ? writeTeaArchive(archive.structure) : teaBytes;
  const cases: GeneratedCase[] = [];
  const caseIdsByObligation = new Map<string, string[]>();
  const emittedRows: CoveringRow[] = [];
  const resourceSkippedRows: Array<{ readonly row: CoveringRow; readonly totalRows: number }> = [];
  const resourceSkippedObligationIds = new Set<string>();

  for (const row of selectedRows) {
    const motif = motifByKey.get(String(row.motif));
    if (!motif) continue;
    const rows = Number(row.rows);
    const backend = row.backend as BenchBackend;
    const typecast = Boolean(row.typecast);
    const rowsByTable: Record<string, number> = archiveRows ? { ...archiveRows } : {};
    if (!archiveRows) {
      for (const table of rawSchema.rawTables) {
        const tableId = asText(table.id);
        const tableName = asText(table.name);
        if (!tableId || !tableName) continue;
        rowsByTable[tableName] = motif.fields.some((field) => field.tableId === tableId)
          ? rows
          : Math.max(1, Math.round(rows / 10));
      }
    }
    const sourceRows = rowsByTable[motif.source.tableName] ?? 0;
    if (sourceRows <= 0) continue;
    const workload = workloadFor(motif, sourceRows, typecast);
    const targetTables = [...new Set(motif.fields.map((field) => field.tableName))];
    const obligationIds = motif.obligations.map((obligation) => obligation.id);
    const totalRows = Object.values(rowsByTable).reduce((sum, count) => sum + count, 0);
    if (totalRows > maxRows) {
      resourceSkippedRows.push({ row, totalRows });
      for (const obligationId of obligationIds) resourceSkippedObligationIds.add(obligationId);
      continue;
    }
    const oracle = [
      {
        key: 'derived-full-recompute',
        checkId: `recompute:${motif.key}`,
        description: `写入不同源值并排空后，对全部受影响目标执行完整重算比较（全 schema 总行数上限 ${maxRows}）`,
        obligationIds,
        kind: 'full-recompute' as const,
        tables: targetTables,
        maxRows,
      },
    ];
    const datasetHash = computeDatasetHash({
      dataMode,
      rows: rowsByTable,
      seed,
      recipe,
      csvByEntry: dataMode === 'materialized' ? archive.csvByEntry : undefined,
    });
    const caseId = computeCaseId({
      specVersion: 1,
      generatorVersion: 'tea-bench/derive-2',
      schemaHash,
      datasetHash,
      workload,
      oracle,
    });
    const manifest: BenchCaseManifest = {
      caseId,
      specVersion: 1,
      generatorVersion: 'tea-bench/derive-2',
      title: `derived:${motif.key}`,
      dimensions: row,
      source: { tea: 'fixture.tea', dataMode },
      dataset: {
        rows: rowsByTable,
        seed,
        ...(recipe ? { recipe } : {}),
        dataHash: datasetHash,
      },
      run: {
        backend,
        samples: 5,
        warmup: 2,
        repetitions: 1,
        seedBatchSize: 1000,
        actorId: 'usr_headless',
      },
      workload,
      oracle,
    };
    const dir = join(input.outDir, caseId, backend);
    await mkdir(dir, { recursive: true });
    const teaPath = join(dir, 'fixture.tea');
    const manifestPath = join(dir, 'case.manifest.json');
    await writeFile(teaPath, fixtureBytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    cases.push({ caseId, dir, manifestPath, teaPath });
    emittedRows.push(row);
    for (const obligation of motif.obligations) {
      const ids = caseIdsByObligation.get(obligation.id) ?? [];
      ids.push(caseId);
      caseIdsByObligation.set(obligation.id, ids);
    }
  }

  const allPairs = covering ? pairLabels(dimensions) : [];
  const generatorUncoveredPairs = new Set(covering?.uncoveredPairs ?? []);
  const coveredPairEntries = allPairs.filter((pair) => emittedRows.some((row) => pair.covers(row)));
  const coveredPairLabels = new Set(coveredPairEntries.map((pair) => pair.label));
  const uncoveredByEmission = allPairs
    .filter(
      (pair) => !generatorUncoveredPairs.has(pair.label) && !coveredPairLabels.has(pair.label)
    )
    .map((pair) => {
      const reason = resourceSkippedRows.some(({ row }) => pair.covers(row))
        ? 'maxRows'
        : droppedRows.some((row) => pair.covers(row))
          ? 'maxCases'
          : 'notEmitted';
      return `${pair.label} reason=${reason}`;
    });
  const uncoveredPairs = [...generatorUncoveredPairs, ...uncoveredByEmission];
  const obligations: DerivedObligation[] = graph.obligations.map((obligation) => {
    const coveredBy = [...new Set(caseIdsByObligation.get(obligation.id) ?? [])].sort();
    const unexecutedCause =
      obligation.conditionFieldIds.length > 0 || obligation.linkFieldId !== null;
    const status = unexecutedCause
      ? ('planned-gap' as const)
      : coveredBy.length > 0
        ? ('planned' as const)
        : ('applicable' as const);
    return {
      id: obligation.id,
      source: { tableId: obligation.source.tableId, fieldId: obligation.source.id },
      target: { tableId: obligation.target.tableId, fieldId: obligation.target.id },
      edge: {
        id: obligation.edgeId,
        fromTableId: obligation.edge.fromTableId,
        fromFieldId: obligation.edge.fromFieldId,
        toTableId: obligation.edge.toTableId,
        toFieldId: obligation.edge.toFieldId,
        kind: obligation.edge.kind,
        conditionFieldIds: obligation.conditionFieldIds,
        linkFieldId: obligation.linkFieldId,
      },
      status,
      reason: unexecutedCause
        ? '条件字段或关系成员变化尚未由生成的 workload 执行；计划中的源值写入不能证明该因果义务。'
        : coveredBy.length > 0
          ? 'exact source-target edge planned'
          : resourceSkippedObligationIds.has(obligation.id)
            ? 'not planned within maxRows'
            : 'not planned within maxCases',
      coveredBy: unexecutedCause ? [] : coveredBy,
    };
  });
  const computedFields = [...profile.fields]
    .filter((field) => field.isComputed)
    .map((field) => rawSchema.fieldsById.get(field.id))
    .filter((field): field is FieldMetadata => Boolean(field))
    .sort(
      (left, right) => left.tableId.localeCompare(right.tableId) || left.id.localeCompare(right.id)
    )
    .map((field) => {
      const exactObligations = obligations.filter((item) => item.target.fieldId === field.id);
      const coveredBy = [
        ...new Set(exactObligations.flatMap((obligation) => obligation.coveredBy)),
      ].sort();
      let reason: string | undefined;
      if (exactObligations.length === 0) {
        reason =
          graph.budget.truncatedBy.size > 0
            ? 'graph search truncated before an exact source-target obligation was established'
            : originOf(field)
              ? 'no eligible writable upstream source'
              : 'unsupported computed origin';
      } else if (coveredBy.length === 0) {
        reason = exactObligations.some((obligation) =>
          resourceSkippedObligationIds.has(obligation.id)
        )
          ? 'over maxRows'
          : 'over maxCases';
      }
      return {
        table: field.tableName,
        field: field.name,
        tableId: field.tableId,
        fieldId: field.id,
        coveredBy,
        ...(reason ? { reason } : {}),
      };
    });
  const motifCounts: Record<string, number> = {};
  for (const motif of motifs) {
    motifCounts[motif.tuple] = (motifCounts[motif.tuple] ?? 0) + motif.fields.length;
  }
  const totalPairs = covering?.receipt.completable ?? 0;
  const emptyPairReceipt: PairSearchReceipt & { covered: number } = {
    rawPairCountFormula: '0',
    rawPairCount: 0,
    completable: 0,
    nonCompletable: 0,
    unknown: 0,
    searchStates: 0,
    truncated: false,
    truncatedBy: [],
    unknownPairs: [],
    bounds: { maxSearchStates, maxMillis },
    covered: 0,
  };

  const skippedRowTotals = [...new Set(resourceSkippedRows.map(({ totalRows }) => totalRows))].sort(
    (left, right) => left - right
  );
  const gaps =
    resourceSkippedRows.length > 0
      ? [
          `not-executed: ${resourceSkippedRows.length} selected candidate(s) with full-schema row count ${skippedRowTotals.join(', ')} exceeds configured maxRows ${maxRows}; no partial data or inflated recompute cap was used.`,
        ]
      : [];
  const coveredPairs = coveredPairLabels.size;
  return {
    cases,
    coverage: {
      totalPairs,
      coveredPairs,
      uncoveredPairs,
      computedFields,
      obligations,
      receipt: {
        graph: {
          eligibleSources: graph.eligibleSources.length,
          discoveredObligations: graph.obligations.length,
          searchStates: graph.budget.searchStates,
          truncated: graph.budget.truncatedBy.size > 0,
          truncatedBy: [...graph.budget.truncatedBy],
          unknownSourceIds: graph.unknownSourceIds,
          bounds: { maxGraphStates, maxMillis },
        },
        pairs: covering ? { ...covering.receipt, covered: coveredPairs } : emptyPairReceipt,
        data: {
          requested: dataMode,
          selected: dataMode,
          provenance:
            dataMode === 'recipe' ? 'schema-synthetic-recipe' : 'archive-materialized-csv',
          archiveCsvEntries: archive.csvByEntry.size,
        },
        gaps,
      },
    },
    schema: {
      tables: profile.tableNames.size,
      fields: profile.fields.length,
      computedFields: profile.fields.filter((field) => field.isComputed).length,
      motifs: motifCounts,
    },
  };
}
