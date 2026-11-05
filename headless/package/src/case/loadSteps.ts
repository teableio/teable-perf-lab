import type { DotTeaSchemaProfile } from '@teable/v2-complexity';
import type {
  CreateBaseResult,
  CreateRecordsResult,
  Field,
  ImportDotTeaStructureResult,
  ListTablesResult,
  Table,
} from '@teable/v2-core';
import {
  ActorId,
  CreateBaseCommand,
  CreateRecordsCommand,
  FieldOptionsDtoVisitor,
  FieldType,
  ImportDotTeaStructureCommand,
  ListTablesQuery,
  UpdateRecordsCommand,
  v2CoreTokens,
} from '@teable/v2-core';
import { Lifecycle } from '@teable/v2-di';
import { DotTeaParser } from '@teable/v2-dottea';
import { createHeadlessRuntime, type IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';
import { z } from 'zod';

import { BenchError } from '../errors';
import { registerBenchBase } from './runtimeLifecycle';
import type { ResolvedField, ResolvedTable } from './types';

const unwrap = <T, E>(result: Result<T, E>, code: string): T => {
  if (result.isErr()) throw new BenchError(code, String(result.error));
  return result.value;
};

const selectOptionsSchema = z.object({
  choices: z.array(z.object({ name: z.string() })),
});

const ratingOptionsSchema = z.object({
  max: z.number().int().min(1).max(10),
});

const linkOptionsSchema = z.object({
  foreignTableId: z.string(),
  relationship: z.string(),
});

const fieldOptionsVisitor = new FieldOptionsDtoVisitor();

const resolveFieldMetadata = (
  field: Field,
  runtimeNameById: ReadonlyMap<string, string>
): Pick<ResolvedField, 'choices' | 'ratingMax' | 'link'> => {
  const isSelect =
    field.type().equals(FieldType.singleSelect()) ||
    field.type().equals(FieldType.multipleSelect());
  const isRating = field.type().equals(FieldType.rating());
  const isLink = field.type().equals(FieldType.link());
  if (!isSelect && !isRating && !isLink) return {};

  const options = unwrap(field.accept(fieldOptionsVisitor), 'bench.field.options_invalid');
  if (isSelect) {
    const parsed = selectOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new BenchError(
        'bench.field.options_invalid',
        `Invalid select options for ${field.name()}`
      );
    }
    return { choices: parsed.data.choices.map((choice) => choice.name) };
  }
  if (isRating) {
    const parsed = ratingOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new BenchError(
        'bench.field.options_invalid',
        `Invalid rating options for ${field.name()}`
      );
    }
    return { ratingMax: parsed.data.max };
  }

  const parsed = linkOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new BenchError('bench.field.options_invalid', `Invalid link options for ${field.name()}`);
  }
  return {
    link: {
      table: runtimeNameById.get(parsed.data.foreignTableId) ?? parsed.data.foreignTableId,
      relationship: parsed.data.relationship,
    },
  };
};

const context = (actorId = 'usr_headless') => ({
  actorId: unwrap(ActorId.create(actorId), 'bench.actor.invalid'),
});

const importedViews = new WeakMap<
  IHeadlessRuntime,
  Map<string, Readonly<Record<string, string>>>
>();

export async function createRuntimeForBackend(input: {
  backend: 'pglite' | 'postgres';
  connectionString?: string;
}): Promise<IHeadlessRuntime> {
  const runtime =
    input.backend === 'pglite'
      ? await createHeadlessRuntime({ backend: { kind: 'pglite', dataDir: 'memory://' } })
      : await (async () => {
          if (!input.connectionString) {
            throw new BenchError(
              'bench.backend.connection_missing',
              'A PostgreSQL connection string is required'
            );
          }
          return createHeadlessRuntime({
            backend: {
              kind: 'postgres',
              connectionString: input.connectionString,
              bootstrap: true,
            },
          });
        })();
  if (!runtime.container.isRegistered(v2CoreTokens.dotTeaParser)) {
    runtime.container.register(v2CoreTokens.dotTeaParser, DotTeaParser, {
      lifecycle: Lifecycle.Singleton,
    });
  }
  return runtime;
}

export async function createBaseAndImport(input: {
  runtime: IHeadlessRuntime;
  baseName: string;
  teaBytes: Uint8Array;
  actorId?: string;
}): Promise<{ baseId: string; tables: ReadonlyArray<Table> }> {
  const ctx = context(input.actorId);
  const create = unwrap(
    CreateBaseCommand.create({ name: input.baseName }),
    'bench.base.create_invalid'
  );
  const created = unwrap<CreateBaseResult, unknown>(
    await input.runtime.commandBus.execute(ctx, create),
    'bench.base.create_failed'
  );
  const baseId = created.base.id().toString();
  registerBenchBase(input.runtime, baseId);
  const command = unwrap(
    ImportDotTeaStructureCommand.createFromBuffer({ baseId, dotTeaData: input.teaBytes }),
    'bench.tea.import_invalid'
  );
  const imported = unwrap<ImportDotTeaStructureResult, unknown>(
    await input.runtime.commandBus.execute(ctx, command),
    'bench.tea.import_failed'
  );
  const viewsByBase =
    importedViews.get(input.runtime) ?? new Map<string, Readonly<Record<string, string>>>();
  viewsByBase.set(baseId, imported.viewIdMap);
  importedViews.set(input.runtime, viewsByBase);
  const listed = unwrap<ListTablesResult, unknown>(
    await input.runtime.queryBus.execute(
      ctx,
      unwrap(ListTablesQuery.create({ baseId }), 'bench.table.list_invalid')
    ),
    'bench.table.list_failed'
  );
  return { baseId, tables: listed.tables };
}

export async function resolveTables(input: {
  runtime: IHeadlessRuntime;
  baseId: string;
  schemaProfile: DotTeaSchemaProfile;
  actorId?: string;
}): Promise<ReadonlyMap<string, ResolvedTable>> {
  const listed = unwrap<ListTablesResult, unknown>(
    await input.runtime.queryBus.execute(
      context(input.actorId),
      unwrap(ListTablesQuery.create({ baseId: input.baseId }), 'bench.table.list_invalid')
    ),
    'bench.table.list_failed'
  );
  const declaredTableByName = new Map<string, string>();
  for (const [id, name] of input.schemaProfile.tableNames) {
    if (declaredTableByName.has(name)) {
      throw new BenchError('bench.table.ambiguous', `Duplicate table name: ${name}`);
    }
    declaredTableByName.set(name, id);
  }
  const declaredFieldByTable = new Map<string, Map<string, string>>();
  for (const field of input.schemaProfile.fields) {
    const fieldName = input.schemaProfile.fieldNames.get(field.id);
    if (!fieldName) continue;
    const fields = declaredFieldByTable.get(field.tableId) ?? new Map<string, string>();
    if (fields.has(fieldName)) {
      throw new BenchError('bench.field.ambiguous', `Duplicate field name: ${fieldName}`);
    }
    fields.set(fieldName, field.id);
    declaredFieldByTable.set(field.tableId, fields);
  }
  const importedViewIds: Readonly<Record<string, string>> =
    importedViews.get(input.runtime)?.get(input.baseId) ?? {};
  const declaredViewByRuntimeId = new Map(
    Object.entries(importedViewIds).map(([declaredId, id]) => [id, declaredId] as const)
  );

  const runtimeNameById = new Map(
    listed.tables.map((table) => [table.id().toString(), table.name().toString()] as const)
  );
  const resolved = new Map<string, ResolvedTable>();
  for (const table of listed.tables) {
    const name = table.name().toString();
    if (resolved.has(name)) {
      throw new BenchError('bench.table.ambiguous', `Duplicate table name: ${name}`);
    }
    const declaredId = declaredTableByName.get(name);
    const declaredFieldByName = declaredId ? declaredFieldByTable.get(declaredId) : undefined;
    const fields = new Map<string, ResolvedField>();
    for (const field of table.getFields()) {
      const fieldName = field.name().toString();
      if (fields.has(fieldName)) {
        throw new BenchError(
          'bench.field.ambiguous',
          `Duplicate field name in ${name}: ${fieldName}`
        );
      }
      const type = field.type().toString();
      fields.set(fieldName, {
        id: field.id().toString(),
        declaredId: declaredFieldByName?.get(fieldName),
        name: fieldName,
        type,
        isComputed: field.computed().toBoolean(),
        isPrimary: field.id().equals(table.primaryFieldId()),
        isMultiple: field
          .isMultipleCellValue()
          .map((value) => value.isMultiple())
          .unwrapOr(false),
        ...resolveFieldMetadata(field, runtimeNameById),
      });
    }
    const primary = [...fields.values()].find((field) => field.isPrimary);
    if (!primary)
      throw new BenchError('bench.dataset.primary_missing', `Table ${name} has no primary field`);
    const views = new Map<
      string,
      { readonly id: string; readonly name: string; readonly declaredId?: string }
    >();
    for (const view of table.views()) {
      const viewName = view.name().toString();
      if (views.has(viewName)) {
        throw new BenchError('bench.view.ambiguous', `Duplicate view name in ${name}: ${viewName}`);
      }
      const id = view.id().toString();
      const declaredViewId = declaredViewByRuntimeId.get(id);
      views.set(viewName, {
        id,
        name: viewName,
        ...(declaredViewId ? { declaredId: declaredViewId } : {}),
      });
    }
    resolved.set(name, {
      id: table.id().toString(),
      declaredId,
      name,
      primaryFieldName: primary.name,
      fields,
      views,
    });
  }
  return resolved;
}

export async function createRecordsWithoutLinks(input: {
  runtime: IHeadlessRuntime;
  table: ResolvedTable;
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  batchSize: number;
  actorId?: string;
}): Promise<ReadonlyArray<{ id: string; primary: unknown }>> {
  const records: Array<{ id: string; primary: unknown }> = [];
  const primary = input.table.fields.get(input.table.primaryFieldName);
  if (!primary)
    throw new BenchError(
      'bench.dataset.primary_missing',
      `Primary field missing for ${input.table.name}`
    );
  for (let start = 0; start < input.rows.length; start += input.batchSize) {
    const batch = input.rows.slice(start, start + input.batchSize);
    const command = unwrap(
      CreateRecordsCommand.create({
        tableId: input.table.id,
        records: batch.map((row) => ({
          fields: Object.fromEntries(
            Object.entries(row)
              .map(([name, value]) => {
                const field =
                  input.table.fields.get(name) ??
                  [...input.table.fields.values()].find(
                    (candidate) => candidate.declaredId === name || candidate.id === name
                  );
                return [field?.id, value] as const;
              })
              .filter((entry): entry is readonly [string, unknown] => Boolean(entry[0]))
          ),
        })),
        typecast: false,
        fieldKeyType: 'id',
      }),
      'bench.dataset.create_invalid'
    );
    const created = unwrap<CreateRecordsResult, unknown>(
      await input.runtime.commandBus.execute(context(input.actorId), command),
      'bench.dataset.create_failed'
    );
    if (created.records.length !== batch.length) {
      throw new BenchError(
        'bench.dataset.row_count_mismatch',
        `Created ${created.records.length} of ${batch.length} rows`
      );
    }
    for (let index = 0; index < created.records.length; index += 1) {
      const returned = created.records[index]!;
      const returnedPrimary = returned
        .fields()
        .entries()
        .find((entry) => entry.fieldId.toString() === primary.id)
        ?.value.toValue();
      const row = batch[index]!;
      const primaryKeys = [input.table.primaryFieldName, primary.id, primary.declaredId].filter(
        (key): key is string => key != null
      );
      const inputPrimaryKey = primaryKeys.find((key) => Object.hasOwn(row, key));
      const inputPrimary = inputPrimaryKey === undefined ? undefined : row[inputPrimaryKey];
      const primaryValue = returnedPrimary === undefined ? inputPrimary : returnedPrimary;
      records.push({ id: returned.id().toString(), primary: primaryValue });
    }
  }
  return records;
}

export async function applyLinks(input: {
  runtime: IHeadlessRuntime;
  table: ResolvedTable;
  links: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>>;
  recordsByTable: ReadonlyMap<string, ReadonlyArray<{ id: string; primary: unknown }>>;
  batchSize: number;
  actorId?: string;
}): Promise<void> {
  const hostRecords = input.recordsByTable.get(input.table.name) ?? [];
  for (const [fieldName, rows] of Object.entries(input.links)) {
    const field = input.table.fields.get(fieldName);
    if (!field?.link)
      throw new BenchError(
        'bench.field.unknown',
        `Unknown link field ${input.table.name}.${fieldName}`
      );
    const targetRecords = input.recordsByTable.get(field.link.table);
    if (!targetRecords)
      throw new BenchError(
        'bench.link.target_missing',
        `Link target table ${field.link.table} is missing`
      );
    const byPrimary = new Map<string, string>();
    const byId = new Map<string, string>();
    for (const record of targetRecords) {
      byId.set(record.id, record.id);
      if (record.primary !== null && record.primary !== undefined) {
        byPrimary.set(String(record.primary), record.id);
      }
    }
    const updates = rows.map((identifiers, index) => ({
      id: hostRecords[index]?.id,
      fields: {
        [field.id]: identifiers.map((identifier) => {
          const id = byId.get(String(identifier)) ?? byPrimary.get(String(identifier));
          if (!id)
            throw new BenchError(
              'bench.link.target_missing',
              `Link target ${identifier} is missing`
            );
          return { id };
        }),
      },
    }));
    if (updates.some((update) => !update.id)) {
      throw new BenchError(
        'bench.dataset.row_count_mismatch',
        `Link row count exceeds records in ${input.table.name}`
      );
    }
    for (let start = 0; start < updates.length; start += input.batchSize) {
      const command = unwrap(
        UpdateRecordsCommand.create({
          tableId: input.table.id,
          records: updates.slice(start, start + input.batchSize),
          typecast: false,
          fieldKeyType: 'id',
        }),
        'bench.link.update_invalid'
      );
      unwrap(
        await input.runtime.commandBus.execute(context(input.actorId), command),
        'bench.link.update_failed'
      );
    }
  }
}
