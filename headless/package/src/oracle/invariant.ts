import type { BenchInvariantCheck } from '../case/manifest';
import type { LoadedCase, ResolvedField, ResolvedTable } from '../case/types';
import { BenchError } from '../errors';

import { listAllRecords, tableRowCount } from './paging';
import type { BenchOracleResult } from './types';

type CheckOutcome = Omit<BenchOracleResult['checks'][number], 'key' | 'kind'>;

const resolveTable = (loaded: LoadedCase, name: string): ResolvedTable => {
  const table = loaded.tables.get(name);
  if (table) {
    return table;
  }
  for (const candidate of loaded.tables.values()) {
    if (candidate.name === name) {
      return candidate;
    }
  }
  throw new BenchError('bench.table.unknown', `Unknown table ${name}`);
};

const resolveField = (table: ResolvedTable, nameOrId: string): ResolvedField => {
  for (const field of table.fields.values()) {
    if (field.name === nameOrId || field.id === nameOrId || field.declaredId === nameOrId) {
      return field;
    }
  }
  throw new BenchError('bench.field.unknown', `Unknown field ${nameOrId} in table ${table.name}`);
};

const linkCellCount = (value: unknown): number => {
  if (value === null || value === undefined) {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  return 1;
};

export async function evaluateInvariants(input: {
  loaded: LoadedCase;
  groupKey: string;
  checks: ReadonlyArray<BenchInvariantCheck>;
}): Promise<ReadonlyArray<CheckOutcome>> {
  const outcomes: Array<CheckOutcome> = [];

  for (const [index, check] of input.checks.entries()) {
    const table = resolveTable(input.loaded, check.table);
    const checkId = check.checkId ?? `${input.groupKey}/${index + 1}/${check.type}`;
    const metadata = {
      checkId,
      description: check.description ?? `${check.type} ${check.table}`,
      table: table.name,
      obligationIds: check.obligationIds ?? [],
      tolerance: null,
    };

    if (check.type === 'row-count') {
      const actual = await tableRowCount({
        runtime: input.loaded.runtime,
        actorId: input.loaded.manifest.run.actorId,
        tableId: table.id,
      });
      outcomes.push(
        actual === check.expected
          ? {
              ...metadata,
              status: 'pass',
              field: null,
              expected: check.expected,
              actual,
              rowsMatched: actual,
              method: 'exact-row-count',
            }
          : {
              ...metadata,
              status: 'fail',
              field: null,
              expected: check.expected,
              actual,
              rowsMatched: actual,
              method: 'exact-row-count',
              message: `Row count mismatch for ${table.name}: expected ${check.expected}, got ${actual}`,
              details: { table: table.name, expected: check.expected, actual },
            }
      );
      continue;
    }

    if (check.type === 'unique-primary') {
      const field = resolveField(table, table.primaryFieldName);
      const rows = await listAllRecords({
        runtime: input.loaded.runtime,
        actorId: input.loaded.manifest.run.actorId,
        tableId: table.id,
        projection: [field.id],
      });
      const seen = new Map<string, number>();
      let nullCount = 0;
      for (const row of rows) {
        const raw = (row.fields as Record<string, unknown>)[field.id];
        if (raw === null || raw === undefined) {
          nullCount += 1;
          continue;
        }
        const identity = typeof raw === 'string' ? raw : JSON.stringify(raw);
        seen.set(identity, (seen.get(identity) ?? 0) + 1);
      }
      const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
      if (nullCount > 0) {
        duplicates.push(['<null>', nullCount]);
      }
      outcomes.push(
        duplicates.length === 0
          ? {
              ...metadata,
              status: 'pass',
              field: field.name,
              expected: 'all primary values are non-null and unique',
              actual: { rows: rows.length, duplicateGroups: 0, nullCount },
              rowsMatched: rows.length,
              method: 'set-uniqueness',
            }
          : {
              ...metadata,
              status: 'fail',
              field: field.name,
              expected: 'all primary values are non-null and unique',
              actual: { rows: rows.length, duplicateGroups: duplicates.length, nullCount },
              rowsMatched: rows.length,
              method: 'set-uniqueness',
              message: `Duplicate primary values in ${table.name}`,
              details: { table: table.name, field: field.name, duplicates },
            }
      );
      continue;
    }

    if (check.type === 'link-count') {
      const field = resolveField(table, check.field);
      if (!field.link) {
        throw new BenchError(
          'bench.invariant.not_link',
          `Field ${field.name} in ${table.name} is not a link field`
        );
      }
      const rows = await listAllRecords({
        runtime: input.loaded.runtime,
        actorId: input.loaded.manifest.run.actorId,
        tableId: table.id,
        projection: [field.id],
      });
      const actual = rows.reduce(
        (sum, row) => sum + linkCellCount((row.fields as Record<string, unknown>)[field.id]),
        0
      );
      outcomes.push(
        actual === check.expected
          ? {
              ...metadata,
              status: 'pass',
              field: field.name,
              expected: check.expected,
              actual,
              rowsMatched: rows.length,
              method: 'exact-link-count',
            }
          : {
              ...metadata,
              status: 'fail',
              field: field.name,
              expected: check.expected,
              actual,
              rowsMatched: rows.length,
              method: 'exact-link-count',
              message: `Link count mismatch for ${table.name}.${field.name}: expected ${check.expected}, got ${actual}`,
              details: { table: table.name, field: field.name, expected: check.expected, actual },
            }
      );
      continue;
    }

    const fieldIds = check.fields.map((name) => {
      const field = resolveField(table, name);
      if (!field.isComputed) {
        throw new BenchError(
          'bench.invariant.not_computed',
          `Field ${field.name} in ${table.name} is not computed`
        );
      }
      return field;
    });

    const rows = await listAllRecords({
      runtime: input.loaded.runtime,
      actorId: input.loaded.manifest.run.actorId,
      tableId: table.id,
      projection: fieldIds.map((field) => field.id),
    });
    const nullFields = fieldIds
      .map((field) => {
        const nullCount = rows.filter((row) => {
          const value = (row.fields as Record<string, unknown>)[field.id];
          return value === null || value === undefined;
        }).length;
        return nullCount === 0 ? null : { field: field.name, nullCount };
      })
      .filter((entry) => entry !== null);

    const fieldNames = fieldIds.map((field) => field.name);
    const actual = { rows: rows.length, nullFields };
    outcomes.push(
      rows.length > 0 && nullFields.length === 0
        ? {
            ...metadata,
            status: 'pass',
            field: fieldNames.join(', '),
            expected: { rowsAtLeast: 1, nullCount: 0 },
            actual,
            rowsMatched: rows.length,
            method: 'computed-non-null-scan',
          }
        : {
            ...metadata,
            status: 'fail',
            field: fieldNames.join(', '),
            expected: { rowsAtLeast: 1, nullCount: 0 },
            actual,
            rowsMatched: rows.length,
            method: 'computed-non-null-scan',
            message:
              rows.length === 0
                ? `Computed non-null check matched zero rows in ${table.name}`
                : `Computed fields contain nulls in ${table.name}`,
            details: { table: table.name, fields: nullFields, rows: rows.length },
          }
    );
  }

  return outcomes;
}
