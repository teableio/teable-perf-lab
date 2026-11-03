import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  ActorId,
  CreateRecordsCommand,
  type CreateRecordsResult,
  DeleteRecordsCommand,
  type DeleteRecordsResult,
  MAX_RECORDS_LIMIT,
  ListTableRecordsQuery,
  type ListTableRecordsResult,
  UpdateRecordsCommand,
  type UpdateRecordsResult,
} from '@teable/v2-core';
import type { Result } from 'neverthrow';

import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import {
  parseBenchCaseManifest,
  type BenchCaseManifest,
  type BenchCheckpointCheck,
  type BenchQuery,
  type BenchWorkloadStep,
} from '../case/manifest';
import { resolveDataQueryDefinition, resolveRecordQuery } from '../case/resolveQuery';
import { loadCase } from '../case/TeaCaseLoader';
import type { LoadedCase, ResolvedField, ResolvedTable } from '../case/types';
import { createDataQueryHarness, type DataQueryHarness } from '../dataQuery/DataQueryHarness';
import { mulberry32 } from '../dataset/prng';
import { generateTableRows } from '../dataset/recipe';
import { BenchError } from '../errors';
import { evaluateFullRecompute, type FullRecomputeReferenceStore } from '../oracle/fullRecompute';
import { normalizeValue } from '../oracle/normalize';
import { runOracles, type BenchOracleCheckReceipt, type BenchOracleResult } from '../oracle/types';
import {
  minimumSamplesForPercentileResolution,
  percentileResolutionWarnings,
  summarize,
} from './metrics';
import { evaluatePerformancePolicy, type BenchPerformanceEvaluation } from './performancePolicy';

const MAX_OPERATION_EVIDENCE_IDS = 100;
const MAX_SELECTED_VALUES_QUERY_SIZE = MAX_RECORDS_LIMIT;

/**
 * Identity of how latency samples are produced. Bump `version` whenever warmup, timing scope or
 * the reported statistic changes so calibrated series cannot silently reuse older measurements.
 */
export const BENCH_MEASUREMENT_PROTOCOL = {
  version: 2,
  warmupStrategy: 'fresh-full-workload-per-pass',
  timingScope: 'workload-operation-only',
  statistic: 'nearest-rank-p95',
} as const;

export type BenchMeasurementProtocol = typeof BENCH_MEASUREMENT_PROTOCOL;

export type BenchOperationObservation = {
  /** Returned or command-target records only; never interpreted as changed computed cells. */
  readonly recordIds: ReadonlyArray<string>;
  readonly recordRelation: 'returned' | 'command-target' | 'none';
  readonly fieldNames: ReadonlyArray<string>;
  readonly truncated: boolean;
};

export type BenchOperationMeasurement = {
  readonly key: string;
  readonly kind: BenchWorkloadStep['kind'];
  readonly samplesMs: ReadonlyArray<number>;
  readonly count: number;
  readonly minMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly maxMs: number | null;
  readonly meanMs: number | null;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsReturned: number;
  readonly processed: number;
  readonly errors: number;
  readonly warnings: ReadonlyArray<string>;
  readonly observation?: BenchOperationObservation;
};

export type BenchRunReport = {
  readonly runId: string;
  readonly caseId: string;
  readonly specVersion: 1;
  /** Always emitted by `runCase`; absent only in hand-built legacy or partial reports. */
  readonly measurementProtocol?: BenchMeasurementProtocol;
  readonly generatorVersion: string;
  readonly seed: BenchCaseManifest['dataset']['seed'];
  readonly warmup: number;
  readonly samples: number;
  readonly title: string;
  readonly dimensions?: Readonly<Record<string, unknown>>;
  readonly links?: BenchCaseManifest['links'];
  readonly backend: 'pglite' | 'postgres';
  readonly commit: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly manifestPath: string;
  readonly teaPath: string;
  readonly environment: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
    readonly runtime: string;
    readonly computationMode: 'hybrid-inline-and-flush';
    readonly pgVersion?: string;
  };
  readonly complexity: LoadedCase['complexity'];
  readonly budgets: BenchCaseManifest['budgets'];
  readonly repetitions: ReadonlyArray<BenchRepetitionReport>;
  readonly operations: ReadonlyArray<BenchOperationMeasurement>;
  readonly oracle: BenchOracleResult;
  readonly verdict: 'pass' | 'fail' | 'inconclusive';
  readonly correctnessVerdict?: 'pass' | 'fail' | 'inconclusive';
  readonly performance?: BenchPerformanceEvaluation;
  readonly performanceVerdict?: 'pass' | 'fail' | 'inconclusive' | 'not-compared';
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
};

/**
 * Source of truth for a report's measurement protocol. Hand-built or legacy reports without the
 * identity fail loudly instead of silently inheriting the current protocol.
 */
export function readBenchMeasurementProtocol(
  run: Pick<BenchRunReport, 'measurementProtocol'>
): BenchMeasurementProtocol {
  if (!run.measurementProtocol) {
    throw new BenchError(
      'bench.measurement_protocol.missing',
      'Report has no measurement protocol identity'
    );
  }
  return run.measurementProtocol;
}

type BenchRepetitionReport = {
  readonly index: number;
  readonly setup: LoadedCase['setup'];
  readonly phases: ReadonlyArray<{
    kind: 'warmup' | 'sample-setup' | 'measure' | 'oracle';
    durationMs: number;
    sampleIndex?: number;
  }>;
  readonly operations: ReadonlyArray<BenchOperationMeasurement>;
  readonly oracle: BenchOracleResult;
  readonly verdict: 'pass' | 'fail' | 'inconclusive';
  readonly performanceVerdict?: 'pass' | 'fail' | 'inconclusive' | 'not-compared';
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
};

type MutableMeasurement = {
  key: string;
  kind: BenchWorkloadStep['kind'];
  samplesMs: number[];
  rowsRead: number;
  rowsWritten: number;
  rowsReturned: number;
  processed: number;
  errors: number;
  warnings: string[];
  observation: {
    recordIds: string[];
    recordRelation: BenchOperationObservation['recordRelation'];
    fieldNames: string[];
    truncated: boolean;
  };
};

type StepResult = Pick<
  MutableMeasurement,
  'rowsRead' | 'rowsWritten' | 'rowsReturned' | 'processed'
> & {
  readonly observation?: BenchOperationObservation;
  /** Expected-error requests exclude the before/after unchanged-state oracle from timing. */
  readonly measuredDurationMs?: number;
};

type ExecutionRecord = { readonly id: string; readonly primary: unknown };

type PreparedCreateRow = {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly links: ReadonlyArray<{
    readonly fieldId: string;
    readonly targetTableId: string;
    readonly targetIndices: ReadonlyArray<number>;
  }>;
};

type PreparedCreateSample = {
  readonly rows: ReadonlyArray<PreparedCreateRow>;
};

type PreparedCreates = ReadonlyMap<string, ReadonlyArray<PreparedCreateSample>>;

const emptyOracleResult = (warning: string): BenchOracleResult => ({
  status: 'not-run',
  checks: [],
  warnings: [warning],
});

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const resolveTable = (
  tables: ReadonlyMap<string, ResolvedTable>,
  reference: string
): ResolvedTable => {
  const matches = [...tables.values()].filter(
    (table) => table.name === reference || table.declaredId === reference || table.id === reference
  );
  if (matches.length === 0) {
    throw new BenchError('bench.table.unknown', `Unknown table: ${reference}`);
  }
  if (matches.length > 1) {
    throw new BenchError('bench.table.ambiguous', `Ambiguous table: ${reference}`);
  }
  return matches[0]!;
};

const resolveField = (table: ResolvedTable, reference: string): ResolvedField => {
  const matches = [...table.fields.values()].filter(
    (field) => field.name === reference || field.declaredId === reference || field.id === reference
  );
  if (matches.length === 0) {
    throw new BenchError(
      'bench.field.unknown',
      `Unknown field ${reference} in table ${table.name}`
    );
  }
  if (matches.length > 1) {
    throw new BenchError(
      'bench.field.ambiguous',
      `Ambiguous field ${reference} in table ${table.name}`
    );
  }
  return matches[0]!;
};

const resolveViewId = (table: ResolvedTable, reference: string | undefined): string | undefined => {
  if (!reference) return undefined;
  const matches = [...(table.views?.entries() ?? [])]
    .filter(
      ([key, view]) =>
        key === reference ||
        view.name === reference ||
        view.declaredId === reference ||
        view.id === reference
    )
    .map(([, view]) => view)
    .filter(
      (view, index, views) => views.findIndex((candidate) => candidate.id === view.id) === index
    );
  if (matches.length === 0) {
    throw new BenchError('bench.view.unknown', `Unknown view ${reference} in table ${table.name}`);
  }
  if (matches.length > 1) {
    throw new BenchError(
      'bench.view.ambiguous',
      `Ambiguous view ${reference} in table ${table.name}`
    );
  }
  return matches[0]!.id;
};

const actorContext = (actorId: string) => ({ actorId: unwrap(ActorId.create(actorId)) });

const makeMutableMeasurement = (step: BenchWorkloadStep): MutableMeasurement => ({
  key: step.key,
  kind: step.kind,
  samplesMs: [],
  rowsRead: 0,
  rowsWritten: 0,
  rowsReturned: 0,
  processed: 0,
  errors: 0,
  warnings: [],
  observation: { recordIds: [], recordRelation: 'none', fieldNames: [], truncated: false },
});

const finalizeMeasurement = (measurement: MutableMeasurement): BenchOperationMeasurement => {
  for (const warning of percentileResolutionWarnings(measurement.samplesMs.length)) {
    if (!measurement.warnings.includes(warning)) measurement.warnings.push(warning);
  }
  if (measurement.samplesMs.length === 0) {
    return {
      ...measurement,
      count: 0,
      minMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
      meanMs: null,
    };
  }
  return { ...measurement, ...summarize(measurement.samplesMs) };
};
const mergeObservation = (
  target: MutableMeasurement['observation'],
  source: BenchOperationObservation
): void => {
  if (source.recordRelation !== 'none') target.recordRelation = source.recordRelation;
  for (const id of source.recordIds) {
    if (target.recordIds.includes(id)) continue;
    if (target.recordIds.length >= MAX_OPERATION_EVIDENCE_IDS) {
      target.truncated = true;
      break;
    }
    target.recordIds.push(id);
  }
  for (const name of source.fieldNames) {
    if (!target.fieldNames.includes(name)) target.fieldNames.push(name);
  }
  target.truncated ||= source.truncated;
};

const scopedCheckId = (input: {
  base: string;
  sampleIndex: number;
  samples: number;
  repetitionIndex: number;
  totalRepetitions: number;
}): string => {
  if (input.totalRepetitions > 1) {
    return `${input.base}#repetition-${input.repetitionIndex}${input.samples > 1 ? `/sample-${input.sampleIndex}` : ''}`;
  }
  return input.samples === 1 ? input.base : `${input.base}#sample-${input.sampleIndex}`;
};

const addWarning = (warnings: string[], warning: string): void => {
  if (!warnings.includes(warning)) warnings.push(warning);
};

const selectRecordIds = (input: {
  recordIds: ReadonlyArray<string>;
  rows: number;
  selection: 'first' | 'random';
  sampleIndex: number;
  stepIndex: number;
  seed: number;
  warnings: string[];
}): string[] => {
  if (input.recordIds.length === 0) {
    throw new BenchError('bench.workload.no_records', 'No records are available for selection');
  }
  if (input.rows > input.recordIds.length) {
    addWarning(input.warnings, 'bench.workload.rows_wrapped');
  }

  let ordered: ReadonlyArray<string> = input.recordIds;
  let offset = input.sampleIndex * input.rows;
  if (input.selection === 'random') {
    const random = mulberry32(input.seed + input.sampleIndex + input.stepIndex);
    const shuffled = [...input.recordIds];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const target = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
    }
    ordered = shuffled;
    offset = 0;
  }

  return Array.from(
    { length: input.rows },
    (_, index) => ordered[(offset + index) % ordered.length]!
  );
};

const batch = <T>(values: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> => {
  const batches: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    batches.push(values.slice(offset, offset + size));
  }
  return batches;
};

const buildGlobalFields = (
  tables: ReadonlyMap<string, ResolvedTable>
): ReadonlyMap<string, ResolvedField> => {
  const fields = new Map<string, ResolvedField>();
  for (const table of tables.values()) {
    for (const field of table.fields.values()) fields.set(field.id, field);
  }
  return fields;
};

const prepareCreateRows = (input: {
  manifest: BenchCaseManifest;
  tables: ReadonlyMap<string, ResolvedTable>;
}): PreparedCreates => {
  const nextIndexByTable = new Map<string, number>();
  const prepared = new Map<string, ReadonlyArray<PreparedCreateSample>>();
  const targetRowCounts: Record<string, number> = { ...input.manifest.dataset.rows };

  for (const entry of input.manifest.workload) {
    const create =
      entry.kind === 'write-create'
        ? entry
        : entry.kind === 'expect-error' && entry.step.kind === 'write-create'
          ? entry.step
          : undefined;
    if (!create) continue;
    const isExpectedFailure = entry.kind === 'expect-error';
    const table = resolveTable(input.tables, create.table);
    const start = nextIndexByTable.get(table.id) ?? input.manifest.dataset.rows[table.name] ?? 0;
    const end = start + create.rows;
    const generated = generateTableRows({
      table: table.name,
      rows: end,
      fields: Object.fromEntries(
        [...table.fields.values()].map((field) => [
          field.name,
          {
            type: field.type,
            isComputed: field.isComputed,
            isPrimary: field.isPrimary,
            isMultiple: field.isMultiple,
            choices: field.choices,
            // Without the imported maximum, rating values are generated up to five and a strict
            // create rejects every row above the real bound.
            ...(field.ratingMax !== undefined ? { ratingMax: field.ratingMax } : {}),
          },
        ])
      ),
      recipe: input.manifest.dataset.recipe?.tables[table.name],
      targetRowCounts,
      seed: input.manifest.dataset.seed.data,
      actorId: input.manifest.run.actorId,
    });
    const samples = [generated.slice(start, end)];
    prepared.set(
      entry.key,
      samples.map((rows) => ({
        rows: rows.map((row) => ({
          fields: Object.fromEntries(
            Object.entries(row.fields).map(([fieldName, value]) => [
              resolveField(table, fieldName).id,
              value,
            ])
          ),
          links: Object.entries(row.links).map(([fieldName, link]) => ({
            fieldId: resolveField(table, fieldName).id,
            targetTableId: resolveTable(input.tables, link.targetTable).id,
            targetIndices: link.targetIndices,
          })),
        })),
      }))
    );
    // An expected rejection must not consume row identity: the table keeps its row count.
    if (isExpectedFailure) continue;
    nextIndexByTable.set(table.id, end);
    targetRowCounts[table.name] = end;
  }
  return prepared;
};

type QueryCapture = {
  readonly ids: ReadonlyArray<string>;
  readonly values: ReadonlyArray<Record<string, unknown>>;
  readonly nextCursor?: string;
};

type SnapshotRow = { readonly id: string; readonly value: unknown };

/** Reads every row of a table through the real query path, ordered by record id. */
const readAllRecords = async (input: {
  loaded: LoadedCase;
  tableId: string;
}): Promise<ReadonlyArray<{ id: string; fields: Record<string, unknown> }>> => {
  const context = actorContext(input.loaded.manifest.run.actorId);
  const collected: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (;;) {
    const result = unwrap(
      await input.loaded.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
        context,
        unwrap(
          ListTableRecordsQuery.create({
            tableId: input.tableId,
            limit: 1000,
            ...(cursor === undefined ? {} : { cursor }),
            fieldKeyType: 'id',
          })
        )
      )
    );
    for (const record of result.records) {
      collected.push({ id: record.id, fields: record.fields });
    }
    if (!result.nextCursor) break;
    if (seenCursors.has(result.nextCursor)) {
      throw new BenchError(
        'bench.checkpoint.cursor_loop',
        'Query cursor repeated while reading rows'
      );
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return collected.sort((left, right) => left.id.localeCompare(right.id));
};

const snapshotSelectedValues = async (input: {
  loaded: LoadedCase;
  tableId: string;
  fieldId: string;
  rows: number;
}): Promise<ReadonlyArray<SnapshotRow>> => {
  const context = actorContext(input.loaded.manifest.run.actorId);
  const collected: SnapshotRow[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  while (collected.length < input.rows) {
    const result = unwrap(
      await input.loaded.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
        context,
        unwrap(
          ListTableRecordsQuery.create({
            tableId: input.tableId,
            limit: Math.min(MAX_SELECTED_VALUES_QUERY_SIZE, input.rows - collected.length),
            ...(cursor === undefined ? {} : { cursor }),
            projection: [input.fieldId],
            fieldKeyType: 'id',
          })
        )
      )
    );
    collected.push(
      ...result.records.map((record) => ({
        id: record.id,
        value: record.fields[input.fieldId] ?? null,
      }))
    );
    if (!result.nextCursor) break;
    if (seenCursors.has(result.nextCursor)) {
      throw new BenchError(
        'bench.checkpoint.cursor_loop',
        'Query cursor repeated while reading selected values'
      );
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }

  return collected.sort((left, right) => left.id.localeCompare(right.id));
};

export const snapshotSelectedValuesByIds = async (input: {
  loaded: LoadedCase;
  tableId: string;
  fieldId: string;
  selectedRecordIds: ReadonlyArray<string>;
}): Promise<ReadonlyArray<SnapshotRow>> => {
  if (input.selectedRecordIds.length === 0) return [];

  const context = actorContext(input.loaded.manifest.run.actorId);
  const collected: SnapshotRow[] = [];
  for (
    let offset = 0;
    offset < input.selectedRecordIds.length;
    offset += MAX_SELECTED_VALUES_QUERY_SIZE
  ) {
    const selectedRecordIds = input.selectedRecordIds.slice(
      offset,
      offset + MAX_SELECTED_VALUES_QUERY_SIZE
    );
    const result = unwrap(
      await input.loaded.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
        context,
        unwrap(
          ListTableRecordsQuery.create({
            tableId: input.tableId,
            selectedRecordIds,
            projection: [input.fieldId],
            limit: selectedRecordIds.length,
            fieldKeyType: 'id',
          })
        )
      )
    );
    collected.push(
      ...result.records.map((record) => ({
        id: record.id,
        value: record.fields[input.fieldId] ?? null,
      }))
    );
  }

  return collected.sort((left, right) => left.id.localeCompare(right.id));
};

export const selectedValuesAreUnchanged = (
  before: ReadonlyArray<SnapshotRow>,
  after: ReadonlyArray<SnapshotRow>
): boolean => canonicalJson(before) === canonicalJson(after);

const checkpointMethod = (check: BenchCheckpointCheck): string => {
  switch (check.kind) {
    case 'row-count':
      return 'exact-row-count';
    case 'field-values':
      return 'exact-field-values';
    case 'full-recompute':
      return 'full-recompute-at-sequence-position';
    case 'query-record-ids':
      return 'exact-record-id-sequence';
    case 'query-values':
      return 'exact-query-values';
  }
};

const resolveCursor = (
  cursor: BenchQuery['cursor'],
  queries: ReadonlyMap<string, QueryCapture>
): string | undefined => {
  if (cursor === undefined) return undefined;
  if (typeof cursor === 'string') return cursor;
  const capture = queries.get(cursor.fromOperation);
  if (!capture?.nextCursor) {
    throw new BenchError(
      'bench.query.cursor_missing',
      `Operation ${cursor.fromOperation} has no nextCursor to continue from`
    );
  }
  return capture.nextCursor;
};

const resolveLinkTargets = (input: {
  tables: ReadonlyMap<string, ResolvedTable>;
  recordsByTable: ReadonlyMap<string, ReadonlyArray<ExecutionRecord>>;
  table: string;
  indices: ReadonlyArray<number>;
}): ReadonlyArray<{ id: string }> => {
  const target = resolveTable(input.tables, input.table);
  const records = input.recordsByTable.get(target.id) ?? [];
  if (input.indices.length === 0) return [];
  return input.indices.map((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= records.length) {
      throw new BenchError(
        'bench.workload.link_target_out_of_range',
        `Link target index ${index} is outside ${target.name} (${records.length} records)`
      );
    }
    return { id: records[index]!.id };
  });
};

const writeValue = (input: {
  value: Extract<BenchWorkloadStep, { kind: 'write-update' }>['value'];
  valueIndex: number;
  tables: ReadonlyMap<string, ResolvedTable>;
  recordsByTable: ReadonlyMap<string, ReadonlyArray<ExecutionRecord>>;
}): unknown => {
  const { value, valueIndex } = input;
  switch (value.kind) {
    case 'literal':
      return value.value;
    case 'number-increment':
      return value.start + valueIndex * value.step;
    case 'text-suffix':
      return `${value.prefix}${valueIndex}`;
    case 'select-cycle':
      if (value.choices.length === 0) {
        throw new BenchError(
          'bench.workload.select_choices_empty',
          'select-cycle requires at least one choice'
        );
      }
      return value.choices[valueIndex % value.choices.length];
    case 'link-targets':
      return resolveLinkTargets({
        tables: input.tables,
        recordsByTable: input.recordsByTable,
        table: value.table,
        indices: value.indices,
      });
  }
};

const executeStep = async (input: {
  loaded: LoadedCase;
  manifest: BenchCaseManifest;
  step: BenchWorkloadStep;
  stepIndex: number;
  sampleIndex: number;
  /** Index into one fresh runtime's state; measured samples always use zero. */
  stateIndex?: number;
  repetitionIndex?: number;
  totalRepetitions?: number;
  measurement: MutableMeasurement;
  preparedCreates: PreparedCreates;
  recordsByTable: Map<string, ExecutionRecord[]>;
  structuredHarness: DataQueryHarness;
  teaPath: string;
  samples: number;
  checkpointChecks: BenchOracleCheckReceipt[];
  queries: Map<string, QueryCapture>;
  failures: string[];
  fullRecomputeReferences: FullRecomputeReferenceStore;
}): Promise<StepResult> => {
  const { loaded, manifest, step } = input;
  const stateIndex = input.stateIndex ?? input.sampleIndex;
  const context = actorContext(manifest.run.actorId);
  switch (step.kind) {
    case 'query-core': {
      const table = resolveTable(loaded.tables, step.table);
      const resolved = resolveRecordQuery({ table, ...step.query });
      const cursor = resolveCursor(step.query.cursor, input.queries);
      const result = unwrap(
        await loaded.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
          context,
          unwrap(
            ListTableRecordsQuery.create({
              tableId: table.id,
              ...resolved,
              limit: step.query.limit,
              offset: step.query.offset,
              ...(cursor === undefined ? {} : { cursor }),
              includeTotal: step.query.includeTotal,
              viewId: resolveViewId(table, step.query.viewId),
              fieldKeyType: 'id',
            })
          )
        )
      );
      const fieldNameById = new Map(
        [...table.fields.values()].map((field) => [field.id, field.name] as const)
      );
      input.queries.set(step.key, {
        ids: result.records.map((record) => record.id),
        values: result.records.map((record) =>
          Object.fromEntries(
            Object.entries(record.fields).map(([fieldId, value]) => [
              fieldNameById.get(fieldId) ?? fieldId,
              value,
            ])
          )
        ),
        nextCursor: result.nextCursor,
      });
      return {
        rowsRead: step.query.includeTotal ? result.total : 0,
        rowsWritten: 0,
        rowsReturned: result.records.length,
        processed: 0,
        observation: {
          recordIds: result.records.slice(0, MAX_OPERATION_EVIDENCE_IDS).map((record) => record.id),
          recordRelation: 'returned',
          fieldNames: [
            ...new Set(
              result.records
                .flatMap((record) => Object.keys(record.fields))
                .map((id) => fieldNameById.get(id) ?? id)
            ),
          ],
          truncated: result.records.length > MAX_OPERATION_EVIDENCE_IDS,
        },
      };
    }
    case 'query-structured': {
      const result = await input.structuredHarness.execute(
        resolveDataQueryDefinition({
          definition: step.definition,
          tables: loaded.tables,
          fields: buildGlobalFields(loaded.tables),
        }),
        step.parameters
      );
      const structuredRows = result.rows as unknown as ReadonlyArray<Record<string, unknown>>;
      input.queries.set(step.key, {
        ids: [],
        values: structuredRows.map((row) => ({ ...row })),
      });
      return {
        rowsRead: result.page?.total ?? 0,
        rowsWritten: 0,
        rowsReturned: result.rows.length,
        processed: 0,
        observation: {
          recordIds: [],
          recordRelation: 'none',
          fieldNames: [...new Set(structuredRows.flatMap((row) => Object.keys(row)))],
          truncated: false,
        },
      };
    }
    case 'write-create': {
      const table = resolveTable(loaded.tables, step.table);
      const sample = input.preparedCreates.get(step.key)?.[stateIndex];
      if (!sample) {
        throw new BenchError(
          'bench.workload.create_not_prepared',
          `Create rows not prepared: ${step.key}`
        );
      }
      const knownRecords = input.recordsByTable.get(table.id) ?? [];
      const primaryField = [...table.fields.values()].find((field) => field.isPrimary);
      const createdRecords: ExecutionRecord[] = [];
      for (const rowsBatch of batch(sample.rows, step.batchSize)) {
        const result = unwrap(
          await loaded.runtime.commandBus.execute<CreateRecordsCommand, CreateRecordsResult>(
            context,
            unwrap(
              CreateRecordsCommand.create({
                tableId: table.id,
                records: rowsBatch.map((row) => ({ fields: row.fields })),
                typecast: step.typecast,
                fieldKeyType: 'id',
              })
            )
          )
        );
        const batchRecords = result.records.map((record, index) => ({
          id: record.id().toString(),
          primary: primaryField ? rowsBatch[index]?.fields[primaryField.id] : undefined,
        }));
        createdRecords.push(...batchRecords);
        knownRecords.push(...batchRecords);
      }
      const linkUpdates: Array<{ id: string; fields: Record<string, unknown> }> = [];
      for (const [rowIndex, row] of sample.rows.entries()) {
        const host = createdRecords[rowIndex];
        if (!host || row.links.length === 0) continue;
        const fields: Record<string, unknown> = {};
        for (const link of row.links) {
          const targets =
            link.targetTableId === table.id
              ? knownRecords
              : (input.recordsByTable.get(link.targetTableId) ?? []);
          fields[link.fieldId] = link.targetIndices.map((targetIndex) => {
            const target = targets[targetIndex];
            if (!target) {
              throw new BenchError(
                'bench.link.target_missing',
                `Link target ${link.targetTableId}[${targetIndex}] is missing`
              );
            }
            return { id: target.id };
          });
        }
        linkUpdates.push({ id: host.id, fields });
      }
      for (const updatesBatch of batch(linkUpdates, step.batchSize)) {
        unwrap(
          await loaded.runtime.commandBus.execute<UpdateRecordsCommand, UpdateRecordsResult>(
            context,
            unwrap(
              UpdateRecordsCommand.create({
                tableId: table.id,
                records: updatesBatch,
                typecast: false,
                fieldKeyType: 'id',
              })
            )
          )
        );
      }
      input.recordsByTable.set(table.id, knownRecords);
      return {
        rowsRead: 0,
        rowsWritten: step.rows,
        rowsReturned: 0,
        processed: 0,
        observation: {
          recordIds: createdRecords.slice(0, MAX_OPERATION_EVIDENCE_IDS).map((record) => record.id),
          recordRelation: 'command-target',
          fieldNames: [
            ...new Set(
              sample.rows
                .flatMap((row) => Object.keys(row.fields))
                .map((id) => table.fields.get(id)?.name ?? id)
            ),
          ],
          truncated: createdRecords.length > MAX_OPERATION_EVIDENCE_IDS,
        },
      };
    }
    case 'write-update': {
      const table = resolveTable(loaded.tables, step.table);
      const field = resolveField(table, step.field);
      const selected = selectRecordIds({
        recordIds: (input.recordsByTable.get(table.id) ?? []).map((record) => record.id),
        rows: step.rows,
        selection: step.selection ?? 'first',
        sampleIndex: stateIndex,
        stepIndex: input.stepIndex,
        seed: manifest.dataset.seed.schedule,
        warnings: input.measurement.warnings,
      });
      const records = selected.map((id, rowIndex) => ({
        id,
        fields: {
          [field.id]: writeValue({
            value: step.value,
            valueIndex: stateIndex * step.rows + rowIndex,
            tables: loaded.tables,
            recordsByTable: input.recordsByTable,
          }),
        },
      }));
      for (const recordsBatch of batch(records, step.batchSize)) {
        unwrap(
          await loaded.runtime.commandBus.execute<UpdateRecordsCommand, UpdateRecordsResult>(
            context,
            unwrap(
              UpdateRecordsCommand.create({
                tableId: table.id,
                records: recordsBatch,
                typecast: step.typecast,
                fieldKeyType: 'id',
              })
            )
          )
        );
      }
      return {
        rowsRead: 0,
        rowsWritten: step.rows,
        rowsReturned: 0,
        processed: 0,
        observation: {
          recordIds: selected.slice(0, MAX_OPERATION_EVIDENCE_IDS),
          recordRelation: 'command-target',
          fieldNames: [field.name],
          truncated: selected.length > MAX_OPERATION_EVIDENCE_IDS,
        },
      };
    }
    case 'write-delete': {
      const table = resolveTable(loaded.tables, step.table);
      const knownRecords = input.recordsByTable.get(table.id) ?? [];
      if (step.rows > knownRecords.length) {
        throw new BenchError(
          'bench.workload.delete_rows_exhausted',
          `Delete ${step.key} needs ${step.rows} rows but only ${knownRecords.length} remain`
        );
      }
      let selectedRecords: ReadonlyArray<ExecutionRecord> = knownRecords.slice(0, step.rows);
      if ((step.selection ?? 'first') === 'random') {
        const random = mulberry32(manifest.dataset.seed.schedule + stateIndex + input.stepIndex);
        const shuffled = [...knownRecords];
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
          const target = Math.floor(random() * (index + 1));
          [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
        }
        selectedRecords = shuffled.slice(0, step.rows);
      }
      const selected = selectedRecords.map((record) => record.id);
      for (const idsBatch of batch(selected, step.batchSize)) {
        unwrap(
          await loaded.runtime.commandBus.execute<DeleteRecordsCommand, DeleteRecordsResult>(
            context,
            unwrap(DeleteRecordsCommand.create({ tableId: table.id, recordIds: idsBatch }))
          )
        );
      }
      const removed = new Set(selected);
      input.recordsByTable.set(
        table.id,
        knownRecords.filter((record) => !removed.has(record.id))
      );
      return {
        rowsRead: 0,
        rowsWritten: selected.length,
        rowsReturned: 0,
        processed: 0,
        observation: {
          recordIds: selected.slice(0, MAX_OPERATION_EVIDENCE_IDS),
          recordRelation: 'command-target',
          fieldNames: [],
          truncated: selected.length > MAX_OPERATION_EVIDENCE_IDS,
        },
      };
    }
    case 'checkpoint': {
      const { check } = step;
      const checkId = scopedCheckId({
        base: check.checkId,
        sampleIndex: input.sampleIndex,
        samples: input.samples,
        repetitionIndex: input.repetitionIndex ?? 0,
        totalRepetitions: input.totalRepetitions ?? 1,
      });
      const base = {
        key: step.key,
        checkId,
        description: check.description,
        tolerance: null as unknown,
        obligationIds: check.obligationIds,
        field: null as string | null,
      };
      if (check.kind === 'full-recompute') {
        const outcome = await evaluateFullRecompute({
          loaded,
          teaPath: input.teaPath,
          tables: check.tables,
          maxRows: check.maxRows,
          checkId,
          description: check.description,
          obligationIds: check.obligationIds,
          reuse: check.reuse,
          reference: {
            key: `checkpoint:${input.stepIndex}:${step.key}`,
            store: input.fullRecomputeReferences,
          },
        });
        input.checkpointChecks.push({
          ...base,
          ...outcome,
          key: step.key,
          checkId,
          kind: 'full-recompute',
        });
        if (outcome.status === 'fail') input.failures.push(`checkpoint ${checkId} failed`);
        return { rowsRead: 0, rowsWritten: 0, rowsReturned: 0, processed: 0 };
      }
      if (check.kind === 'query-values') {
        const rows: Array<Record<string, unknown>> = [];
        for (const operation of check.operations) {
          const capture = input.queries.get(operation);
          if (!capture) {
            throw new BenchError(
              'bench.checkpoint.query_missing',
              `No query result recorded for operation ${operation}`
            );
          }
          rows.push(...capture.values);
        }
        const normalizeRow = (row: unknown) => canonicalJson(normalizeValue(row));
        const actualKeys = rows.map(normalizeRow);
        const expectedValues = Array.isArray(check.expected) ? check.expected : undefined;
        const expectedIsArray = expectedValues !== undefined;
        const expectedKeys = expectedValues === undefined ? [] : expectedValues.map(normalizeRow);
        const ordered = check.ordered === true;
        const matches =
          expectedIsArray &&
          actualKeys.length > 0 &&
          (ordered
            ? actualKeys.length === expectedKeys.length &&
              actualKeys.every((key, index) => key === expectedKeys[index])
            : canonicalJson([...actualKeys].sort()) === canonicalJson([...expectedKeys].sort()));
        const status = matches ? 'pass' : 'fail';
        input.checkpointChecks.push({
          ...base,
          kind: 'invariant',
          status,
          table: null,
          expected: check.expected,
          actual: rows,
          rowsMatched: rows.length,
          method: ordered ? 'exact-query-values-ordered' : 'exact-query-values-multiset',
          ...(status === 'pass'
            ? {}
            : {
                message:
                  rows.length === 0
                    ? 'Query-values checkpoint captured no rows'
                    : expectedIsArray
                      ? ordered
                        ? 'Query values differ from the expected sequence'
                        : 'Query values differ from the expected rows'
                      : 'Query-values checkpoint expected an array',
              }),
        });
        if (status === 'fail') input.failures.push(`checkpoint ${checkId} failed`);
        return { rowsRead: rows.length, rowsWritten: 0, rowsReturned: rows.length, processed: 0 };
      }
      if (check.kind === 'query-record-ids') {
        const ids: string[] = [];
        for (const operation of check.operations) {
          const capture = input.queries.get(operation);
          if (!capture) {
            throw new BenchError(
              'bench.checkpoint.query_missing',
              `No query result recorded for operation ${operation}`
            );
          }
          ids.push(...capture.ids);
        }
        const unique = new Set(ids);
        const duplicateCount = ids.length - unique.size;
        const totalMatches =
          check.expectedTotal === undefined || ids.length === check.expectedTotal;
        const tableIds = check.table
          ? new Set(
              (
                await readAllRecords({
                  loaded,
                  tableId: resolveTable(loaded.tables, check.table).id,
                })
              ).map((record) => record.id)
            )
          : undefined;
        const setMatches =
          tableIds === undefined ||
          (unique.size === tableIds.size && [...unique].every((id) => tableIds.has(id)));
        const status =
          ids.length > 0 && duplicateCount === 0 && totalMatches && setMatches ? 'pass' : 'fail';
        input.checkpointChecks.push({
          ...base,
          kind: 'invariant',
          status,
          table: null,
          expected: {
            total: check.expectedTotal ?? null,
            duplicates: 0,
            setSize: tableIds?.size ?? null,
          },
          actual: { total: ids.length, duplicates: duplicateCount, setSize: unique.size },
          rowsMatched: ids.length,
          method: checkpointMethod(check),
          ...(status === 'pass'
            ? {}
            : {
                message:
                  ids.length === 0
                    ? 'Query checkpoint collected no record ids'
                    : duplicateCount > 0
                      ? `Query results repeat ${duplicateCount} record id(s)`
                      : setMatches
                        ? `Expected ${check.expectedTotal ?? tableIds?.size} record ids, collected ${ids.length}`
                        : 'Query record ids do not match the table record set',
              }),
        });
        if (status === 'fail') input.failures.push(`checkpoint ${checkId} failed`);
        return { rowsRead: 0, rowsWritten: 0, rowsReturned: 0, processed: 0 };
      }
      const table = resolveTable(loaded.tables, check.table);
      if (check.kind === 'row-count') {
        const result = unwrap(
          await loaded.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
            context,
            unwrap(
              ListTableRecordsQuery.create({
                tableId: table.id,
                limit: 1,
                includeTotal: true,
                fieldKeyType: 'id',
              })
            )
          )
        );
        const status = result.total === check.expected ? 'pass' : 'fail';
        input.checkpointChecks.push({
          ...base,
          kind: 'invariant',
          status,
          table: table.name,
          expected: check.expected,
          actual: result.total,
          rowsMatched: result.total,
          method: checkpointMethod(check),
          ...(status === 'pass'
            ? {}
            : { message: `Expected ${check.expected} rows, counted ${result.total}` }),
        });
        if (status === 'fail') input.failures.push(`checkpoint ${checkId} failed`);
        return { rowsRead: result.total, rowsWritten: 0, rowsReturned: 0, processed: 0 };
      }
      const field = check.field === undefined ? undefined : resolveField(table, check.field);
      const rows = await readAllRecords({ loaded, tableId: table.id });
      const orderByValue = (values: ReadonlyArray<unknown>) =>
        [...values].sort((left, right) =>
          canonicalJson(normalizeValue(left)).localeCompare(canonicalJson(normalizeValue(right)))
        );
      const actual = orderByValue(
        rows.map((record) =>
          normalizeValue(field === undefined ? record.fields : (record.fields[field.id] ?? null))
        )
      );
      const rowsMatched = rows.length;
      const expectedValues = Array.isArray(check.expected) ? check.expected : undefined;
      const status =
        expectedValues !== undefined &&
        rowsMatched > 0 &&
        canonicalJson(actual) === canonicalJson(orderByValue(expectedValues.map(normalizeValue)))
          ? 'pass'
          : 'fail';
      input.checkpointChecks.push({
        ...base,
        kind: 'invariant',
        status,
        table: table.name,
        field: field?.name ?? null,
        expected: check.expected,
        actual,
        rowsMatched,
        method: checkpointMethod(check),
        ...(status === 'pass'
          ? {}
          : {
              message:
                rowsMatched === 0
                  ? 'Field-value checkpoint matched no rows'
                  : expectedValues !== undefined
                    ? 'Field values differ from the expected array'
                    : 'Field-value checkpoint expected an array',
            }),
      });
      if (status === 'fail') input.failures.push(`checkpoint ${checkId} failed`);
      return { rowsRead: rowsMatched, rowsWritten: 0, rowsReturned: rowsMatched, processed: 0 };
    }
    case 'expect-error': {
      const unchanged = step.unchanged;
      const table = unchanged ? resolveTable(loaded.tables, unchanged.table) : undefined;
      const field = unchanged && table ? resolveField(table, unchanged.field) : undefined;
      const before =
        table && field && unchanged
          ? await snapshotSelectedValues({
              loaded,
              tableId: table.id,
              fieldId: field.id,
              rows: unchanged.rows,
            })
          : undefined;
      const selectedRecordIds = before?.map((row) => row.id) ?? [];
      // The nested step shares the wrapper key so cursor state stays under the declared
      // operation, and a successful failure injection is never reported as a write.
      const nested = { ...step.step, key: step.key } as BenchWorkloadStep;
      let caught: unknown;
      let succeeded = false;
      const requestStarted = performance.now();
      try {
        await executeStep({ ...input, step: nested, measurement: makeMutableMeasurement(nested) });
        succeeded = true;
      } catch (error) {
        caught = error;
      }
      const measuredDurationMs = performance.now() - requestStarted;
      const after =
        table && field && unchanged
          ? await snapshotSelectedValuesByIds({
              loaded,
              tableId: table.id,
              fieldId: field.id,
              selectedRecordIds,
            })
          : undefined;
      const stateUnchanged =
        before !== undefined && after !== undefined
          ? selectedValuesAreUnchanged(before, after)
          : undefined;
      const code =
        typeof caught === 'object' &&
        caught !== null &&
        'code' in caught &&
        typeof caught.code === 'string'
          ? caught.code
          : null;
      const matched =
        !succeeded &&
        code === step.expectedCode &&
        (stateUnchanged === undefined || stateUnchanged);
      const reason = succeeded
        ? `Expected ${step.expectedCode} but the step succeeded`
        : code !== step.expectedCode
          ? `Expected error ${step.expectedCode} but got ${code ?? 'no structured code'}`
          : stateUnchanged === false
            ? `Expected error ${step.expectedCode} still changed the selected values`
            : undefined;
      input.checkpointChecks.push({
        key: step.key,
        checkId: scopedCheckId({
          base: step.checkId ?? `${step.key}/expect-error`,
          sampleIndex: input.sampleIndex,
          samples: input.samples,
          repetitionIndex: input.repetitionIndex ?? 0,
          totalRepetitions: input.totalRepetitions ?? 1,
        }),
        kind: 'invariant',
        status: matched ? 'pass' : 'fail',
        description: step.description ?? `Expected ${step.expectedCode} without a state change`,
        table: table?.name ?? null,
        field: field?.name ?? null,
        expected: { code: step.expectedCode, unchanged: before ? canonicalJson(before) : null },
        actual: { code, unchanged: after ? canonicalJson(after) : null },
        tolerance: null,
        obligationIds: step.obligationIds ?? [],
        rowsMatched: before?.length ?? 0,
        method: 'expected-domain-error-and-unchanged-state',
        ...(reason === undefined ? {} : { message: reason }),
      });
      if (reason !== undefined) {
        input.failures.push(`${step.key}: ${reason}`);
        input.measurement.errors += 1;
      }
      return { rowsRead: 0, rowsWritten: 0, rowsReturned: 0, processed: 0, measuredDurationMs };
    }
    case 'flush-computed':
      return {
        rowsRead: 0,
        rowsWritten: 0,
        rowsReturned: 0,
        processed: (await loaded.runtime.flushComputed()).processed,
        observation: {
          recordIds: [],
          recordRelation: 'none',
          fieldNames: [],
          truncated: false,
        },
      };
  }
};

const initialRecords = (loaded: LoadedCase): Map<string, ExecutionRecord[]> => {
  const records = new Map<string, ExecutionRecord[]>();
  for (const table of loaded.tables.values()) {
    const tableRecords =
      loaded.recordsByTable.get(table.name) ?? loaded.recordsByTable.get(table.id) ?? [];
    records.set(table.id, [...tableRecords]);
  }
  return records;
};

function standalonePerformanceVerdict(
  operations: ReadonlyArray<BenchOperationMeasurement>,
  sloP95Ms: number | null | undefined,
  samples: number
): 'pass' | 'fail' | 'inconclusive' | 'not-compared' {
  if (samples < minimumSamplesForPercentileResolution(0.95)) return 'inconclusive';
  if (sloP95Ms == null) return 'not-compared';
  if (
    operations.length === 0 ||
    operations.some((operation) => operation.p95Ms === null || operation.errors > 0)
  )
    return 'inconclusive';
  return operations.some((operation) => operation.p95Ms !== null && operation.p95Ms > sloP95Ms)
    ? 'fail'
    : 'pass';
}

const validateDeleteCapacity = (input: { manifest: BenchCaseManifest }): void => {
  const remaining = new Map<string, number>(Object.entries(input.manifest.dataset.rows));
  const mutations = input.manifest.workload.flatMap((step) =>
    step.kind === 'write-create' || step.kind === 'write-delete' ? [step] : []
  );
  for (const step of mutations) {
    const current = remaining.get(step.table) ?? 0;
    if (step.kind === 'write-create') {
      remaining.set(step.table, current + step.rows);
      continue;
    }
    if (step.rows > current) {
      throw new BenchError(
        'bench.workload.delete_rows_exhausted',
        `Delete ${step.key} needs ${step.rows} rows in one fresh sample but only ${current} remain`
      );
    }
    remaining.set(step.table, current - step.rows);
  }
};

/**
 * One complete ordered workload pass on one freshly loaded case, followed by its final oracle.
 * Measured samples pass their shared `measurements` map and accumulate timings and row counters;
 * warmup passes omit it, so nothing they run can reach a measured sample.
 */
const runWorkloadPass = async (input: {
  loaded: LoadedCase;
  manifest: BenchCaseManifest;
  teaPath: string;
  samples: number;
  sampleIndex: number;
  repetitionIndex: number;
  totalRepetitions: number;
  /** Scope label used when a step fails: `<step>#<errorScope>: <reason>`. */
  errorScope: string;
  measurements?: Map<string, MutableMeasurement>;
  fullRecomputeReferences: FullRecomputeReferenceStore;
}): Promise<{
  readonly failures: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
  readonly oracle: BenchOracleResult;
  readonly measureDurationMs: number;
  readonly oracleDurationMs: number;
}> => {
  const { loaded, manifest } = input;
  const checkpointChecks: BenchOracleCheckReceipt[] = [];
  const failures: string[] = [];
  const errors: string[] = [];
  const queries = new Map<string, QueryCapture>();
  const recordsByTable = initialRecords(loaded);
  const preparedCreates = prepareCreateRows({ manifest, tables: loaded.tables });
  const structuredHarness = createDataQueryHarness({
    runtime: loaded.runtime,
    actorId: manifest.run.actorId,
  });

  const measureStarted = performance.now();
  for (let stepIndex = 0; stepIndex < manifest.workload.length; stepIndex += 1) {
    const step = manifest.workload[stepIndex]!;
    const correctnessOnly = step.kind === 'checkpoint';
    const measurement = input.measurements?.get(step.key) ?? makeMutableMeasurement(step);
    const started = performance.now();
    try {
      const counts = await executeStep({
        loaded,
        manifest,
        step,
        stepIndex,
        sampleIndex: input.sampleIndex,
        repetitionIndex: input.repetitionIndex,
        totalRepetitions: input.totalRepetitions,
        stateIndex: 0,
        measurement,
        preparedCreates,
        recordsByTable,
        structuredHarness,
        teaPath: input.teaPath,
        samples: input.samples,
        checkpointChecks,
        queries,
        failures,
        fullRecomputeReferences: input.fullRecomputeReferences,
      });
      if (!input.measurements || correctnessOnly) continue;
      measurement.samplesMs.push(counts.measuredDurationMs ?? performance.now() - started);
      measurement.rowsRead += counts.rowsRead;
      measurement.rowsWritten += counts.rowsWritten;
      measurement.rowsReturned += counts.rowsReturned;
      measurement.processed += counts.processed;
      if (counts.observation) mergeObservation(measurement.observation, counts.observation);
    } catch (error) {
      measurement.errors += 1;
      errors.push(`${step.key}#${input.errorScope}: ${errorMessage(error)}`);
      break;
    }
  }
  const measureDurationMs = performance.now() - measureStarted;

  const oracleStarted = performance.now();
  let oracle: BenchOracleResult;
  try {
    oracle = await runOracles({
      loaded,
      teaPath: input.teaPath,
      fullRecomputeReferences: input.fullRecomputeReferences,
      scopeCheckId: (base) =>
        scopedCheckId({
          base,
          sampleIndex: input.sampleIndex,
          samples: input.samples,
          repetitionIndex: input.repetitionIndex,
          totalRepetitions: input.totalRepetitions,
        }),
    });
  } catch (error) {
    errors.push(errorMessage(error));
    oracle = emptyOracleResult('bench.oracle.execution_failed');
  }
  return {
    failures,
    errors,
    oracle: mergeInlineChecks(oracle, checkpointChecks),
    measureDurationMs,
    oracleDurationMs: performance.now() - oracleStarted,
  };
};

const runRepetition = async (input: {
  index: number;
  teaPath: string;
  manifestPath: string;
  manifest: BenchCaseManifest;
  backend: 'pglite' | 'postgres';
  connectionString?: string;
  samples: number;
  totalRepetitions: number;
  warmup: number;
}): Promise<
  BenchRepetitionReport & { complexity: LoadedCase['complexity']; pgVersion?: string }
> => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const phases: Array<{
    kind: 'warmup' | 'sample-setup' | 'measure' | 'oracle';
    durationMs: number;
    sampleIndex?: number;
  }> = [];
  let setup: LoadedCase['setup'] | undefined;
  let complexity: LoadedCase['complexity'] | undefined;
  let pgVersion: string | undefined;
  const measurements = new Map<string, MutableMeasurement>(
    input.manifest.workload
      .filter((step) => step.kind !== 'checkpoint')
      .map((step) => [step.key, makeMutableMeasurement(step)])
  );
  const sampleOracles: BenchOracleResult[] = [];
  const fullRecomputeReferences: FullRecomputeReferenceStore = new Map();
  if (input.warmup > 0) {
    const warmupStarted = performance.now();
    for (let warmupPass = 0; warmupPass < input.warmup; warmupPass += 1) {
      let warmupCase: LoadedCase | undefined;
      try {
        warmupCase = await loadCase({
          teaPath: input.teaPath,
          manifest: input.manifest,
          backendOverride: input.backend,
          manifestDir: dirname(resolve(input.manifestPath)),
          connectionString: input.connectionString,
        });
        // A warmup pass must look exactly like a measured sample: complete ordered workload,
        // mutations, checkpoints and the final oracle on a fresh disposable fixture. Its
        // reference cache and receipts are dropped, so measured samples keep a full first
        // reference and accumulate nothing from warmup.
        const pass = await runWorkloadPass({
          loaded: warmupCase,
          manifest: input.manifest,
          teaPath: input.teaPath,
          samples: input.samples,
          sampleIndex: 0,
          repetitionIndex: input.index,
          totalRepetitions: input.totalRepetitions,
          errorScope: `warmup-${warmupPass}`,
          fullRecomputeReferences: new Map(),
        });
        errors.push(...pass.errors);
        errors.push(...pass.failures.map((failure) => `warmup-${warmupPass}: ${failure}`));
        if (pass.oracle.status === 'fail') {
          errors.push(`warmup-${warmupPass}: final oracle failed`);
        }
      } catch (error) {
        errors.push(`warmup-${warmupPass}: ${errorMessage(error)}`);
      } finally {
        if (warmupCase) {
          try {
            await warmupCase.close();
          } catch (error) {
            errors.push(`warmup-${warmupPass}: ${errorMessage(error)}`);
          }
        }
      }
    }
    phases.push({ kind: 'warmup', durationMs: performance.now() - warmupStarted });
  }

  for (let sampleIndex = 0; sampleIndex < input.samples; sampleIndex += 1) {
    let loaded: LoadedCase | undefined;
    try {
      const setupStarted = performance.now();
      loaded = await loadCase({
        teaPath: input.teaPath,
        manifest: input.manifest,
        backendOverride: input.backend,
        manifestDir: dirname(resolve(input.manifestPath)),
        connectionString: input.connectionString,
      });
      phases.push({
        kind: 'sample-setup',
        sampleIndex,
        durationMs: performance.now() - setupStarted,
      });
      setup ??= loaded.setup;
      complexity ??= loaded.complexity;
      pgVersion ??= loaded.environment.pgVersion;
      const pass = await runWorkloadPass({
        loaded,
        manifest: input.manifest,
        teaPath: input.teaPath,
        samples: input.samples,
        sampleIndex,
        repetitionIndex: input.index,
        totalRepetitions: input.totalRepetitions,
        errorScope: `sample-${sampleIndex}`,
        measurements,
        fullRecomputeReferences,
      });
      phases.push({ kind: 'measure', sampleIndex, durationMs: pass.measureDurationMs });
      sampleOracles.push(pass.oracle);
      errors.push(...pass.errors);
      errors.push(...pass.failures);
      phases.push({ kind: 'oracle', sampleIndex, durationMs: pass.oracleDurationMs });
    } catch (error) {
      errors.push(errorMessage(error));
    } finally {
      if (loaded) {
        try {
          await loaded.close();
        } catch (error) {
          errors.push(errorMessage(error));
        }
      }
    }
  }

  if (!setup || !complexity) throw new BenchError('bench.run.setup_failed', errors.join('; '));
  const operations = [...measurements.values()].map(finalizeMeasurement);
  const oracle = mergeOracles(sampleOracles);
  if (input.samples < minimumSamplesForPercentileResolution(0.95)) {
    addWarning(warnings, 'bench.workload.percentile_evidence_low');
  }
  for (const operation of operations)
    for (const warning of operation.warnings) addWarning(warnings, warning);
  const performanceVerdict = standalonePerformanceVerdict(
    operations,
    input.manifest.budgets?.sloP95Ms,
    input.samples
  );
  const verdict =
    errors.length > 0 || oracle.status === 'fail'
      ? 'fail'
      : oracle.status === 'not-run'
        ? 'inconclusive'
        : 'pass';
  return {
    index: input.index,
    setup,
    phases,
    operations,
    oracle,
    verdict,
    performanceVerdict,
    errors,
    warnings,
    complexity,
    pgVersion,
  };
};

const mergeOperations = (
  workload: ReadonlyArray<BenchWorkloadStep>,
  repetitions: ReadonlyArray<BenchRepetitionReport>
): ReadonlyArray<BenchOperationMeasurement> => {
  const merged = new Map<string, MutableMeasurement>();
  for (const repetition of repetitions) {
    for (const operation of repetition.operations) {
      const target = merged.get(operation.key) ?? {
        key: operation.key,
        kind: operation.kind,
        samplesMs: [],
        rowsRead: 0,
        rowsWritten: 0,
        rowsReturned: 0,
        processed: 0,
        errors: 0,
        warnings: [],
        observation: { recordIds: [], recordRelation: 'none', fieldNames: [], truncated: false },
      };
      target.samplesMs.push(...operation.samplesMs);
      target.rowsRead += operation.rowsRead;
      target.rowsWritten += operation.rowsWritten;
      target.rowsReturned += operation.rowsReturned;
      target.processed += operation.processed;
      target.errors += operation.errors;
      if (operation.observation) mergeObservation(target.observation, operation.observation);
      for (const warning of operation.warnings) {
        if (
          !warning.startsWith('bench.metrics.p95_unresolved:') &&
          !warning.startsWith('bench.metrics.p99_unresolved:')
        ) {
          addWarning(target.warnings, warning);
        }
      }
      merged.set(operation.key, target);
    }
  }
  return workload.flatMap((step) => {
    const measurement = merged.get(step.key);
    return measurement ? [finalizeMeasurement(measurement)] : [];
  });
};

const mergeOracles = (results: ReadonlyArray<BenchOracleResult>): BenchOracleResult => ({
  status: results.some((result) => result.status === 'fail')
    ? 'fail'
    : results.some((result) => result.status === 'not-run')
      ? 'not-run'
      : 'pass',
  checks: results.flatMap((result) => result.checks),
  warnings: [...new Set(results.flatMap((result) => result.warnings))],
});

/**
 * Checkpoints are evaluated at their position in the workload, so their receipts join the
 * final oracle instead of replacing it. A failing checkpoint can never be hidden by a later
 * pass, and running only checkpoints (no configured oracle) still yields a verdict.
 */
const mergeInlineChecks = (
  result: BenchOracleResult,
  inline: ReadonlyArray<BenchOracleCheckReceipt>
): BenchOracleResult => {
  if (inline.length === 0) return result;
  const checks = [...result.checks, ...inline];
  const status = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.some((check) => check.status === 'unknown')
      ? 'not-run'
      : result.checks.length === 0
        ? 'pass'
        : result.status;
  return { status, checks, warnings: result.warnings };
};

const resolveCommit = (): string => {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

export async function runCase(input: {
  teaPath: string;
  manifestPath: string;
  backendOverride?: 'pglite' | 'postgres';
  connectionString?: string;
  samples?: number;
  warmup?: number;
  repetitions?: number;
}): Promise<BenchRunReport> {
  const manifest = parseBenchCaseManifest(
    JSON.parse(await readFile(input.manifestPath, 'utf8')) as unknown
  );
  const backend = input.backendOverride ?? manifest.run.backend;
  const samples = input.samples ?? manifest.run.samples;
  const warmup = input.warmup ?? manifest.run.warmup;
  const repetitionsCount = input.repetitions ?? manifest.run.repetitions;
  if (!Number.isInteger(samples) || samples <= 0) {
    throw new BenchError('bench.run.samples_invalid', 'samples must be a positive integer');
  }
  if (!Number.isInteger(warmup) || warmup < 0) {
    throw new BenchError('bench.run.warmup_invalid', 'warmup must be a non-negative integer');
  }
  if (!Number.isInteger(repetitionsCount) || repetitionsCount <= 0) {
    throw new BenchError('bench.run.repetitions_invalid', 'repetitions must be a positive integer');
  }

  validateDeleteCapacity({ manifest });

  const startedAt = new Date().toISOString();
  const commit = resolveCommit();
  const runId = sha256Hex(
    manifest.caseId + commit + backend + startedAt + canonicalJson(manifest.dataset.seed)
  );
  const internalRepetitions: Array<
    BenchRepetitionReport & { complexity: LoadedCase['complexity']; pgVersion?: string }
  > = [];
  for (let index = 0; index < repetitionsCount; index += 1) {
    internalRepetitions.push(
      await runRepetition({
        index,
        teaPath: input.teaPath,
        manifestPath: input.manifestPath,
        manifest,
        backend,
        connectionString: input.connectionString,
        samples,
        totalRepetitions: repetitionsCount,
        warmup,
      })
    );
  }

  const repetitions: BenchRepetitionReport[] = internalRepetitions.map((repetition) => ({
    index: repetition.index,
    setup: repetition.setup,
    phases: repetition.phases,
    operations: repetition.operations,
    oracle: repetition.oracle,
    verdict: repetition.verdict,
    performanceVerdict: repetition.performanceVerdict,
    errors: repetition.errors,
    warnings: repetition.warnings,
  }));
  const operations = mergeOperations(manifest.workload, repetitions);
  const oracle = mergeOracles(repetitions.map((repetition) => repetition.oracle));
  const errors = repetitions.flatMap((repetition) => repetition.errors);
  const warnings = [...new Set(repetitions.flatMap((repetition) => repetition.warnings))];
  if (!warnings.includes('bench.computation.hybrid_inline_and_flush')) {
    warnings.push('bench.computation.hybrid_inline_and_flush');
  }
  const performance = manifest.budgets?.performance
    ? evaluatePerformancePolicy({ operations, policy: manifest.budgets.performance })
    : undefined;
  const performanceVerdict =
    performance?.verdict ??
    standalonePerformanceVerdict(
      operations,
      manifest.budgets?.sloP95Ms,
      samples * repetitionsCount
    );
  const verdict = repetitions.some((repetition) => repetition.verdict === 'fail')
    ? 'fail'
    : repetitions.some((repetition) => repetition.verdict === 'inconclusive')
      ? 'inconclusive'
      : 'pass';

  const bunVersion = process.versions.bun;
  return {
    runId,
    caseId: manifest.caseId,
    specVersion: manifest.specVersion,
    measurementProtocol: BENCH_MEASUREMENT_PROTOCOL,
    generatorVersion: manifest.generatorVersion,
    seed: manifest.dataset.seed,
    warmup,
    samples,
    title: manifest.title,
    dimensions: manifest.dimensions,
    links: manifest.links,
    backend,
    commit,
    startedAt,
    completedAt: new Date().toISOString(),
    manifestPath: input.manifestPath,
    teaPath: input.teaPath,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      runtime: bunVersion ? `bun ${bunVersion}` : `node ${process.version}`,
      computationMode: 'hybrid-inline-and-flush',
      pgVersion: internalRepetitions.find((repetition) => repetition.pgVersion)?.pgVersion,
    },
    complexity: internalRepetitions[0]!.complexity,
    budgets: manifest.budgets,
    repetitions,
    operations,
    oracle,
    verdict,
    correctnessVerdict: verdict,
    ...(performance ? { performance } : {}),
    performanceVerdict,
    errors,
    warnings: [...new Set([...warnings, ...(performance?.warnings ?? [])])],
  };
}
