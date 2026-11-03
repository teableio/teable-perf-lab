import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { canonicalJson } from '../case/canonicalJson';
import type { LoadedCase, ResolvedTable } from '../case/types';
import { BenchError } from '../errors';

import { normalizeRows } from './normalize';
import { listAllRecords } from './paging';
import type { BenchOracleResult } from './types';

type ExpectedTable = {
  readonly keys: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
};

type CheckOutcome = Omit<BenchOracleResult['checks'][number], 'key' | 'kind'>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const resolveFieldId = (table: ResolvedTable, nameOrId: string): string => {
  for (const field of table.fields.values()) {
    if (field.name === nameOrId || field.id === nameOrId || field.declaredId === nameOrId) {
      return field.id;
    }
  }
  throw new BenchError('bench.field.unknown', `Unknown field ${nameOrId} in table ${table.name}`);
};
const parseExpectedFile = (raw: unknown, path: string): Readonly<Record<string, ExpectedTable>> => {
  if (!isPlainObject(raw) || !isPlainObject(raw.tables)) {
    throw new BenchError('bench.oracle.expected_invalid', `Invalid expected JSON at ${path}`);
  }

  const tables: Record<string, ExpectedTable> = {};
  for (const [tableName, tableValue] of Object.entries(raw.tables)) {
    if (!isPlainObject(tableValue)) {
      throw new BenchError(
        'bench.oracle.expected_invalid',
        `Invalid expected table ${tableName} at ${path}`
      );
    }
    const { keys, rows } = tableValue;
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string') || keys.length === 0) {
      throw new BenchError(
        'bench.oracle.expected_invalid',
        `Expected keys for ${tableName} must be a non-empty string array`
      );
    }
    if (!Array.isArray(rows) || rows.some((row) => !isPlainObject(row))) {
      throw new BenchError(
        'bench.oracle.expected_invalid',
        `Expected rows for ${tableName} must be objects`
      );
    }
    tables[tableName] = {
      keys: [...keys] as ReadonlyArray<string>,
      rows: rows as ReadonlyArray<Record<string, unknown>>,
    };
  }

  return tables;
};
async function readExpectedTables(path: string): Promise<Readonly<Record<string, ExpectedTable>>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new BenchError('bench.oracle.expected_missing', `Expected JSON not found: ${path}`);
  }
  try {
    return parseExpectedFile(JSON.parse(text), path);
  } catch (error) {
    if (error instanceof BenchError) throw error;
    throw new BenchError('bench.oracle.expected_invalid', `Expected JSON is invalid: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function evaluateExpectedJson(input: {
  loaded: LoadedCase;
  manifestDir: string;
  path: string;
  checkId: string;
  description?: string;
  obligationIds?: ReadonlyArray<string>;
}): Promise<CheckOutcome> {
  const absolute = isAbsolute(input.path)
    ? input.path
    : resolve(join(input.manifestDir, input.path));

  const expectedTables = await readExpectedTables(absolute);
  const failures: Array<Record<string, unknown>> = [];

  for (const [tableName, expectedTable] of Object.entries(expectedTables)) {
    const table = input.loaded.tables.get(tableName);
    if (!table) {
      failures.push({ table: tableName, message: 'table-missing' });
      continue;
    }

    const fieldIdsByName = new Map<string, string>();
    for (const field of table.fields.values()) {
      fieldIdsByName.set(field.name, field.id);
    }
    const fieldIdFor = (key: string): string =>
      fieldIdsByName.get(key) ?? resolveFieldId(table, key);

    const keys = new Set<string>([
      ...expectedTable.keys,
      ...expectedTable.rows.flatMap((row) => Object.keys(row)),
    ]);

    const actualRows = (
      await listAllRecords({
        runtime: input.loaded.runtime,
        actorId: input.loaded.manifest.run.actorId,
        tableId: table.id,
      })
    ).map((row) => {
      const fields = row.fields as Record<string, unknown>;
      const projected: Record<string, unknown> = {};
      for (const key of keys) {
        projected[key] = fields[fieldIdFor(key)];
      }
      return projected;
    });

    const expectedRows = expectedTable.rows.map((row) => {
      const projected: Record<string, unknown> = {};
      for (const key of keys) {
        projected[key] = row[key];
      }
      return projected;
    });

    const actual = normalizeRows(actualRows, expectedTable.keys);
    const wanted = normalizeRows(expectedRows, expectedTable.keys);

    if (canonicalJson(actual) === canonicalJson(wanted)) {
      continue;
    }

    const identity = (row: Readonly<Record<string, unknown>>): string =>
      canonicalJson(expectedTable.keys.map((key) => row[key]));
    const byIdentity = (rows: typeof actual): Map<string, unknown> =>
      new Map(rows.map((row) => [identity(row), row]));
    const wantedByIdentity = byIdentity(wanted);
    const actualByIdentity = byIdentity(actual);

    failures.push({
      table: tableName,
      missing: [...wantedByIdentity.keys()].filter((key) => !actualByIdentity.has(key)),
      extra: [...actualByIdentity.keys()].filter((key) => !wantedByIdentity.has(key)),
      changed: [...wantedByIdentity.keys()]
        .filter((key) => actualByIdentity.has(key))
        .filter(
          (key) =>
            canonicalJson(wantedByIdentity.get(key)) !== canonicalJson(actualByIdentity.get(key))
        ),
    });
  }

  const comparedRows = Object.values(expectedTables).reduce(
    (sum, table) => sum + table.rows.length,
    0
  );
  const metadata = {
    checkId: input.checkId,
    description: input.description ?? `Compare records with ${input.path}`,
    table: Object.keys(expectedTables).join(', ') || null,
    field: null,
    expected: { tables: Object.keys(expectedTables).length, rows: comparedRows },
    actual: { mismatchGroups: failures.length },
    tolerance: null,
    obligationIds: input.obligationIds ?? [],
    rowsMatched: comparedRows,
    method: 'normalized-exact-json',
  };
  if (failures.length > 0) {
    return { ...metadata, status: 'fail', message: 'Expected JSON mismatch', details: failures };
  }
  if (comparedRows === 0 && (input.obligationIds?.length ?? 0) > 0) {
    return {
      ...metadata,
      status: 'unknown',
      message: 'Expected JSON matched zero rows; field obligations were not verified',
    };
  }
  return { ...metadata, status: 'pass' };
}
