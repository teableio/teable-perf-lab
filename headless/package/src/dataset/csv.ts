import type { ResolvedField, ResolvedTable } from '../case/types';
import { BenchError } from '../errors';
import type { CsvTable } from '../tea/csv';

export type ResolvedCsvTable = {
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly links: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>>;
};

const MULTI_VALUE_TYPES = new Set([
  'multipleSelect',
  'multipleUser',
  'link',
  'attachment',
  'multipleAttachment',
]);

const resolveFieldByHeader = (table: ResolvedTable, header: string): ResolvedField | undefined => {
  const fields = [...table.fields.values()];
  const byName = fields.filter((field) => field.name === header);
  if (byName.length > 1) {
    throw new BenchError(
      'bench.field.ambiguous',
      `header ${header} matches multiple field names in table ${table.name}`
    );
  }
  if (byName[0]) return byName[0];

  const byId = fields.filter((field) => field.declaredId === header || field.id === header);
  if (byId.length > 1) {
    throw new BenchError(
      'bench.field.ambiguous',
      `header ${header} matches multiple field ids in table ${table.name}`
    );
  }
  return byId[0];
};

const parseMultiValue = (field: ResolvedField, raw: string): ReadonlyArray<unknown> => {
  if (!raw.startsWith('[')) {
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BenchError(
      'bench.csv.json_invalid',
      `field ${field.name} has invalid JSON cell ${raw}`,
      error
    );
  }

  if (!Array.isArray(parsed)) {
    throw new BenchError(
      'bench.csv.json_invalid',
      `field ${field.name} JSON cell must be an array, received ${raw}`
    );
  }

  return parsed;
};

const parseUser = (field: ResolvedField, value: unknown): { readonly id: string } => {
  if (typeof value === 'string' && value.length > 0) return { id: value };
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'id' in value &&
    typeof value.id === 'string'
  ) {
    return { id: value.id };
  }
  throw new BenchError(
    'bench.csv.user_invalid',
    `field ${field.name} expects user ids or objects with a string id`
  );
};

const parseLinkTargets = (field: ResolvedField, raw: string): ReadonlyArray<string> =>
  parseMultiValue(field, raw).map((target) => {
    if (typeof target !== 'string') {
      throw new BenchError(
        'bench.csv.link_invalid',
        `field ${field.name} expects string target identifiers`
      );
    }
    return target;
  });

const parseJsonValue = (field: ResolvedField, raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new BenchError(
      'bench.csv.json_invalid',
      `field ${field.name} has invalid JSON cell ${raw}`,
      error
    );
  }
};

const parseCell = (field: ResolvedField, raw: string): unknown => {
  if (raw === '') return null;

  if (field.type === 'user') {
    if (!field.isMultiple) {
      return parseUser(field, raw.startsWith('{') ? parseJsonValue(field, raw) : raw);
    }
    return parseMultiValue(field, raw).map((value) => parseUser(field, value));
  }
  if (field.type === 'multipleUser') {
    return parseMultiValue(field, raw).map((value) => parseUser(field, value));
  }
  if (MULTI_VALUE_TYPES.has(field.type)) return parseMultiValue(field, raw);

  switch (field.type) {
    case 'number':
    case 'rating': {
      const value = Number(raw);
      if (Number.isNaN(value)) {
        throw new BenchError(
          'bench.csv.number_invalid',
          `field ${field.name} expects a number, received ${raw}`
        );
      }
      return value;
    }
    case 'checkbox':
      return raw === 'true' || raw === '1';
    default:
      return raw;
  }
};

export function resolveCsvTable(input: {
  tableName: string;
  table: ResolvedTable;
  csv: CsvTable;
}): ResolvedCsvTable {
  const { table, csv } = input;
  const resolvedFieldIds = new Set<string>();
  const columns = csv.header.map((header) => {
    const field = resolveFieldByHeader(table, header);
    if (!field) {
      throw new BenchError(
        'bench.csv.header_unknown',
        `table ${input.tableName} has no field matching CSV header ${header}`
      );
    }
    if (resolvedFieldIds.has(field.id)) {
      throw new BenchError(
        'bench.field.ambiguous',
        `CSV headers resolve to field ${field.name} more than once in table ${table.name}`
      );
    }
    resolvedFieldIds.add(field.id);
    return { field };
  });

  const rows: Record<string, unknown>[] = [];
  const mutableLinks: Record<string, Array<ReadonlyArray<string>>> = {};
  for (const { field } of columns) {
    if (field.type === 'link') mutableLinks[field.name] = [];
  }

  for (const row of csv.rows) {
    if (row.length !== csv.header.length) {
      throw new BenchError(
        'bench.csv.row_width_invalid',
        `table ${table.name} CSV row has ${row.length} cells; expected ${csv.header.length}`
      );
    }
    const values: Record<string, unknown> = {};

    columns.forEach(({ field }, columnIndex) => {
      const raw = row[columnIndex]!;
      if (field.type === 'link') {
        mutableLinks[field.name]!.push(raw === '' ? [] : parseLinkTargets(field, raw));
        return;
      }
      if (field.isComputed) return;
      values[field.name] = parseCell(field, raw);
    });

    rows.push(values);
  }

  return { rows, links: mutableLinks };
}
