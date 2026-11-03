import { readFile } from 'node:fs/promises';

import { schemaFromDotTeaStructure } from '@teable/v2-complexity';

import { canonicalJson } from '../case/canonicalJson';
import {
  applyLinks,
  createBaseAndImport,
  createRecordsWithoutLinks,
  createRuntimeForBackend,
  resolveTables,
} from '../case/loadSteps';
import { closeBenchRuntime } from '../case/runtimeLifecycle';
import { getLoadedCaseExecutionContext } from '../case/TeaCaseLoader';
import type { LoadedCase, ResolvedField, ResolvedTable } from '../case/types';
import { BenchError } from '../errors';
import { readTeaArchive } from '../tea/teaZip';

import { normalizeValue } from './normalize';
import { listAllRecords, tableRowCount } from './paging';
import type { BenchOracleResult } from './types';

type CheckOutcome = Omit<BenchOracleResult['checks'][number], 'key' | 'kind'>;
type FullRecomputeReference = {
  readonly state: string;
  readonly referenceCheckId: string;
  readonly comparedRows: number;
  readonly comparedFields: number;
};

export type FullRecomputeReferenceStore = Map<string, FullRecomputeReference>;

type DumpedRow = {
  readonly oldId: string;
  readonly fields: Readonly<Record<string, unknown>>;
  /** Link targets are source-runtime record IDs, never primary values. */
  readonly links: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly linkShapes: Readonly<Record<string, string>>;
  readonly fieldPresence: Readonly<Record<string, boolean>>;
};

type DumpedTable = {
  readonly table: ResolvedTable;
  readonly rows: ReadonlyArray<DumpedRow>;
};

const resolveTable = (loaded: LoadedCase, nameOrId: string): ResolvedTable => {
  const direct = loaded.tables.get(nameOrId);
  if (direct) {
    return direct;
  }
  const matches = [...loaded.tables.values()].filter(
    (table) => table.id === nameOrId || table.declaredId === nameOrId || table.name === nameOrId
  );
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new BenchError('bench.table.ambiguous', `Ambiguous table ${nameOrId}`);
  }
  throw new BenchError('bench.table.unknown', `Unknown table ${nameOrId}`);
};

const primaryField = (table: ResolvedTable): ResolvedField => {
  for (const field of table.fields.values()) {
    if (field.isPrimary || field.name === table.primaryFieldName) {
      return field;
    }
  }
  throw new BenchError(
    'bench.oracle.primary_field_missing',
    `Table ${table.name} has no primary field`
  );
};

const extractLinkIds = (value: unknown): ReadonlyArray<string> => {
  if (value === null || value === undefined) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => {
    if (typeof entry === 'string') {
      return entry;
    }
    if (typeof entry === 'object' && entry !== null && 'id' in entry) {
      const id = entry.id;
      if (typeof id === 'string') {
        return id;
      }
    }
    throw new BenchError(
      'bench.link.target_missing',
      `Invalid stored link value ${canonicalJson(entry)}`
    );
  });
};
const storedLinkShape = (value: unknown, present: boolean): string => {
  if (!present) return 'missing';
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : 'single';
};

const dumpFinalState = async (input: {
  loaded: LoadedCase;
  tables: ReadonlyArray<ResolvedTable>;
  actorId: string;
}): Promise<ReadonlyMap<string, DumpedTable>> => {
  const recordsByTable = new Map<string, ReadonlyArray<Record<string, unknown>>>();
  const recordIdsByTable = new Map<string, ReadonlySet<string>>();
  for (const table of input.tables) {
    const records = await listAllRecords({
      runtime: input.loaded.runtime,
      actorId: input.actorId,
      tableId: table.id,
    });
    recordsByTable.set(table.name, records);
    recordIdsByTable.set(table.name, new Set(records.map((record) => String(record.id))));
  }

  const dumped = new Map<string, DumpedTable>();
  for (const table of input.tables) {
    const rows = (recordsByTable.get(table.name) ?? []).map((record): DumpedRow => {
      const source = record.fields as Record<string, unknown>;
      const fields: Record<string, unknown> = {};
      const links: Record<string, ReadonlyArray<string>> = {};
      const linkShapes: Record<string, string> = {};
      const fieldPresence: Record<string, boolean> = {};

      for (const field of table.fields.values()) {
        if (field.link) {
          linkShapes[field.name] = storedLinkShape(
            source[field.id],
            Object.hasOwn(source, field.id)
          );
          const targetIds = recordIdsByTable.get(field.link.table);
          if (!targetIds) {
            throw new BenchError(
              'bench.link.target_missing',
              `Link target table ${field.link.table} referenced by ${table.name}.${field.name} is missing`
            );
          }
          links[field.name] = extractLinkIds(source[field.id]).map((oldTargetId) => {
            if (!targetIds.has(oldTargetId)) {
              throw new BenchError(
                'bench.link.target_missing',
                `Link target ${oldTargetId} referenced by ${table.name}.${field.name} is missing`
              );
            }
            return oldTargetId;
          });
          continue;
        }
        if (!field.isComputed) {
          fields[field.name] = source[field.id];
          fieldPresence[field.name] = Object.hasOwn(source, field.id);
        }
      }

      return {
        oldId: String(record.id),
        fields,
        links,
        linkShapes,
        fieldPresence,
      };
    });

    dumped.set(table.name, {
      table,
      rows: [...rows].sort((left, right) => left.oldId.localeCompare(right.oldId)),
    });
  }

  return dumped;
};

const externalLinkTargets = (
  table: ResolvedTable,
  tables: ReadonlyMap<string, DumpedTable>
): ReadonlyArray<string> =>
  [...table.fields.values()]
    .filter(
      (field) => field.link && field.link.table !== table.name && !tables.has(field.link.table)
    )
    .map((field) => field.link!.table);

const dependencyOrder = (dumped: ReadonlyMap<string, DumpedTable>): ReadonlyArray<string> => {
  const result: string[] = [];
  const remaining = new Set(dumped.keys());

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((tableName) => {
        const table = dumped.get(tableName)!.table;
        const missingTargets = externalLinkTargets(table, dumped);
        if (missingTargets.length > 0) {
          throw new BenchError(
            'bench.link.target_missing',
            `Link targets are outside full recompute scope: ${missingTargets.join(', ')}`
          );
        }
        return [...table.fields.values()].every(
          (field) =>
            !field.link || field.link.table === tableName || !remaining.has(field.link.table)
        );
      })
      .sort();
    const next = ready[0] ?? [...remaining].sort()[0]!;
    remaining.delete(next);
    result.push(next);
  }

  return result;
};

const recomputableFieldTypes: Readonly<Record<string, true>> = {
  formula: true,
  lookup: true,
  rollup: true,
  conditionalLookup: true,
  conditionalRollup: true,
};

const computedSnapshot = async (input: {
  loaded: Pick<LoadedCase, 'runtime' | 'tables'>;
  tableNames: ReadonlyArray<string>;
  actorId: string;
  /** Maps runtime record IDs to stable source-runtime IDs. */
  stableRecordIds?: ReadonlyMap<string, ReadonlyMap<string, string>>;
}): Promise<Readonly<Record<string, unknown>>> => {
  const snapshot: Record<string, unknown> = {};
  for (const tableName of input.tableNames) {
    const table = input.loaded.tables.get(tableName);
    if (!table) {
      throw new BenchError('bench.table.unknown', `Unknown table ${tableName}`);
    }
    snapshot[tableName] = await snapshotComputedTable({
      loaded: input.loaded,
      table,
      actorId: input.actorId,
      aliases: input.stableRecordIds?.get(tableName),
      requireAliases: Boolean(input.stableRecordIds),
    });
  }
  return snapshot;
};

const snapshotComputedTable = async (input: {
  loaded: Pick<LoadedCase, 'runtime'>;
  table: ResolvedTable;
  actorId: string;
  aliases: ReadonlyMap<string, string> | undefined;
  requireAliases: boolean;
}): Promise<Readonly<Record<string, unknown>>> => {
  const { table } = input;
  if (input.requireAliases && !input.aliases) {
    throw new BenchError(
      'bench.oracle.record_mapping_missing',
      `Stable record mapping is missing for ${table.name}`
    );
  }
  const primary = primaryField(table);
  const computed = [...table.fields.values()].filter(
    (field) => field.isComputed && recomputableFieldTypes[field.type]
  );
  const rows = await listAllRecords({
    runtime: input.loaded.runtime,
    actorId: input.actorId,
    tableId: table.id,
    projection: [primary.id, ...computed.map((field) => field.id)],
  });
  const tableSnapshot: Record<string, unknown> = {};
  for (const record of rows) {
    const runtimeId = String(record.id);
    if (input.aliases && !input.aliases.has(runtimeId)) {
      throw new BenchError(
        'bench.oracle.record_mapping_missing',
        `Stable record mapping is missing for ${table.name}.${runtimeId}`
      );
    }
    const fields = record.fields as Record<string, unknown>;
    const result: Record<string, unknown> = {
      [primary.name]: normalizeValue(fields[primary.id]),
    };
    for (const field of computed) {
      result[field.name] = normalizeValue(fields[field.id]);
    }
    tableSnapshot[input.aliases?.get(runtimeId) ?? runtimeId] = result;
  }
  return tableSnapshot;
};
const stableSourceRecordIds = (input: {
  loaded: LoadedCase;
  dumped: ReadonlyMap<string, DumpedTable>;
}): ReadonlyMap<string, ReadonlyMap<string, string>> => {
  const result = new Map<string, ReadonlyMap<string, string>>();
  for (const [tableName, table] of input.dumped) {
    const seeded = input.loaded.recordsByTable.get(tableName);
    if (!seeded || seeded.length !== table.rows.length) {
      throw new BenchError(
        'bench.oracle.record_mapping_missing',
        `Stable record mapping does not cover every row in ${tableName}`
      );
    }
    const dumpedIds = new Set(table.rows.map((row) => row.oldId));
    const aliases = new Map<string, string>();
    for (const [index, record] of seeded.entries()) {
      if (!dumpedIds.has(record.id) || aliases.has(record.id)) {
        throw new BenchError(
          'bench.oracle.record_mapping_missing',
          `Stable record mapping is invalid for ${tableName}.${record.id}`
        );
      }
      aliases.set(record.id, `row-${index}`);
    }
    result.set(tableName, aliases);
  }
  return result;
};

/** Exact typed input encoding: output tolerance must never weaken the input equivalence proof. */
const encodeReferenceInput = (value: unknown): unknown => {
  if (value === undefined) return ['undefined'];
  if (value === null) return ['null'];
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BenchError('bench.oracle.number_nonfinite', 'Reference input must be finite');
    }
    return ['number', Object.is(value, -0) ? '-0' : String(value)];
  }
  if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
  if (value instanceof Date) return ['date', value.toISOString()];
  if (Array.isArray(value)) {
    return [
      'array',
      Array.from({ length: value.length }, (_, index) =>
        Object.hasOwn(value, index) ? encodeReferenceInput(value[index]) : ['missing']
      ),
    ];
  }
  if (
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return [
      'object',
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, encodeReferenceInput(entry)]),
    ];
  }
  throw new BenchError('bench.oracle.input_unsupported', 'Unsupported reference input type');
};

const canonicalReferenceState = (input: {
  dumped: ReadonlyMap<string, DumpedTable>;
  stableRecordIds: ReadonlyMap<string, ReadonlyMap<string, string>>;
  computed: Readonly<Record<string, unknown>>;
}): string => {
  const tables: Record<string, unknown> = {};
  for (const tableName of [...input.dumped.keys()].sort()) {
    const dumpedTable = input.dumped.get(tableName)!;
    const aliases = input.stableRecordIds.get(tableName);
    if (!aliases) {
      throw new BenchError(
        'bench.oracle.record_mapping_missing',
        `Stable record mapping is missing for ${tableName}`
      );
    }
    const rows: Record<string, unknown> = {};
    for (const row of dumpedTable.rows) {
      const alias = aliases.get(row.oldId);
      if (!alias) {
        throw new BenchError(
          'bench.oracle.record_mapping_missing',
          `Stable record mapping is missing for ${tableName}.${row.oldId}`
        );
      }
      const links: Record<string, unknown> = {};
      for (const [fieldName, targetIds] of Object.entries(row.links)) {
        const targetTableName = dumpedTable.table.fields.get(fieldName)?.link?.table;
        const targetAliases = targetTableName
          ? input.stableRecordIds.get(targetTableName)
          : undefined;
        if (!targetTableName || !targetAliases) {
          throw new BenchError(
            'bench.oracle.record_mapping_missing',
            `Stable link mapping is missing for ${tableName}.${fieldName}`
          );
        }
        links[fieldName] = targetIds.map((targetId) => {
          const targetAlias = targetAliases.get(targetId);
          if (!targetAlias) {
            throw new BenchError(
              'bench.oracle.record_mapping_missing',
              `Stable link mapping is missing for ${targetTableName}.${targetId}`
            );
          }
          return targetAlias;
        });
      }
      rows[alias] = {
        fields: row.fields,
        fieldPresence: row.fieldPresence,
        links,
        linkShapes: row.linkShapes,
      };
    }
    tables[tableName] = { rows };
  }
  return canonicalJson({ inputs: encodeReferenceInput(tables), computed: input.computed });
};

export async function evaluateFullRecompute(input: {
  loaded: LoadedCase;
  teaPath: string;
  tables: ReadonlyArray<string>;
  maxRows?: number;
  checkId: string;
  description?: string;
  obligationIds?: ReadonlyArray<string>;
  reuse?: 'identical-state';
  reference?: { readonly key: string; readonly store: FullRecomputeReferenceStore };
}): Promise<CheckOutcome> {
  const selectedTables = input.tables.map((name) => resolveTable(input.loaded, name));
  const execution = getLoadedCaseExecutionContext(input.loaded);
  const copiedTables = [...input.loaded.tables.values()];
  const totalRows = (
    await Promise.all(
      copiedTables.map((table) =>
        tableRowCount({
          runtime: input.loaded.runtime,
          actorId: execution.actorId,
          tableId: table.id,
        })
      )
    )
  ).reduce((sum, count) => sum + count, 0);

  const maxRows = input.maxRows ?? 10_000;
  if (totalRows > maxRows) {
    throw new BenchError(
      'bench.oracle.full_recompute_too_large',
      `Full recompute has ${totalRows} rows, exceeding ${maxRows}`
    );
  }

  const dumped = await dumpFinalState({
    loaded: input.loaded,
    tables: copiedTables,
    actorId: execution.actorId,
  });
  const orderedTableNames = dependencyOrder(dumped);
  const referenceContext = input.reuse === 'identical-state' ? input.reference : undefined;
  const sourceStableRecordIds = referenceContext
    ? stableSourceRecordIds({ loaded: input.loaded, dumped })
    : undefined;
  const source = await computedSnapshot({
    loaded: input.loaded,
    tableNames: selectedTables.map((table) => table.name),
    actorId: execution.actorId,
    stableRecordIds: sourceStableRecordIds,
  });
  const comparedRows = Object.values(source).reduce<number>(
    (sum, table) =>
      sum +
      (table !== null && typeof table === 'object' && !Array.isArray(table)
        ? Object.keys(table).length
        : 0),
    0
  );
  const comparedFields = selectedTables.reduce(
    (sum, table) =>
      sum +
      [...table.fields.values()].filter(
        (field) => field.isComputed && recomputableFieldTypes[field.type]
      ).length,
    0
  );
  const referenceState = sourceStableRecordIds
    ? canonicalReferenceState({ dumped, stableRecordIds: sourceStableRecordIds, computed: source })
    : undefined;
  const reference = referenceContext?.store.get(referenceContext.key);
  if (reference) {
    const matches = referenceState === reference.state;
    const metadata = {
      checkId: input.checkId,
      description: input.description ?? 'Compare stored state with a verified full recompute',
      table: selectedTables.map((table) => table.name).join(', ') || null,
      field: null,
      expected: { comparison: 'equal', referenceCheckId: reference.referenceCheckId },
      actual: { equal: matches },
      tolerance: null,
      obligationIds: input.obligationIds ?? [],
      rowsMatched: comparedRows,
      method: 'verified-reference-state-comparison',
      details: {
        referenceCheckId: reference.referenceCheckId,
        comparedSourceRows: totalRows,
        comparedRows,
        comparedFields,
        comparedTables: copiedTables.length,
        referenceComparedRows: reference.comparedRows,
        referenceComparedFields: reference.comparedFields,
      },
    };
    if (!matches) {
      return {
        ...metadata,
        status: 'fail',
        message:
          'Current inputs, relationships, or computed values differ from the verified reference',
      };
    }
    if (comparedRows === 0 && (input.obligationIds?.length ?? 0) > 0) {
      return {
        ...metadata,
        status: 'fail',
        message: 'Reference comparison covered zero rows; field obligations were not verified',
      };
    }
    return { ...metadata, status: 'pass' };
  }
  const teaBytes = await readFile(input.teaPath);
  const archive = readTeaArchive(teaBytes);
  const schemaProfile = schemaFromDotTeaStructure(archive.structure);
  const targetRuntime = await createRuntimeForBackend({
    backend: execution.backend.kind,
    connectionString: execution.backend.connectionString,
  });

  try {
    const imported = await createBaseAndImport({
      runtime: targetRuntime,
      baseName: `${input.loaded.manifest.title} full recompute`,
      teaBytes,
      actorId: execution.actorId,
    });
    const targetTables = await resolveTables({
      runtime: targetRuntime,
      baseId: imported.baseId,
      schemaProfile,
      actorId: execution.actorId,
    });
    const recordsByTable = new Map<string, ReadonlyArray<{ id: string; primary: unknown }>>();
    const stableRecordIds = new Map<string, ReadonlyMap<string, string>>();

    for (const tableName of orderedTableNames) {
      const table = targetTables.get(tableName);
      const sourceTable = dumped.get(tableName);
      if (!table || !sourceTable) {
        throw new BenchError('bench.table.unknown', `Imported table ${tableName} is missing`);
      }
      const created = await createRecordsWithoutLinks({
        runtime: targetRuntime,
        table,
        rows: sourceTable.rows.map((row) => row.fields),
        batchSize: input.loaded.manifest.run.seedBatchSize,
        actorId: execution.actorId,
      });
      if (created.length !== sourceTable.rows.length) {
        throw new BenchError(
          'bench.dataset.row_count_mismatch',
          `Recreated ${created.length} of ${sourceTable.rows.length} rows in ${tableName}`
        );
      }
      const targetToStable = new Map<string, string>();
      const identityRecords = created.map((record, index) => {
        const oldId = sourceTable.rows[index]!.oldId;
        const stableId = sourceStableRecordIds?.get(tableName)?.get(oldId) ?? oldId;
        targetToStable.set(record.id, stableId);
        return { id: record.id, primary: oldId };
      });
      recordsByTable.set(tableName, identityRecords);
      stableRecordIds.set(tableName, targetToStable);
    }

    for (const tableName of orderedTableNames) {
      const table = targetTables.get(tableName)!;
      const sourceTable = dumped.get(tableName)!;
      const links: Record<string, ReadonlyArray<ReadonlyArray<string>>> = {};
      for (const field of table.fields.values()) {
        if (field.link) {
          links[field.name] = sourceTable.rows.map((row) => row.links[field.name] ?? []);
        }
      }
      await applyLinks({
        runtime: targetRuntime,
        table,
        links,
        recordsByTable,
        batchSize: input.loaded.manifest.run.seedBatchSize,
        actorId: execution.actorId,
      });
    }

    await targetRuntime.flushComputed();
    const target = await computedSnapshot({
      loaded: { runtime: targetRuntime, tables: targetTables },
      tableNames: selectedTables.map((table) => table.name),
      actorId: execution.actorId,
      stableRecordIds,
    });

    const matches = canonicalJson(source) === canonicalJson(target);
    const metadata = {
      checkId: input.checkId,
      description: input.description ?? 'Rebuild stored state and compare computed values',
      table: selectedTables.map((table) => table.name).join(', ') || null,
      field: null,
      expected: { comparison: 'equal' },
      actual: { equal: matches },
      tolerance: null,
      obligationIds: input.obligationIds ?? [],
      rowsMatched: comparedRows,
      method: 'fresh-runtime-full-recompute',
      details: {
        copiedRows: totalRows,
        comparedRows,
        comparedFields,
        copiedTables: copiedTables.length,
        ...(referenceContext ? { establishedReference: true } : {}),
      },
    };
    if (!matches) {
      return {
        ...metadata,
        status: 'fail',
        message: 'Full recompute result differs from the source runtime',
      };
    }
    if (comparedRows === 0 && (input.obligationIds?.length ?? 0) > 0) {
      return {
        ...metadata,
        status: referenceContext ? 'fail' : 'unknown',
        message: 'Full recompute compared zero rows; field obligations were not verified',
      };
    }
    if (referenceContext && referenceState) {
      referenceContext.store.set(referenceContext.key, {
        state: referenceState,
        referenceCheckId: input.checkId,
        comparedRows,
        comparedFields,
      });
    }
    return { ...metadata, status: 'pass' };
  } finally {
    await closeBenchRuntime(targetRuntime);
  }
}
