import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

import { v2DataDbTokens } from '@teable/v2-adapter-db-postgres-shared';
import type {
  ComplexityAssessment,
  DotTeaSchemaProfile,
  OperationDescriptor,
  SchemaComplexityAssumptions,
  SchemaComplexityProfile,
} from '@teable/v2-complexity';
import {
  buildComplexityAssessment,
  buildSchemaComplexityProfile,
  schemaFromDotTeaStructure,
  simulateSchemaComplexity,
} from '@teable/v2-complexity';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { resolveCsvTable } from '../dataset/csv';
import { generateTableRows } from '../dataset/recipe';
import { BenchError } from '../errors';
import { parseCsv } from '../tea/csv';
import { readTeaArchive } from '../tea/teaZip';
import { canonicalJson, sha256Hex } from './canonicalJson';
import {
  applyLinks,
  createBaseAndImport,
  createRecordsWithoutLinks,
  createRuntimeForBackend,
  resolveTables,
} from './loadSteps';
import type { BenchCaseManifest, BenchDatasetRecipe, BenchWorkloadStep } from './manifest';
import { verifyCaseId } from './manifest';
import { closeBenchRuntime, closeBenchRuntimeAfterError } from './runtimeLifecycle';
import type { LoadedCase, ResolvedTable } from './types';

export type BenchExecutionContext = {
  readonly backend: { readonly kind: 'pglite' | 'postgres'; readonly connectionString?: string };
  readonly manifestDir: string;
  readonly actorId: string;
};

const executionContexts = new WeakMap<LoadedCase, BenchExecutionContext>();

export function getLoadedCaseExecutionContext(loaded: LoadedCase): BenchExecutionContext {
  const value = executionContexts.get(loaded);
  if (!value)
    throw new BenchError(
      'bench.case.execution_context_missing',
      'Loaded case context is unavailable'
    );
  return value;
}

const validateWorkload = (
  manifest: BenchCaseManifest,
  schemaProfile: DotTeaSchemaProfile
): void => {
  const tableNames = [...schemaProfile.tableNames.values()];
  if (new Set(tableNames).size !== tableNames.length) {
    throw new BenchError('bench.table.ambiguous', 'The DotTea structure has duplicate table names');
  }
  const fieldsByTable = new Map<string, Set<string>>();
  for (const field of schemaProfile.fields) {
    const names = fieldsByTable.get(field.tableId) ?? new Set<string>();
    const name = schemaProfile.fieldNames.get(field.id);
    if (name) names.add(name);
    names.add(field.id);
    fieldsByTable.set(field.tableId, names);
  }
  manifest.workload.forEach((step) => {
    if ('table' in step) {
      const matches = [...schemaProfile.tableNames].filter(
        ([id, name]) => id === step.table || name === step.table
      );
      if (matches.length !== 1)
        throw new BenchError('bench.table.unknown', `Unknown table ${step.table}`);
      if ('field' in step && !fieldsByTable.get(matches[0]![0])?.has(step.field)) {
        throw new BenchError('bench.field.unknown', `Unknown field ${step.table}.${step.field}`);
      }
    }
  });
};

const resolveRecipe = (
  manifest: BenchCaseManifest,
  tables: ReadonlyMap<string, ResolvedTable>
): BenchDatasetRecipe['tables'] => {
  const resolveTable = (reference: string): ResolvedTable => {
    const table =
      tables.get(reference) ??
      [...tables.values()].find(
        (candidate) => candidate.id === reference || candidate.declaredId === reference
      );
    if (!table) throw new BenchError('bench.table.unknown', `Unknown recipe table ${reference}`);
    return table;
  };
  const resolved: Record<string, BenchDatasetRecipe['tables'][string]> = {};
  for (const [reference, recipe] of Object.entries(
    manifest.dataset.recipe?.tables ?? ({} as BenchDatasetRecipe['tables'])
  )) {
    const table = resolveTable(reference);
    const fields: Record<string, BenchDatasetRecipe['tables'][string]['fields'][string]> = {};
    for (const [fieldReference, config] of Object.entries(recipe.fields)) {
      const field =
        table.fields.get(fieldReference) ??
        [...table.fields.values()].find(
          (candidate) => candidate.id === fieldReference || candidate.declaredId === fieldReference
        );
      if (!field) {
        throw new BenchError(
          'bench.field.unknown',
          `Unknown recipe field ${table.name}.${fieldReference}`
        );
      }
      if (config.link) {
        const target = resolveTable(config.link.table);
        if (
          !field.link ||
          field.link.table !== target.name ||
          field.link.relationship !== config.link.relationship
        ) {
          throw new BenchError(
            'bench.field.unknown',
            `Recipe link does not match ${table.name}.${field.name}`
          );
        }
        fields[field.name] = { ...config, link: { ...config.link, table: target.name } };
      } else {
        fields[field.name] = config;
      }
    }
    resolved[table.name] = { fields };
  }
  return resolved;
};

export type ComplexityChangeRateAssumption = {
  readonly value: number;
  readonly source: string;
  readonly evidence: string;
};

export type ComplexitySimulationProvenance = {
  readonly rowCounts: {
    readonly source: 'manifest.dataset.rows';
    readonly tableNamesById: Readonly<Record<string, string>>;
  };
  readonly seedRecordCount: {
    readonly source: 'manifest.workload.rows';
    readonly operationKey: string;
  };
  readonly linkFanout: Readonly<
    Record<
      string,
      | {
          readonly source: 'manifest.dataset.recipe.link.fanout' | 'dataset-recipe-default-fanout';
          readonly value: number;
        }
      | {
          readonly source: 'deterministic-workload-link-state';
          readonly value: number;
          readonly direction: 'inbound-to-selected-source';
          readonly initialState: 'recipe-without-link-config-is-empty';
          readonly sourceTableId: string;
          readonly targetTableId: string;
          readonly sourceIndices: ReadonlyArray<number>;
          readonly setupOperationKeys: ReadonlyArray<string>;
        }
    >
  >;
  readonly changeRate:
    | {
        readonly source: 'manifest.dimensions.complexityAssumptions.changeRateByOperation';
        readonly value: number;
        readonly declaredSource: string;
        readonly evidence: string;
      }
    | {
        readonly source: 'unavailable';
        readonly value: null;
        readonly reason: 'no-explicit-manifest-assumption-or-deterministic-proof';
      };
};

export type BenchComplexityAssessment = ComplexityAssessment & {
  readonly scoreProvenance:
    | {
        readonly kind: 'assumption-backed';
        readonly assumption: 'changeRate';
        readonly source: 'manifest.dimensions.complexityAssumptions.changeRateByOperation';
        readonly declaredSource: string;
        readonly evidence: string;
      }
    | { readonly kind: 'incomplete-input'; readonly missingAssumption: 'changeRate' }
    | { readonly kind: 'schema-only' };
  readonly simulation:
    | {
        readonly kind: 'workload-operation';
        readonly operation: OperationDescriptor;
        readonly assumptions: SchemaComplexityAssumptions;
        readonly provenance: ComplexitySimulationProvenance;
      }
    | {
        readonly kind: 'schema-only';
        readonly reason: 'manifest-has-no-write-operations';
      };
};

export type BuiltCaseComplexity = {
  readonly profile: SchemaComplexityProfile;
  readonly assessments: Readonly<Record<string, BenchComplexityAssessment>>;
  readonly warnings: ReadonlyArray<string>;
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const NO_CHANGE_RATE_ASSUMPTIONS: ReadonlyMap<string, ComplexityChangeRateAssumption> = new Map();

const readChangeRateAssumptions = (
  manifest: BenchCaseManifest
): ReadonlyMap<string, ComplexityChangeRateAssumption> => {
  const dimensions = object(manifest.dimensions);
  const rawComplexityAssumptions = dimensions?.complexityAssumptions;
  if (rawComplexityAssumptions === undefined) return NO_CHANGE_RATE_ASSUMPTIONS;
  const complexityAssumptions = object(rawComplexityAssumptions);
  if (!complexityAssumptions) {
    throw new BenchError(
      'bench.complexity.assumption_invalid',
      'dimensions.complexityAssumptions must be an object'
    );
  }
  const rawByOperation = complexityAssumptions.changeRateByOperation;
  if (rawByOperation === undefined) return NO_CHANGE_RATE_ASSUMPTIONS;
  const byOperation = object(rawByOperation);
  if (!byOperation) {
    throw new BenchError(
      'bench.complexity.assumption_invalid',
      'dimensions.complexityAssumptions.changeRateByOperation must be an object'
    );
  }
  const writeKeys = new Set(
    manifest.workload.filter((step) => step.kind.startsWith('write-')).map((step) => step.key)
  );
  const result = new Map<string, ComplexityChangeRateAssumption>();
  for (const [operationKey, rawAssumption] of Object.entries(byOperation)) {
    const assumption = object(rawAssumption);
    const value = assumption?.value;
    const source = assumption?.source;
    const evidence = assumption?.evidence;
    if (
      !writeKeys.has(operationKey) ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1 ||
      typeof source !== 'string' ||
      source.trim().length === 0 ||
      typeof evidence !== 'string' ||
      evidence.trim().length === 0
    ) {
      throw new BenchError(
        'bench.complexity.assumption_invalid',
        `Invalid change-rate assumption for ${operationKey}`
      );
    }
    result.set(operationKey, { value, source, evidence });
  }
  return result;
};

/** Exact inbound degree for the runner's first source row, never outbound link cardinality. */
const workloadInboundFanout = (
  manifest: BenchCaseManifest,
  profile: DotTeaSchemaProfile,
  step: Extract<BenchWorkloadStep, { kind: `write-${string}` }>,
  sourceTableId: string,
  structure: unknown
): {
  readonly values: NonNullable<SchemaComplexityAssumptions['linkFanout']>;
  readonly provenance: ComplexitySimulationProvenance['linkFanout'];
} => {
  const values: Record<string, { mean: number; p50: number; p95: number; max: number }> = {};
  const provenance: Record<string, ComplexitySimulationProvenance['linkFanout'][string]> = {};
  if (
    manifest.source.dataMode !== 'recipe' ||
    step.kind !== 'write-update' ||
    step.rows !== 1 ||
    (step.selection ?? 'first') !== 'first'
  )
    return { values, provenance };
  const tableIdFor = (reference: string): string | undefined =>
    [...profile.tableNames].find(([id, name]) => reference === id || reference === name)?.[0];
  const preceding = manifest.workload.slice(0, manifest.workload.indexOf(step));
  const rawTables = object(structure)?.tables;
  if (!Array.isArray(rawTables)) return { values, provenance };
  const sourceName = profile.tableNames.get(sourceTableId);
  if (sourceName === undefined || (manifest.dataset.rows[sourceName] ?? 0) < 1) {
    return { values, provenance };
  }
  // A physical link can contribute several dependency edges (for example,
  // its stored title and a lookup). Prove one relationship, not one edge.
  const sourceEdges = profile.edges.filter(
    (edge) => edge.fromTableId === sourceTableId && edge.kind === 'cross_record'
  );
  const linkIds = new Set(sourceEdges.map((edge) => edge.linkFieldId));
  if (linkIds.size !== 1 || linkIds.has(undefined)) return { values, provenance };
  for (const edge of sourceEdges.slice(0, 1)) {
    if (!edge.linkFieldId) continue;
    const linkField = profile.fields.find((field) => field.id === edge.linkFieldId);
    if (!linkField || linkField.type !== 'link' || linkField.tableId !== edge.toTableId) continue;
    const relationshipEdges = profile.edges.filter(
      (candidate) => candidate.linkFieldId === edge.linkFieldId
    );
    if (
      relationshipEdges.some(
        (candidate) =>
          candidate.kind !== 'cross_record' ||
          candidate.fromTableId !== sourceTableId ||
          candidate.toTableId !== edge.toTableId
      ) ||
      new Set(
        relationshipEdges.map((candidate) => `${candidate.fromFieldId}:${candidate.toFieldId}`)
      ).size !== relationshipEdges.length
    ) {
      continue;
    }
    const rawTargetTable = rawTables.find((table) => object(table)?.id === edge.toTableId);
    const rawFields = object(rawTargetTable)?.fields;
    if (!Array.isArray(rawFields)) continue;
    const rawLink = rawFields.find((field) => object(field)?.id === linkField.id);
    const linkOptions = object(object(rawLink)?.options);
    if (
      linkOptions?.relationship !== 'manyOne' ||
      linkOptions.isOneWay !== true ||
      linkOptions.foreignTableId !== sourceTableId
    )
      continue;
    const targetTableName = profile.tableNames.get(edge.toTableId);
    const linkFieldName = profile.fieldNames.get(linkField.id);
    if (!targetTableName || !linkFieldName) continue;
    const recipe =
      manifest.dataset.recipe?.tables[targetTableName] ??
      manifest.dataset.recipe?.tables[edge.toTableId];
    if (recipe?.fields[linkFieldName]?.link || recipe?.fields[linkField.id]?.link) continue;
    const targetRows = manifest.dataset.rows[targetTableName];
    if (targetRows === undefined || !Number.isInteger(targetRows) || targetRows < 0) continue;
    // Recipe generation leaves unconfigured link fields empty. Each supported
    // update replaces the first N memberships exactly, as executeStep does.
    const linkedToSource = new Uint8Array(targetRows);
    const setupOperationKeys: string[] = [];
    let known = true;
    for (const prior of preceding) {
      if (prior.kind === 'expect-error') {
        known = false;
        break;
      }
      if (!('table' in prior)) continue;
      const priorTableId = tableIdFor(prior.table);
      if (
        (prior.kind === 'write-create' || prior.kind === 'write-delete') &&
        (priorTableId === sourceTableId || priorTableId === edge.toTableId)
      ) {
        known = false;
        break;
      }
      if (prior.kind !== 'write-update' || priorTableId !== edge.toTableId) continue;
      if (prior.field !== linkField.id && prior.field !== linkFieldName) continue;
      if (
        (prior.selection ?? 'first') !== 'first' ||
        prior.value.kind !== 'link-targets' ||
        prior.value.indices.length > 1 ||
        tableIdFor(prior.value.table) !== sourceTableId
      ) {
        known = false;
        break;
      }
      const sourceRows = manifest.dataset.rows[sourceName];
      if (
        sourceRows === undefined ||
        prior.value.indices.some(
          (index) => !Number.isInteger(index) || index < 0 || index >= sourceRows
        )
      ) {
        known = false;
        break;
      }
      linkedToSource.fill(
        prior.value.indices.includes(0) ? 1 : 0,
        0,
        Math.min(prior.rows, targetRows)
      );
      setupOperationKeys.push(prior.key);
    }
    if (!known || setupOperationKeys.length === 0) continue;
    const fanout = linkedToSource.reduce((sum, linked) => sum + linked, 0);
    values[linkField.id] = { mean: fanout, p50: fanout, p95: fanout, max: fanout };
    provenance[linkField.id] = {
      source: 'deterministic-workload-link-state',
      value: fanout,
      direction: 'inbound-to-selected-source',
      initialState: 'recipe-without-link-config-is-empty',
      sourceTableId,
      targetTableId: edge.toTableId,
      sourceIndices: [0],
      setupOperationKeys,
    };
  }
  return { values, provenance };
};

/**
 * Builds the exact deterministic complexity payload used by a benchmark run.
 * This seam is pure: callers can inspect scores, unknowns, and every simulation
 * assumption without importing a fixture into a runtime or database.
 */
export function buildCaseComplexity(
  manifest: BenchCaseManifest,
  profile: DotTeaSchemaProfile,
  structure?: unknown
): BuiltCaseComplexity {
  const baseProfile = buildSchemaComplexityProfile({
    fields: profile.fields,
    edges: profile.edges,
    completeness: profile.completeness,
  });
  const assessments: Record<string, BenchComplexityAssessment> = {};
  const rowCounts: Record<string, number> = {};
  const tableNamesById: Record<string, string> = {};
  for (const [tableId, tableName] of profile.tableNames) {
    rowCounts[tableId] = manifest.dataset.rows[tableName] ?? 0;
    tableNamesById[tableId] = tableName;
  }
  const linkFanout: Record<string, { mean: number; p50: number; p95: number; max: number }> = {};
  const linkFanoutProvenance: {
    [fieldId: string]: ComplexitySimulationProvenance['linkFanout'][string];
  } = {};
  for (const [tableName, recipe] of Object.entries(manifest.dataset.recipe?.tables ?? {})) {
    const tableId = [...profile.tableNames].find(([, name]) => name === tableName)?.[0];
    if (!tableId) continue;
    for (const [fieldName, config] of Object.entries(recipe.fields)) {
      if (!config.link) continue;
      const fieldId = profile.fields.find(
        (field) => field.tableId === tableId && profile.fieldNames.get(field.id) === fieldName
      )?.id;
      if (!fieldId) continue;
      const fanout = config.link.fanout ?? 1;
      linkFanout[fieldId] = { mean: fanout, p50: fanout, p95: fanout, max: fanout };
      linkFanoutProvenance[fieldId] = {
        source:
          config.link.fanout === undefined
            ? 'dataset-recipe-default-fanout'
            : 'manifest.dataset.recipe.link.fanout',
        value: fanout,
      };
    }
  }
  const changeRateAssumptions = readChangeRateAssumptions(manifest);
  const writes = manifest.workload.filter(
    (step): step is Extract<BenchWorkloadStep, { kind: `write-${string}` }> =>
      step.kind === 'write-create' || step.kind === 'write-update' || step.kind === 'write-delete'
  );
  for (const step of writes) {
    const tableId =
      [...profile.tableNames].find(([, name]) => name === step.table)?.[0] ?? step.table;
    const changedFieldIds =
      step.kind === 'write-update'
        ? [
            profile.fields.find(
              (field) =>
                field.tableId === tableId && profile.fieldNames.get(field.id) === step.field
            )?.id ?? step.field,
          ]
        : [];
    const operation: OperationDescriptor = {
      kind:
        step.kind === 'write-create'
          ? 'create'
          : step.kind === 'write-update'
            ? 'update'
            : 'delete',
      tableId,
      changedFieldIds,
    };
    const changeRateAssumption = changeRateAssumptions.get(step.key);
    const inboundFanout = workloadInboundFanout(manifest, profile, step, tableId, structure);
    const assumptions: SchemaComplexityAssumptions = {
      rowCounts,
      seedRecordCount: step.rows,
      linkFanout: { ...linkFanout, ...inboundFanout.values },
      ...(changeRateAssumption ? { changeRate: changeRateAssumption.value } : {}),
    };
    const assessment = buildComplexityAssessment(
      simulateSchemaComplexity({
        schema: { fields: profile.fields, edges: profile.edges },
        operation,
        assumptions,
        completeness: profile.completeness,
      })
    );
    assessments[step.key] = {
      ...assessment,
      scoreProvenance: changeRateAssumption
        ? {
            kind: 'assumption-backed',
            assumption: 'changeRate',
            source: 'manifest.dimensions.complexityAssumptions.changeRateByOperation',
            declaredSource: changeRateAssumption.source,
            evidence: changeRateAssumption.evidence,
          }
        : { kind: 'incomplete-input', missingAssumption: 'changeRate' },
      simulation: {
        kind: 'workload-operation',
        operation,
        assumptions,
        provenance: {
          rowCounts: { source: 'manifest.dataset.rows', tableNamesById },
          seedRecordCount: {
            source: 'manifest.workload.rows',
            operationKey: step.key,
          },
          linkFanout: { ...linkFanoutProvenance, ...inboundFanout.provenance },
          changeRate: changeRateAssumption
            ? {
                source: 'manifest.dimensions.complexityAssumptions.changeRateByOperation',
                value: changeRateAssumption.value,
                declaredSource: changeRateAssumption.source,
                evidence: changeRateAssumption.evidence,
              }
            : {
                source: 'unavailable',
                value: null,
                reason: 'no-explicit-manifest-assumption-or-deterministic-proof',
              },
        },
      },
    };
  }
  if (writes.length === 0) {
    const assessment: BenchComplexityAssessment = {
      ...buildComplexityAssessment(baseProfile),
      scoreProvenance: { kind: 'schema-only' },
      simulation: {
        kind: 'schema-only',
        reason: 'manifest-has-no-write-operations',
      },
    };
    for (const step of manifest.workload) assessments[step.key] = assessment;
  }
  return { profile: baseProfile, assessments, warnings: profile.warnings };
}

export async function loadCase(input: {
  teaPath: string;
  manifest: BenchCaseManifest;
  backendOverride?: 'pglite' | 'postgres';
  connectionString?: string;
  manifestDir?: string;
}): Promise<LoadedCase> {
  const teaBytes = new Uint8Array(await readFile(input.teaPath));
  const archive = readTeaArchive(teaBytes);
  const schemaProfile = schemaFromDotTeaStructure(archive.structure);
  verifyCaseId(input.manifest, sha256Hex(canonicalJson(archive.structure)), archive.csvByEntry);
  validateWorkload(input.manifest, schemaProfile);
  const backend = input.backendOverride ?? input.manifest.run.backend;
  const runtime = await createRuntimeForBackend({
    backend,
    connectionString: input.connectionString,
  });
  // The shared lifecycle helper owns runtime.close() and the PostgreSQL pools.
  const dataDb =
    backend === 'postgres'
      ? runtime.container.resolve<Kysely<unknown>>(v2DataDbTokens.db)
      : undefined;
  const environmentWarnings: string[] = [];
  let pgVersion: string | undefined;
  try {
    if (dataDb) {
      try {
        const result = await sql<{ version: string }>`select version() as version`.execute(dataDb);
        pgVersion = result.rows[0]?.version;
      } catch {
        environmentWarnings.push('bench.environment.pg_version_unavailable');
      }
    }
    const importStarted = performance.now();
    const { baseId } = await createBaseAndImport({
      runtime,
      baseName: input.manifest.title,
      teaBytes,
      actorId: input.manifest.run.actorId,
    });
    const importMs = performance.now() - importStarted;
    const resolveStarted = performance.now();
    const tables = await resolveTables({
      runtime,
      baseId,
      schemaProfile,
      actorId: input.manifest.run.actorId,
    });
    const recipes = resolveRecipe(input.manifest, tables);
    const resolveMs = performance.now() - resolveStarted;
    for (const tableName of schemaProfile.tableNames.values()) {
      const rows = input.manifest.dataset.rows[tableName];
      if (!Number.isInteger(rows) || rows! < 0) {
        throw new BenchError('bench.dataset.rows_missing', `Dataset rows missing for ${tableName}`);
      }
    }
    const seedStarted = performance.now();
    const seedRows = new Map<string, ReadonlyArray<Readonly<Record<string, unknown>>>>();
    const seedLinks = new Map<
      string,
      Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>>
    >();
    for (const table of tables.values()) {
      const count = input.manifest.dataset.rows[table.name]!;
      if (count === 0) {
        seedRows.set(table.name, []);
        seedLinks.set(table.name, {});
        continue;
      }
      if (input.manifest.source.dataMode === 'materialized') {
        const csvText =
          (table.declaredId
            ? archive.csvByEntry.get(`tables/${table.declaredId}.csv`)
            : undefined) ?? archive.csvByEntry.get(`tables/${table.name}.csv`);
        if (!csvText)
          throw new BenchError('bench.dataset.csv_missing', `CSV missing for ${table.name}`);
        const resolved = resolveCsvTable({ tableName: table.name, table, csv: parseCsv(csvText) });
        if (resolved.rows.length !== count) {
          throw new BenchError(
            'bench.dataset.row_count_mismatch',
            `${table.name}: expected ${count}, received ${resolved.rows.length}`
          );
        }
        seedRows.set(table.name, resolved.rows);
        seedLinks.set(table.name, resolved.links);
      } else {
        const generated = generateTableRows({
          table: table.name,
          rows: count,
          fields: Object.fromEntries(
            [...table.fields.values()].map((field) => [
              field.name,
              {
                type: field.type,
                isComputed: field.isComputed,
                isPrimary: field.isPrimary,
                isMultiple: field.isMultiple,
                ...(field.choices ? { choices: field.choices } : {}),
                ...(field.ratingMax !== undefined ? { ratingMax: field.ratingMax } : {}),
              },
            ])
          ),
          recipe: recipes[table.name],
          targetRowCounts: input.manifest.dataset.rows,
          seed: input.manifest.dataset.seed.data,
          actorId: input.manifest.run.actorId,
        });
        seedRows.set(
          table.name,
          generated.map((row) => row.fields)
        );
        seedLinks.set(
          table.name,
          Object.fromEntries(
            [...table.fields.values()]
              .filter((field) => field.link)
              .map((field) => [
                field.name,
                generated.map((row) => (row.links[field.name]?.targetIndices ?? []).map(String)),
              ])
          )
        );
      }
    }
    const recordsByTable = new Map<
      string,
      ReadonlyArray<{ readonly id: string; readonly primary: unknown }>
    >();
    for (const table of tables.values()) {
      const records = await createRecordsWithoutLinks({
        runtime,
        table,
        rows: seedRows.get(table.name) ?? [],
        batchSize: input.manifest.run.seedBatchSize,
        actorId: input.manifest.run.actorId,
      });
      if (records.length !== input.manifest.dataset.rows[table.name]) {
        throw new BenchError(
          'bench.dataset.row_count_mismatch',
          `Seed count mismatch for ${table.name}`
        );
      }
      recordsByTable.set(table.name, records);
    }
    for (const table of tables.values()) {
      const rawLinks = seedLinks.get(table.name) ?? {};
      const links = Object.fromEntries(
        Object.entries(rawLinks).map(([fieldName, rows]) => {
          const field = table.fields.get(fieldName);
          const targetRecords = field?.link ? recordsByTable.get(field.link.table) : undefined;
          if (input.manifest.source.dataMode === 'recipe' && targetRecords) {
            return [
              fieldName,
              rows.map((indices) =>
                indices.map((value) => targetRecords[Number(value)]?.id ?? value)
              ),
            ];
          }
          return [fieldName, rows];
        })
      );
      await applyLinks({
        runtime,
        table,
        links,
        recordsByTable,
        batchSize: input.manifest.run.seedBatchSize,
        actorId: input.manifest.run.actorId,
      });
    }
    const seedMs = performance.now() - seedStarted;
    const flushStarted = performance.now();
    await runtime.flushComputed();
    const flushMs = performance.now() - flushStarted;
    const complexity = buildCaseComplexity(input.manifest, schemaProfile, archive.structure);
    const loaded: LoadedCase = {
      manifest: input.manifest,
      runtime,
      baseId,
      environment: { ...(pgVersion ? { pgVersion } : {}) },
      tables,
      recordsByTable,
      complexity: {
        ...complexity,
        warnings: [...complexity.warnings, ...environmentWarnings],
      },
      setup: {
        importMs,
        resolveMs,
        seedMs,
        flushMs,
        totalRows: [...recordsByTable.values()].reduce((sum, rows) => sum + rows.length, 0),
      },
      close: async () => closeBenchRuntime(runtime),
    };
    executionContexts.set(loaded, {
      backend: {
        kind: backend,
        ...(input.connectionString ? { connectionString: input.connectionString } : {}),
      },
      manifestDir: input.manifestDir ?? dirname(input.teaPath),
      actorId: input.manifest.run.actorId,
    });
    return loaded;
  } catch (error) {
    return closeBenchRuntimeAfterError(runtime, error);
  }
}
