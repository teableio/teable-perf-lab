import { BenchError } from '../errors';
import type { ResolvedField, ResolvedTable } from './types';

type JsonObject = Record<string, unknown>;

const fieldsOf = (table: ResolvedTable): ReadonlyArray<ResolvedField> => [...table.fields.values()];

const resolveField = (table: ResolvedTable, reference: string): string => {
  const fields = fieldsOf(table);
  const byName = fields.filter((field) => field.name === reference);
  if (byName.length > 1) {
    throw new BenchError(
      'bench.field.ambiguous',
      `field name ${reference} is ambiguous in table ${table.name}`
    );
  }
  if (byName.length === 1) return byName[0]!.id;

  const byDeclaredId = fields.filter((field) => field.declaredId === reference);
  if (byDeclaredId.length > 1) {
    throw new BenchError(
      'bench.field.ambiguous',
      `declared field id ${reference} is ambiguous in table ${table.name}`
    );
  }
  if (byDeclaredId.length === 1) return byDeclaredId[0]!.id;

  const byRuntimeId = fields.filter((field) => field.id === reference);
  if (byRuntimeId.length === 1) return byRuntimeId[0]!.id;

  throw new BenchError(
    'bench.field.unknown',
    `table ${table.name} has no field matching ${reference}`
  );
};

export function resolveRecordQuery(input: {
  table: ResolvedTable;
  filter?: unknown;
  sort?: ReadonlyArray<{ fieldId: string; order: 'asc' | 'desc' }>;
  groupBy?: ReadonlyArray<string>;
  projection?: ReadonlyArray<string>;
}): {
  filter?: unknown;
  sort?: ReadonlyArray<{ fieldId: string; order: 'asc' | 'desc' }>;
  groupBy?: ReadonlyArray<string>;
  projection?: ReadonlyArray<string>;
} {
  const walkFilter = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walkFilter);
    if (value === null || typeof value !== 'object') return value;

    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] =
        key === 'fieldId' && typeof child === 'string'
          ? resolveField(input.table, child)
          : walkFilter(child);
    }
    return result;
  };

  return {
    ...(input.filter === undefined ? {} : { filter: walkFilter(input.filter) }),
    ...(input.sort === undefined
      ? {}
      : {
          sort: input.sort.map((sort) => ({
            ...sort,
            fieldId: resolveField(input.table, sort.fieldId),
          })),
        }),
    ...(input.groupBy === undefined
      ? {}
      : { groupBy: input.groupBy.map((field) => resolveField(input.table, field)) }),
    ...(input.projection === undefined
      ? {}
      : { projection: input.projection.map((field) => resolveField(input.table, field)) }),
  };
}

export function resolveDataQueryDefinition(input: {
  definition: unknown;
  tables: ReadonlyMap<string, ResolvedTable>;
  fields: ReadonlyMap<string, ResolvedField>;
}): unknown {
  const tables = [...input.tables.values()];
  const fields = [...input.fields.values()];

  const resolveTable = (reference: string): string => {
    const byName = tables.filter((table) => table.name === reference);
    if (byName.length > 1) {
      throw new BenchError('bench.table.ambiguous', `table name ${reference} is ambiguous`);
    }
    if (byName.length === 1) return byName[0]!.id;

    const byDeclaredId = tables.filter((table) => table.declaredId === reference);
    if (byDeclaredId.length > 1) {
      throw new BenchError('bench.table.ambiguous', `declared table id ${reference} is ambiguous`);
    }
    if (byDeclaredId.length === 1) return byDeclaredId[0]!.id;

    const byRuntimeId = tables.filter((table) => table.id === reference);
    if (byRuntimeId.length === 1) return byRuntimeId[0]!.id;

    throw new BenchError('bench.table.unknown', `no table matches ${reference}`);
  };

  const resolveGlobalField = (reference: string): string => {
    const byName = fields.filter((field) => field.name === reference);
    if (byName.length > 1) {
      throw new BenchError('bench.field.ambiguous', `field name ${reference} is ambiguous`);
    }
    if (byName.length === 1) return byName[0]!.id;

    const byDeclaredId = fields.filter((field) => field.declaredId === reference);
    if (byDeclaredId.length > 1) {
      throw new BenchError('bench.field.ambiguous', `declared field id ${reference} is ambiguous`);
    }
    if (byDeclaredId.length === 1) return byDeclaredId[0]!.id;

    const byRuntimeId = fields.filter((field) => field.id === reference);
    if (byRuntimeId.length === 1) return byRuntimeId[0]!.id;

    throw new BenchError('bench.field.unknown', `no field matches ${reference}`);
  };

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;

    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'tableId' || key === 'foreignTableId') && typeof child === 'string') {
        result[key] = resolveTable(child);
      } else if (
        (key === 'fieldId' || key === 'linkFieldId' || key === 'lookupFieldId') &&
        typeof child === 'string'
      ) {
        result[key] = resolveGlobalField(child);
      } else {
        result[key] = walk(child);
      }
    }
    return result;
  };

  return walk(input.definition);
}
