import { v2DataDbTokens, v2MetaDbTokens } from '@teable/v2-adapter-db-postgres-shared';
import { v2CoreTokens } from '@teable/v2-core';
import type { IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import { BenchError } from '../errors';

type DisposableKysely = Kysely<unknown> & { destroy(): Promise<void> };
type Coordination = { destroy?: () => Promise<void> };
type ColumnRow = { readonly tableName: string; readonly columnName: string };

const ownedBaseIds = new WeakMap<IHeadlessRuntime, Set<string>>();
const closingRuntimes = new WeakMap<IHeadlessRuntime, Promise<void>>();
const BASE_ID_PATTERN = /^bse[a-zA-Z0-9]{16}$/;

const DIRECT_BASE_TABLES = [
  'table_meta',
  'schema_operation',
  'computed_update_outbox',
  'computed_update_dead_letter',
  'computed_update_run_history',
  'computed_field_activity',
  'computed_table_activity',
  'computed_task_field_ref',
  'computed_reliability_issue',
  'domain_event_outbox',
  'plugin_install',
  'table_query_observation_shard',
  'table_query_recommendation',
  'table_query_remediation_task',
  'table_query_decision_log',
  'table_query_search_vector_config',
] as const;
const TABLE_SCOPED_TABLES = [
  'field',
  'view',
  'comment',
  'table_trash',
  'record_trash',
  'attachments_table',
] as const;

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const resolveKysely = (runtime: IHeadlessRuntime, token: symbol): DisposableKysely | undefined => {
  if (!runtime.container.isRegistered(token)) return undefined;
  return runtime.container.resolve<DisposableKysely>(token);
};

const distinctDatabases = (runtime: IHeadlessRuntime): ReadonlyArray<DisposableKysely> => {
  const databases = new Set<DisposableKysely>();
  const metaDb = resolveKysely(runtime, v2MetaDbTokens.db);
  const dataDb = resolveKysely(runtime, v2DataDbTokens.db);
  if (metaDb) databases.add(metaDb);
  if (dataDb) databases.add(dataDb);
  return [...databases];
};

const tableColumns = async (
  db: DisposableKysely
): Promise<ReadonlyMap<string, ReadonlySet<string>>> => {
  const result = await sql<ColumnRow>`
    select table_name as "tableName", column_name as "columnName"
    from information_schema.columns
    where table_schema = current_schema()
  `.execute(db);
  const columns = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const names = columns.get(row.tableName) ?? new Set<string>();
    names.add(row.columnName);
    columns.set(row.tableName, names);
  }
  return columns;
};

const idsFor = async (
  db: DisposableKysely,
  columns: ReadonlyMap<string, ReadonlySet<string>>,
  table: string,
  valueColumn: string,
  filterColumn: string,
  filterValue: string
): Promise<ReadonlyArray<string>> => {
  if (!columns.get(table)?.has(valueColumn) || !columns.get(table)?.has(filterColumn)) return [];
  const result = await sql<{ id: string }>`
    select ${sql.ref(valueColumn)} as id
    from ${sql.table(table)}
    where ${sql.ref(filterColumn)} = ${filterValue}
  `.execute(db);
  return result.rows.map((row) => row.id);
};

const deleteWhereIn = async (
  db: DisposableKysely,
  table: string,
  column: string,
  values: ReadonlyArray<string>
): Promise<void> => {
  if (values.length === 0) return;
  await sql`
    delete from ${sql.table(table)}
    where ${sql.ref(column)} in (${sql.join(values.map((value) => sql`${value}`))})
  `.execute(db);
};

const cleanupDatabase = async (db: DisposableKysely, baseId: string): Promise<void> => {
  const columns = await tableColumns(db);
  const has = (table: string, column: string) => columns.get(table)?.has(column) === true;
  const tableIds = await idsFor(db, columns, 'table_meta', 'id', 'base_id', baseId);
  const taskIds = [
    ...(await idsFor(db, columns, 'computed_update_outbox', 'id', 'base_id', baseId)),
    ...(await idsFor(db, columns, 'computed_update_dead_letter', 'id', 'base_id', baseId)),
    ...(await idsFor(db, columns, 'computed_update_run_history', 'task_id', 'base_id', baseId)),
  ];
  const issueIds = await idsFor(db, columns, 'computed_reliability_issue', 'id', 'base_id', baseId);
  const eventIds = await idsFor(db, columns, 'domain_event_outbox', 'id', 'base_id', baseId);
  const tableValues = tableIds.length > 0 ? tableIds.map((id) => sql`${id}`) : [sql`null`];

  await deleteFieldReferences(db, tableValues);
  await deleteAttachments(db, tableValues);
  for (const table of TABLE_SCOPED_TABLES) {
    if (has(table, 'table_id')) await deleteWhereIn(db, table, 'table_id', tableIds);
  }
  await deleteTaskScopedRows(db, has, { baseId, tableIds, taskIds, issueIds, eventIds });
  await deleteTrashRows(db, baseId, tableValues);
  await deleteBaseRows(db, baseId);
  await dropBaseSchema(db, baseId);
};

const deleteFieldReferences = async (
  db: DisposableKysely,
  tableValues: ReadonlyArray<unknown>
): Promise<void> => {
  const columns = await tableColumns(db);
  const has = (table: string, column: string) => columns.get(table)?.has(column) === true;
  if (!has('reference', 'from_field_id') || !has('field', 'table_id')) return;
  await sql`
    delete from reference
    where from_field_id in (select id from field where table_id in (${sql.join(tableValues)}))
       or to_field_id in (select id from field where table_id in (${sql.join(tableValues)}))
  `.execute(db);
};

const deleteAttachments = async (
  db: DisposableKysely,
  tableValues: ReadonlyArray<unknown>
): Promise<void> => {
  const columns = await tableColumns(db);
  const has = (table: string, column: string) => columns.get(table)?.has(column) === true;
  if (!has('attachments', 'id') || !has('attachments_table', 'attachment_id')) return;
  await sql`
    delete from attachments
    where id in (
      select owned_refs.attachment_id
      from attachments_table as owned_refs
      where owned_refs.table_id in (${sql.join(tableValues)})
        and not exists (
          select 1
          from attachments_table as remaining_refs
          where remaining_refs.attachment_id = owned_refs.attachment_id
            and remaining_refs.table_id not in (${sql.join(tableValues)})
        )
    )
  `.execute(db);
};

type ScopeIds = {
  readonly baseId: string;
  readonly tableIds: ReadonlyArray<string>;
  readonly taskIds: ReadonlyArray<string>;
  readonly issueIds: ReadonlyArray<string>;
  readonly eventIds: ReadonlyArray<string>;
};

const deleteTaskScopedRows = async (
  db: DisposableKysely,
  has: (table: string, column: string) => boolean,
  ids: ScopeIds
): Promise<void> => {
  const { baseId, tableIds, taskIds, issueIds, eventIds } = ids;
  const scoped: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
    ['computed_update_outbox_seed', 'task_id', taskIds],
    ['computed_update_change_frontier', 'scope_id', taskIds],
    ['computed_update_stage_ledger', 'scope_id', taskIds],
    ['computed_update_pause_scope', 'scope_id', [baseId, ...tableIds]],
    ['computed_reliability_scope', 'issue_id', issueIds],
    ['domain_event_delivery', 'event_id', eventIds],
    ['domain_event_inbox', 'event_id', eventIds],
  ];
  for (const [table, column, values] of scoped) {
    if (has(table, column)) await deleteWhereIn(db, table, column, values);
  }
};

const deleteTrashRows = async (
  db: DisposableKysely,
  baseId: string,
  tableValues: ReadonlyArray<unknown>
): Promise<void> => {
  const columns = await tableColumns(db);
  if (columns.get('trash')?.has('resource_id') !== true) return;
  await sql`
    delete from trash
    where resource_id = ${baseId}
       or parent_id = ${baseId}
       or resource_id in (${sql.join(tableValues)})
  `.execute(db);
};

const deleteBaseRows = async (db: DisposableKysely, baseId: string): Promise<void> => {
  const columns = await tableColumns(db);
  for (const table of DIRECT_BASE_TABLES) {
    if (columns.get(table)?.has('base_id') === true) {
      await sql`delete from ${sql.table(table)} where base_id = ${baseId}`.execute(db);
    }
  }
  if (columns.get('base')?.has('id') === true) {
    await sql`delete from base where id = ${baseId}`.execute(db);
  }
};

const dropBaseSchema = async (db: DisposableKysely, baseId: string): Promise<void> => {
  const schema = await sql<{ exists: boolean }>`
    select exists(select 1 from pg_namespace where nspname = ${baseId}) as exists
  `.execute(db);
  if (schema.rows[0]?.exists) {
    await sql.raw(`drop schema ${quoteIdentifier(baseId)} cascade`).execute(db);
  }
};

const assertOwned = (runtime: IHeadlessRuntime, baseId: string): Set<string> => {
  const owned = ownedBaseIds.get(runtime);
  if (!owned?.has(baseId)) {
    throw new BenchError('bench.base.not_owned', `Refusing to delete unowned base ${baseId}`);
  }
  return owned;
};

/** Register immediately after CreateBaseCommand, before importing structure. */
export function registerBenchBase(runtime: IHeadlessRuntime, baseId: string): void {
  if (!BASE_ID_PATTERN.test(baseId)) {
    throw new BenchError('bench.base.id_invalid', `Refusing to own invalid base id ${baseId}`);
  }
  const ids = ownedBaseIds.get(runtime) ?? new Set<string>();
  ids.add(baseId);
  ownedBaseIds.set(runtime, ids);
}

export async function cleanupBenchBase(runtime: IHeadlessRuntime, baseId: string): Promise<void> {
  const owned = assertOwned(runtime, baseId);
  const databases = distinctDatabases(runtime);
  const results = await Promise.allSettled(databases.map((db) => cleanupDatabase(db, baseId)));
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length > 0) {
    throw new BenchError('bench.base.cleanup_failed', `Failed to clean base ${baseId}`, errors);
  }
  owned.delete(baseId);
}

export async function cleanupBenchBases(runtime: IHeadlessRuntime): Promise<void> {
  const errors: unknown[] = [];
  for (const baseId of [...(ownedBaseIds.get(runtime) ?? [])]) {
    try {
      await cleanupBenchBase(runtime, baseId);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'bench.base.cleanup_failed');
}

const settle = async (action: () => Promise<void>, errors: unknown[]): Promise<void> => {
  try {
    await action();
  } catch (error) {
    errors.push(error);
  }
};

const destroyCoordination = (runtime: IHeadlessRuntime): Promise<void> => {
  if (!runtime.container.isRegistered(v2CoreTokens.tableSchemaCoordination)) {
    return Promise.resolve();
  }
  const coordination = runtime.container.resolve<Coordination>(
    v2CoreTokens.tableSchemaCoordination
  );
  return coordination.destroy?.() ?? Promise.resolve();
};

const closeRuntime = async (runtime: IHeadlessRuntime): Promise<void> => {
  const errors: unknown[] = [];
  await settle(() => cleanupBenchBases(runtime), errors);

  if (runtime.backend === 'pglite') {
    await settle(() => runtime.close(), errors);
  } else {
    await settle(() => destroyCoordination(runtime), errors);
    const results = await Promise.allSettled(distinctDatabases(runtime).map((db) => db.destroy()));
    errors.push(
      ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    );
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'bench.runtime.close_failed');
};

/**
 * Cleans registered bases, coordination, and all distinct meta/data handles.
 * Concurrent and repeated close calls share the same completion promise.
 */
export function closeBenchRuntime(runtime: IHeadlessRuntime): Promise<void> {
  const existing = closingRuntimes.get(runtime);
  if (existing) return existing;
  const closing = closeRuntime(runtime);
  closingRuntimes.set(runtime, closing);
  return closing;
}

/** Close best-effort while preserving the operation error that triggered cleanup. */
export async function closeBenchRuntimeAfterError(
  runtime: IHeadlessRuntime,
  operationError: unknown
): Promise<never> {
  try {
    await closeBenchRuntime(runtime);
  } catch {
    // The operation failure is the actionable error; cleanup remains best-effort here.
  }
  throw operationError;
}
