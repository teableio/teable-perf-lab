import { performance } from 'node:perf_hooks';

import {
  ActorId,
  CreateBaseCommand,
  type CreateBaseResult,
  CreateFieldsCommand,
  type CreateFieldsResult,
  CreateRecordCommand,
  type CreateRecordResult,
  CreateTableCommand,
  type CreateTableResult,
  CreateTablesCommand,
  type CreateTablesResult,
  DeleteFieldsCommand,
  type DeleteFieldsResult,
  DuplicateFieldCommand,
  type DuplicateFieldResult,
  DuplicateRecordCommand,
  type DuplicateRecordResult,
  DuplicateTableCommand,
  type DuplicateTableResult,
  type Field,
  GetRecordByIdQuery,
  type GetRecordByIdResult,
  GetTableByIdQuery,
  type GetTableByIdResult,
  ListTableRecordsQuery,
  type ListTableRecordsResult,
  type Table,
  UpdateTablePropertiesCommand,
  type UpdateTablePropertiesResult,
} from '@teable/v2-core';
import type { IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';

import { createRuntimeForBackend } from '../case/loadSteps';
import { cleanupBenchBase, closeBenchRuntime, registerBenchBase } from '../case/runtimeLifecycle';
import type { HttpBenchRun } from '../httpBench/runner';
import type { BenchOperationObservation } from '../runner/BenchRunner';
import {
  executeMeasured,
  finalizeMeasurement,
  makeMeasurements,
  RecordedOperationFailure,
  type MutableMeasurement,
  type OperationResult,
  type TimedOperationResult as TimedResult,
} from '../runner/operationMeasurements';
import { resolveBenchCommit } from '../runner/provenance';
import { CORE_EXTRA_CASES, type CoreExtraBenchCaseKey } from './cases';

export { CORE_EXTRA_CASES, type CoreExtraBenchCase } from './cases';

export type RunCoreExtraBenchInput = {
  readonly backend: 'pglite' | 'postgres';
  readonly connectionString?: string;
  readonly samples: number;
  readonly warmup: number;
};

export type CoreExtraBenchRun = HttpBenchRun;

type ExecutionContext = { readonly actorId: ActorId };

const CASE_ID = 'headless-core-extra-operations-v2';
const ACTOR_ID = 'usr_core_extra_bench';
const BULK_FIELD_COUNT = 2;
const CREATED_TABLE_COUNT = 2;
const CREATED_TABLE_RECORD_COUNT = 1;
const SOURCE_RECORD_COUNT = 2;

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const unwrap = <T, E>(result: Result<T, E>, code: string): T => {
  if (result.isErr()) throw new Error(`${code}: ${errorMessage(result.error)}`);
  return result.value;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const assertEqual = (actual: unknown, expected: unknown, message: string): void => {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    );
  }
};

type ExpectedRecord = {
  readonly id: string;
  readonly fields: Readonly<Record<string, unknown>>;
};

const assertExactRecords = (
  actual: ReadonlyArray<{
    readonly id: string;
    readonly fields: Readonly<Record<string, unknown>>;
  }>,
  expected: ReadonlyArray<ExpectedRecord>,
  fieldIds: ReadonlyArray<string>,
  message: string
): void => {
  assertEqual(actual.length, expected.length, `${message} count`);
  const expectedById = new Map(expected.map((record) => [record.id, record]));
  for (const actualRecord of actual) {
    const expectedRecord = expectedById.get(actualRecord.id);
    assert(expectedRecord, `${message} contains unexpected record ${actualRecord.id}`);
    for (const fieldId of fieldIds) {
      assertEqual(
        actualRecord.fields[fieldId] ?? null,
        expectedRecord.fields[fieldId] ?? null,
        `${message} record ${actualRecord.id} field ${fieldId}`
      );
    }
    expectedById.delete(actualRecord.id);
  }
  assertEqual(expectedById.size, 0, `${message} missing record count`);
};

const timedResult = async <T, E>(
  action: () => Promise<Result<T, E>>,
  errorCode: string
): Promise<TimedResult<T>> => {
  const started = performance.now();
  const result = await action();
  const latencyMs = performance.now() - started;
  return { data: unwrap(result, errorCode), latencyMs };
};

const observation = (
  recordIds: ReadonlyArray<string>,
  relation: BenchOperationObservation['recordRelation'],
  fieldNames: ReadonlyArray<string>
): BenchOperationObservation => ({
  recordIds: recordIds.slice(0, 100),
  recordRelation: relation,
  fieldNames: [...fieldNames],
  truncated: recordIds.length > 100,
});

const createContext = (): ExecutionContext => ({
  actorId: unwrap(ActorId.create(ACTOR_ID), 'coreExtra.actor.invalid'),
});

const tableField = (table: Table, name: string): Field => {
  const field = table.getFields().find((candidate) => candidate.name().toString() === name);
  assert(field, `Table ${table.name().toString()} is missing field ${name}`);
  return field;
};

const getTable = async (
  runtime: IHeadlessRuntime,
  context: ExecutionContext,
  baseId: string,
  tableId: string
): Promise<Table> =>
  unwrap(
    await runtime.queryBus.execute<GetTableByIdQuery, GetTableByIdResult>(
      context,
      unwrap(GetTableByIdQuery.create({ baseId, tableId }), 'coreExtra.table.get_readback.invalid')
    ),
    'coreExtra.table.get_readback.failed'
  ).table;

const getRecord = async (
  runtime: IHeadlessRuntime,
  context: ExecutionContext,
  tableId: string,
  recordId: string
): Promise<GetRecordByIdResult['record']> =>
  unwrap(
    await runtime.queryBus.execute<GetRecordByIdQuery, GetRecordByIdResult>(
      context,
      unwrap(
        GetRecordByIdQuery.create({ tableId, recordId }),
        'coreExtra.record.get_readback.invalid'
      )
    ),
    'coreExtra.record.get_readback.failed'
  ).record;

const listRecords = async (
  runtime: IHeadlessRuntime,
  context: ExecutionContext,
  tableId: string
): Promise<ListTableRecordsResult> =>
  unwrap(
    await runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
      context,
      unwrap(
        ListTableRecordsQuery.create({
          tableId,
          fieldKeyType: 'id',
          limit: 10,
          includeTotal: true,
        }),
        'coreExtra.records.list_readback.invalid'
      )
    ),
    'coreExtra.records.list_readback.failed'
  );

const runRound = async (input: {
  round: number;
  measured: boolean;
  runtime: IHeadlessRuntime;
  context: ExecutionContext;
  measurements: Map<CoreExtraBenchCaseKey, MutableMeasurement<CoreExtraBenchCaseKey>>;
  errors: string[];
}): Promise<void> => {
  const measure = <T>(key: CoreExtraBenchCaseKey, action: () => Promise<OperationResult<T>>) =>
    executeMeasured({
      key,
      action,
      measured: input.measured,
      measurements: input.measurements,
      errors: input.errors,
    });
  const label = `${input.measured ? 'sample' : 'warmup'}-${input.round}`;
  const baseName = `Core extra ${label}`;
  const tableName = `Source ${label}`;
  const recordName = `Record ${label}`;
  const recordAmount = input.round + (input.measured ? 100 : 10);
  let baseId: string | undefined;

  try {
    const base = unwrap(
      await input.runtime.commandBus.execute<CreateBaseCommand, CreateBaseResult>(
        input.context,
        unwrap(CreateBaseCommand.create({ name: baseName }), 'coreExtra.base.create.invalid')
      ),
      'coreExtra.base.create.failed'
    );
    baseId = base.base.id().toString();
    registerBenchBase(input.runtime, baseId);

    const setupTable = unwrap(
      await input.runtime.commandBus.execute<CreateTableCommand, CreateTableResult>(
        input.context,
        unwrap(
          CreateTableCommand.create({
            baseId,
            name: tableName,
            fields: [
              { name: 'Name', type: 'singleLineText', isPrimary: true },
              { name: 'Amount', type: 'number' },
            ],
          }),
          'coreExtra.table.create.invalid'
        )
      ),
      'coreExtra.table.create.failed'
    ).table;
    const tableId = setupTable.id().toString();
    const nameId = tableField(setupTable, 'Name').id().toString();
    const amountId = tableField(setupTable, 'Amount').id().toString();

    await measure('GetTableByIdQuery', async () => {
      const query = unwrap(
        GetTableByIdQuery.create({ baseId, tableId }),
        'coreExtra.table.get.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<GetTableByIdQuery, GetTableByIdResult>(
            input.context,
            query
          ),
        'coreExtra.table.get.failed'
      );
      assertEqual(response.data.table.id().toString(), tableId, 'Queried table id');
      assertEqual(response.data.table.name().toString(), tableName, 'Queried table name');
      assertEqual(
        JSON.stringify(response.data.table.getFields().map((field) => field.name().toString())),
        JSON.stringify(['Name', 'Amount']),
        'Queried table fields'
      );
      return { ...response, rowsRead: 1, rowsReturned: 1 };
    });

    const fieldIdSuffix = `${input.measured ? 'm' : 'w'}${String(input.round).padStart(14, '0')}`;
    const schemaNameId = `flds${fieldIdSuffix}`;
    const seededNameId = `fldn${fieldIdSuffix}`;
    const seededAmountId = `flda${fieldIdSuffix}`;
    const schemaOnlyTableName = `Schema only ${label}`;
    const seededTableName = `Seeded ${label}`;
    const seededRecordName = `Seed ${label}`;
    const seededRecordAmount = recordAmount + 1_000;
    const createdTables = await measure('CreateTablesCommand', async () => {
      const command = unwrap(
        CreateTablesCommand.create({
          baseId,
          tables: [
            {
              name: schemaOnlyTableName,
              fields: [
                { id: schemaNameId, name: 'Schema Name', type: 'singleLineText', isPrimary: true },
              ],
            },
            {
              name: seededTableName,
              fields: [
                { id: seededNameId, name: 'Seed Name', type: 'singleLineText', isPrimary: true },
                { id: seededAmountId, name: 'Seed Amount', type: 'number' },
              ],
              records: [
                {
                  fields: {
                    [seededNameId]: seededRecordName,
                    [seededAmountId]: seededRecordAmount,
                  },
                },
              ],
            },
          ],
        }),
        'coreExtra.tables.create.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<CreateTablesCommand, CreateTablesResult>(
            input.context,
            command
          ),
        'coreExtra.tables.create.failed'
      );
      assertEqual(response.data.tables.length, CREATED_TABLE_COUNT, 'Bulk-created table count');
      assertEqual(
        JSON.stringify(response.data.tables.map((table) => table.name().toString())),
        JSON.stringify([schemaOnlyTableName, seededTableName]),
        'Bulk-created table order'
      );
      return {
        ...response,
        rowsWritten: CREATED_TABLE_COUNT + CREATED_TABLE_RECORD_COUNT,
      };
    });
    const schemaOnlyTable = createdTables.tables[0];
    const seededTable = createdTables.tables[1];
    assert(schemaOnlyTable, 'CreateTablesCommand omitted schema-only table');
    assert(seededTable, 'CreateTablesCommand omitted seeded table');
    const schemaOnlyTableId = schemaOnlyTable.id().toString();
    const seededTableId = seededTable.id().toString();
    assert(schemaOnlyTableId !== tableId, 'Schema-only table reused source table id');
    assert(seededTableId !== tableId, 'Seeded table reused source table id');
    assert(schemaOnlyTableId !== seededTableId, 'CreateTablesCommand reused a table id');
    const persistedSchemaOnlyTable = await getTable(
      input.runtime,
      input.context,
      baseId,
      schemaOnlyTableId
    );
    const persistedSchemaNameField = tableField(persistedSchemaOnlyTable, 'Schema Name');
    assertEqual(
      persistedSchemaNameField.id().toString(),
      schemaNameId,
      'Schema-only table persisted field identity'
    );
    assertEqual(
      persistedSchemaNameField.type().toString(),
      'singleLineText',
      'Schema-only table persisted field type'
    );
    const schemaOnlyRecords = await listRecords(input.runtime, input.context, schemaOnlyTableId);
    assertEqual(schemaOnlyRecords.total, 0, 'Schema-only table record total');
    assertExactRecords(schemaOnlyRecords.records, [], [schemaNameId], 'Schema-only table records');
    const persistedSeededTable = await getTable(
      input.runtime,
      input.context,
      baseId,
      seededTableId
    );
    const persistedSeededNameField = tableField(persistedSeededTable, 'Seed Name');
    const persistedSeededAmountField = tableField(persistedSeededTable, 'Seed Amount');
    assertEqual(
      persistedSeededNameField.id().toString(),
      seededNameId,
      'Seeded table persisted name field identity'
    );
    assertEqual(
      persistedSeededNameField.type().toString(),
      'singleLineText',
      'Seeded table persisted name field type'
    );
    assertEqual(
      persistedSeededAmountField.id().toString(),
      seededAmountId,
      'Seeded table persisted amount field identity'
    );
    assertEqual(
      persistedSeededAmountField.type().toString(),
      'number',
      'Seeded table persisted amount field type'
    );
    const persistedSeededRecords = await listRecords(input.runtime, input.context, seededTableId);
    assertEqual(
      persistedSeededRecords.total,
      CREATED_TABLE_RECORD_COUNT,
      'Seeded table record total'
    );
    const persistedSeededRecord = persistedSeededRecords.records[0];
    assert(persistedSeededRecord, 'Seeded table record is absent');
    assertExactRecords(
      persistedSeededRecords.records,
      [
        {
          id: persistedSeededRecord.id,
          fields: { [seededNameId]: seededRecordName, [seededAmountId]: seededRecordAmount },
        },
      ],
      [seededNameId, seededAmountId],
      'Seeded table records'
    );

    const tableDescription = `Properties for ${label}`;
    const tableIcon = '📊';
    await measure('UpdateTablePropertiesCommand', async () => {
      const command = unwrap(
        UpdateTablePropertiesCommand.create({
          baseId,
          tableId,
          description: tableDescription,
          icon: tableIcon,
        }),
        'coreExtra.table.properties.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<
            UpdateTablePropertiesCommand,
            UpdateTablePropertiesResult
          >(input.context, command),
        'coreExtra.table.properties.failed'
      );
      assertEqual(response.data.table.id().toString(), tableId, 'Updated table identity');
      assertEqual(
        response.data.table.properties().description(),
        tableDescription,
        'Updated table description'
      );
      assertEqual(response.data.table.properties().icon(), tableIcon, 'Updated table icon');
      return { ...response, rowsWritten: 1 };
    });
    const persistedPropertiesTable = await getTable(input.runtime, input.context, baseId, tableId);
    assertEqual(persistedPropertiesTable.id().toString(), tableId, 'Persisted updated table id');
    assertEqual(
      persistedPropertiesTable.name().toString(),
      tableName,
      'Persisted source table name'
    );
    assertEqual(
      persistedPropertiesTable.properties().description(),
      tableDescription,
      'Persisted table description'
    );
    assertEqual(persistedPropertiesTable.properties().icon(), tableIcon, 'Persisted table icon');
    assertEqual(
      JSON.stringify(persistedPropertiesTable.getFields().map((field) => field.id().toString())),
      JSON.stringify([nameId, amountId]),
      'Table properties update changed source schema identities'
    );

    const createdRecord = await measure('CreateRecordCommand', async () => {
      const command = unwrap(
        CreateRecordCommand.create({
          tableId,
          fieldKeyType: 'id',
          fields: { [nameId]: recordName, [amountId]: recordAmount },
        }),
        'coreExtra.record.create.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<CreateRecordCommand, CreateRecordResult>(
            input.context,
            command
          ),
        'coreExtra.record.create.failed'
      );
      return {
        ...response,
        rowsWritten: 1,
        observation: observation([response.data.record.id().toString()], 'command-target', [
          nameId,
          amountId,
        ]),
      };
    });
    const recordId = createdRecord.record.id().toString();
    const persistedCreatedRecord = await getRecord(input.runtime, input.context, tableId, recordId);
    assertEqual(persistedCreatedRecord.fields[nameId], recordName, 'Created record persisted name');
    assertEqual(
      persistedCreatedRecord.fields[amountId],
      recordAmount,
      'Created record persisted amount'
    );

    await measure('GetRecordByIdQuery', async () => {
      const query = unwrap(
        GetRecordByIdQuery.create({ tableId, recordId }),
        'coreExtra.record.get.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<GetRecordByIdQuery, GetRecordByIdResult>(
            input.context,
            query
          ),
        'coreExtra.record.get.failed'
      );
      assertEqual(response.data.record.id, recordId, 'Queried record id');
      assertEqual(response.data.record.fields[nameId], recordName, 'Queried record name');
      assertEqual(response.data.record.fields[amountId], recordAmount, 'Queried record amount');
      return {
        ...response,
        rowsRead: 1,
        rowsReturned: 1,
        observation: observation([recordId], 'returned', [nameId, amountId]),
      };
    });

    const duplicatedRecord = await measure('DuplicateRecordCommand', async () => {
      const command = unwrap(
        DuplicateRecordCommand.create({ tableId, recordId }),
        'coreExtra.record.duplicate.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<DuplicateRecordCommand, DuplicateRecordResult>(
            input.context,
            command
          ),
        'coreExtra.record.duplicate.failed'
      );
      const duplicatedRecordId = response.data.record.id().toString();
      assert(duplicatedRecordId !== recordId, 'Duplicated record reused source record id');
      assertEqual(response.data.record.tableId().toString(), tableId, 'Duplicated record table id');
      return {
        ...response,
        rowsRead: 1,
        rowsWritten: 1,
        observation: observation([recordId, duplicatedRecordId], 'command-target', [
          nameId,
          amountId,
        ]),
      };
    });
    const duplicatedRecordId = duplicatedRecord.record.id().toString();
    const recordsAfterDuplicate = await listRecords(input.runtime, input.context, tableId);
    assertEqual(
      recordsAfterDuplicate.total,
      SOURCE_RECORD_COUNT,
      'Source record total after duplicate'
    );
    assertExactRecords(
      recordsAfterDuplicate.records,
      [
        { id: recordId, fields: { [nameId]: recordName, [amountId]: recordAmount } },
        { id: duplicatedRecordId, fields: { [nameId]: recordName, [amountId]: recordAmount } },
      ],
      [nameId, amountId],
      'Source records after record duplicate'
    );

    const createdFields = await measure('CreateFieldsCommand', async () => {
      const command = unwrap(
        CreateFieldsCommand.create({
          baseId,
          tableId,
          fields: [
            { name: 'Bulk Notes', type: 'longText' },
            { name: 'Bulk Score', type: 'number' },
          ],
        }),
        'coreExtra.fields.create.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<CreateFieldsCommand, CreateFieldsResult>(
            input.context,
            command
          ),
        'coreExtra.fields.create.failed'
      );
      assertEqual(response.data.fields.length, BULK_FIELD_COUNT, 'Bulk-created field count');
      assertEqual(
        JSON.stringify(response.data.fields.map((field) => field.name().toString())),
        JSON.stringify(['Bulk Notes', 'Bulk Score']),
        'Bulk-created field order'
      );
      return { ...response, rowsWritten: BULK_FIELD_COUNT };
    });
    const bulkFieldIds = createdFields.fields.map((field) => field.id().toString());
    const afterBulkCreate = await getTable(input.runtime, input.context, baseId, tableId);
    for (const [index, expectedName] of ['Bulk Notes', 'Bulk Score'].entries()) {
      const fieldId = bulkFieldIds[index];
      assert(fieldId, `Missing bulk-created field id at index ${index}`);
      assertEqual(
        tableField(afterBulkCreate, expectedName).id().toString(),
        fieldId,
        `Persisted bulk-created field ${expectedName}`
      );
    }

    await measure('DeleteFieldsCommand', async () => {
      const command = unwrap(
        DeleteFieldsCommand.create({ baseId, tableId, fieldIds: bulkFieldIds }),
        'coreExtra.fields.delete.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<DeleteFieldsCommand, DeleteFieldsResult>(
            input.context,
            command
          ),
        'coreExtra.fields.delete.failed'
      );
      assert(
        bulkFieldIds.every(
          (fieldId) =>
            !response.data.table.getFields().some((field) => field.id().toString() === fieldId)
        ),
        'Bulk-deleted fields remain in command result'
      );
      return { ...response, rowsWritten: BULK_FIELD_COUNT };
    });
    const afterBulkDelete = await getTable(input.runtime, input.context, baseId, tableId);
    assert(
      bulkFieldIds.every(
        (fieldId) => !afterBulkDelete.getFields().some((field) => field.id().toString() === fieldId)
      ),
      'Bulk-deleted fields remain in persisted schema'
    );
    assertEqual(afterBulkDelete.getFields().length, 2, 'Source fields after bulk delete');

    const amountCopyName = `Amount values ${label}`;
    const duplicatedAmountField = await measure('DuplicateFieldCommand/with-values', async () => {
      const command = unwrap(
        DuplicateFieldCommand.create({
          baseId,
          tableId,
          fieldId: amountId,
          includeRecordValues: true,
          newFieldName: amountCopyName,
        }),
        'coreExtra.field.duplicate_with_values.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<DuplicateFieldCommand, DuplicateFieldResult>(
            input.context,
            command
          ),
        'coreExtra.field.duplicate_with_values.failed'
      );
      assertEqual(
        response.data.sourceField.id().toString(),
        amountId,
        'Duplicated source field id'
      );
      assertEqual(
        response.data.newField.name().toString(),
        amountCopyName,
        'Duplicated with-values field name'
      );
      return {
        ...response,
        rowsRead: SOURCE_RECORD_COUNT,
        rowsWritten: SOURCE_RECORD_COUNT + 1,
      };
    });
    const amountCopyId = duplicatedAmountField.newField.id().toString();
    assert(amountCopyId !== amountId, 'With-values duplicate reused source field id');
    const afterAmountDuplicate = await getTable(input.runtime, input.context, baseId, tableId);
    const persistedAmountField = tableField(afterAmountDuplicate, 'Amount');
    const persistedAmountCopyField = tableField(afterAmountDuplicate, amountCopyName);
    assertEqual(
      persistedAmountField.id().toString(),
      amountId,
      'With-values duplication changed source field identity'
    );
    assertEqual(persistedAmountField.type().toString(), 'number', 'Source Amount field type');
    assertEqual(
      persistedAmountCopyField.id().toString(),
      amountCopyId,
      'With-values duplicate field identity'
    );
    assertEqual(
      persistedAmountCopyField.type().toString(),
      persistedAmountField.type().toString(),
      'With-values duplicate field type'
    );
    const recordsAfterAmountDuplicate = await listRecords(input.runtime, input.context, tableId);
    assertEqual(
      recordsAfterAmountDuplicate.total,
      SOURCE_RECORD_COUNT,
      'Source record total after with-values field duplicate'
    );
    assertExactRecords(
      recordsAfterAmountDuplicate.records,
      [
        {
          id: recordId,
          fields: {
            [nameId]: recordName,
            [amountId]: recordAmount,
            [amountCopyId]: recordAmount,
          },
        },
        {
          id: duplicatedRecordId,
          fields: {
            [nameId]: recordName,
            [amountId]: recordAmount,
            [amountCopyId]: recordAmount,
          },
        },
      ],
      [nameId, amountId, amountCopyId],
      'Records after with-values field duplicate'
    );

    const schemaCopyName = `Name schema ${label}`;
    const duplicatedSchemaField = await measure('DuplicateFieldCommand/schema-only', async () => {
      const command = unwrap(
        DuplicateFieldCommand.create({
          baseId,
          tableId,
          fieldId: nameId,
          includeRecordValues: false,
          newFieldName: schemaCopyName,
        }),
        'coreExtra.field.duplicate_schema_only.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<DuplicateFieldCommand, DuplicateFieldResult>(
            input.context,
            command
          ),
        'coreExtra.field.duplicate_schema_only.failed'
      );
      assertEqual(response.data.sourceField.id().toString(), nameId, 'Schema source field id');
      assertEqual(
        response.data.newField.name().toString(),
        schemaCopyName,
        'Schema-only duplicate field name'
      );
      return { ...response, rowsRead: 1, rowsWritten: 1 };
    });
    const schemaCopyId = duplicatedSchemaField.newField.id().toString();
    assert(schemaCopyId !== nameId, 'Schema-only duplicate reused source field id');
    const sourceAfterFieldDuplicates = await getTable(
      input.runtime,
      input.context,
      baseId,
      tableId
    );
    assertEqual(sourceAfterFieldDuplicates.id().toString(), tableId, 'Source table identity');
    assertEqual(
      JSON.stringify(
        sourceAfterFieldDuplicates
          .getFields()
          .map((field) => field.id().toString())
          .sort()
      ),
      JSON.stringify([nameId, amountId, amountCopyId, schemaCopyId].sort()),
      'Persisted duplicated field schema identities'
    );
    const persistedSourceNameField = tableField(sourceAfterFieldDuplicates, 'Name');
    const persistedSchemaCopyField = tableField(sourceAfterFieldDuplicates, schemaCopyName);
    assertEqual(persistedSourceNameField.id().toString(), nameId, 'Persisted source Name identity');
    assertEqual(
      persistedSchemaCopyField.id().toString(),
      schemaCopyId,
      'Schema-only duplicate field identity'
    );
    assertEqual(
      persistedSchemaCopyField.type().toString(),
      persistedSourceNameField.type().toString(),
      'Schema-only duplicate field type'
    );
    const expectedSourceRecords = [
      {
        id: recordId,
        fields: {
          [nameId]: recordName,
          [amountId]: recordAmount,
          [amountCopyId]: recordAmount,
          [schemaCopyId]: null,
        },
      },
      {
        id: duplicatedRecordId,
        fields: {
          [nameId]: recordName,
          [amountId]: recordAmount,
          [amountCopyId]: recordAmount,
          [schemaCopyId]: null,
        },
      },
    ];
    const recordsAfterSchemaDuplicate = await listRecords(input.runtime, input.context, tableId);
    assertEqual(
      recordsAfterSchemaDuplicate.total,
      SOURCE_RECORD_COUNT,
      'Source record total after schema-only field duplicate'
    );
    assertExactRecords(
      recordsAfterSchemaDuplicate.records,
      expectedSourceRecords,
      [nameId, amountId, amountCopyId, schemaCopyId],
      'Records after schema-only field duplicate'
    );

    const duplicateName = `Duplicate ${label}`;
    const duplicated = await measure('DuplicateTableCommand', async () => {
      const command = unwrap(
        DuplicateTableCommand.create({
          baseId,
          tableId,
          name: duplicateName,
          includeRecords: true,
        }),
        'coreExtra.table.duplicate.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<DuplicateTableCommand, DuplicateTableResult>(
            input.context,
            command
          ),
        'coreExtra.table.duplicate.failed'
      );
      assertEqual(response.data.table.name().toString(), duplicateName, 'Duplicated table name');
      assertEqual(response.data.fieldIdMap.size, 4, 'Duplicated field mapping count');
      return {
        ...response,
        rowsRead: SOURCE_RECORD_COUNT,
        rowsWritten: SOURCE_RECORD_COUNT + 1,
      };
    });
    const duplicateId = duplicated.table.id().toString();
    assert(duplicateId !== tableId, 'Duplicated table reused the source table id');
    const persistedDuplicate = await getTable(input.runtime, input.context, baseId, duplicateId);
    assertEqual(persistedDuplicate.name().toString(), duplicateName, 'Persisted duplicate name');
    const duplicateNameId = duplicated.fieldIdMap.get(nameId);
    const duplicateAmountId = duplicated.fieldIdMap.get(amountId);
    const duplicateAmountCopyId = duplicated.fieldIdMap.get(amountCopyId);
    const duplicateSchemaCopyId = duplicated.fieldIdMap.get(schemaCopyId);
    assert(duplicateNameId, 'Duplicate field map is missing Name');
    assert(duplicateAmountId, 'Duplicate field map is missing Amount');
    assert(duplicateAmountCopyId, 'Duplicate field map is missing copied Amount');
    assert(duplicateSchemaCopyId, 'Duplicate field map is missing schema-only Name');
    assertEqual(
      tableField(persistedDuplicate, 'Name').id().toString(),
      duplicateNameId,
      'Persisted duplicate Name field mapping'
    );
    assertEqual(
      tableField(persistedDuplicate, 'Amount').id().toString(),
      duplicateAmountId,
      'Persisted duplicate Amount field mapping'
    );
    assertEqual(
      tableField(persistedDuplicate, amountCopyName).id().toString(),
      duplicateAmountCopyId,
      'Persisted duplicate copied Amount field mapping'
    );
    assertEqual(
      tableField(persistedDuplicate, schemaCopyName).id().toString(),
      duplicateSchemaCopyId,
      'Persisted duplicate schema-only Name field mapping'
    );
    const duplicateRecords = await listRecords(input.runtime, input.context, duplicateId);
    assertEqual(duplicateRecords.total, SOURCE_RECORD_COUNT, 'Duplicated persisted row count');
    assertEqual(duplicateRecords.records.length, SOURCE_RECORD_COUNT, 'Duplicated returned rows');
    const duplicateRecordIds = duplicateRecords.records.map(({ id }) => id);
    assertEqual(
      new Set(duplicateRecordIds).size,
      SOURCE_RECORD_COUNT,
      'Duplicated record identities'
    );
    assertExactRecords(
      duplicateRecords.records,
      // Table duplication preserves row IDs within a new table (V1 semantics);
      // unlike DuplicateRecordCommand, it remaps fields, not record identities.
      expectedSourceRecords.map((sourceRecord) => ({
        id: sourceRecord.id,
        fields: {
          [duplicateNameId]: sourceRecord.fields[nameId],
          [duplicateAmountId]: sourceRecord.fields[amountId],
          [duplicateAmountCopyId]: sourceRecord.fields[amountCopyId],
          [duplicateSchemaCopyId]: sourceRecord.fields[schemaCopyId],
        },
      })),
      [duplicateNameId, duplicateAmountId, duplicateAmountCopyId, duplicateSchemaCopyId],
      'Duplicated table records'
    );
    const sourceAfterTableDuplicate = await getTable(input.runtime, input.context, baseId, tableId);
    assertEqual(sourceAfterTableDuplicate.id().toString(), tableId, 'Final source table identity');
    assertEqual(sourceAfterTableDuplicate.name().toString(), tableName, 'Final source table name');
    assertEqual(
      sourceAfterTableDuplicate.properties().description(),
      tableDescription,
      'Final source table description'
    );
    assertEqual(
      JSON.stringify(
        sourceAfterTableDuplicate
          .getFields()
          .map((field) => field.id().toString())
          .sort()
      ),
      JSON.stringify([nameId, amountId, amountCopyId, schemaCopyId].sort()),
      'Final source table schema identities'
    );
    const finalSourceRecords = await listRecords(input.runtime, input.context, tableId);
    assertEqual(finalSourceRecords.total, SOURCE_RECORD_COUNT, 'Final source record total');
    assertExactRecords(
      finalSourceRecords.records,
      expectedSourceRecords,
      [nameId, amountId, amountCopyId, schemaCopyId],
      'Final source records'
    );
  } finally {
    if (baseId) await cleanupBenchBase(input.runtime, baseId);
  }
};

const validateInput = (input: RunCoreExtraBenchInput): void => {
  if (!Number.isInteger(input.samples) || input.samples <= 0) {
    throw new Error('samples must be a positive integer');
  }
  if (!Number.isInteger(input.warmup) || input.warmup < 0) {
    throw new Error('warmup must be a non-negative integer');
  }
  if (input.backend === 'postgres' && !input.connectionString) {
    throw new Error('connectionString is required for the postgres backend');
  }
};

/**
 * Benchmark public Core commands and queries omitted by the main operations
 * track. Timings contain only one command/query bus execution; concrete
 * persisted readbacks and round cleanup are deliberately outside the sample.
 */
export async function runCoreExtraBench(input: RunCoreExtraBenchInput): Promise<CoreExtraBenchRun> {
  validateInput(input);
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const measurements = makeMeasurements(CORE_EXTRA_CASES);
  let runtime: IHeadlessRuntime | undefined;

  try {
    runtime = await createRuntimeForBackend({
      backend: input.backend,
      ...(input.connectionString ? { connectionString: input.connectionString } : {}),
    });
    const context = createContext();
    for (let round = 0; round < input.warmup; round += 1) {
      await runRound({
        round,
        measured: false,
        runtime,
        context,
        measurements,
        errors,
      });
    }
    for (let round = 0; round < input.samples; round += 1) {
      await runRound({
        round,
        measured: true,
        runtime,
        context,
        measurements,
        errors,
      });
    }
  } catch (error) {
    if (!(error instanceof RecordedOperationFailure)) {
      errors.push(`Core extra operations benchmark execution failed: ${errorMessage(error)}`);
    }
  } finally {
    if (runtime) {
      try {
        await closeBenchRuntime(runtime);
      } catch (error) {
        errors.push(`Headless runtime cleanup failed: ${errorMessage(error)}`);
      }
    }
  }

  return {
    caseId: CASE_ID,
    operations: CORE_EXTRA_CASES.map(({ key }) => finalizeMeasurement(measurements.get(key)!)),
    correctness: errors.length === 0 ? 'pass' : 'fail',
    errors,
    backend: input.backend,
    startedAt,
    completedAt: new Date().toISOString(),
    commit: resolveBenchCommit(),
    dimensions: {
      transport: 'in-process-core-command-query-bus',
      application: '@teable/v2-core',
      actor: ACTOR_ID,
      samples: input.samples,
      warmup: input.warmup,
      measuredTiming: 'exactly one target command/query bus execution per operation',
      responseValidation: 'domain-result-and-independent-persisted-query-readback',
      isolation:
        input.backend === 'pglite'
          ? 'fresh-memory-runtime-with-scoped-base-cleanup-per-round'
          : 'caller-provided-test-database-with-scoped-base-cleanup-per-round',
      capabilities: [
        'table-get-by-id',
        'table-bulk-create-schema-only-and-seeded',
        'table-properties-update',
        'record-singular-create-get-by-id-and-duplicate',
        'field-bulk-create-delete',
        'field-duplicate-with-values-and-schema-only',
        'table-duplicate-with-records',
      ],
      operationSupportScope: 'requested Core extra operations',
      supportedPublicOperations: CORE_EXTRA_CASES.map(({ identity }) => identity),
      unsupportedPublicOperations: [],
      excludedCapabilities: ['undo', 'redo', 'realtime'],
      workload: {
        bulkFields: BULK_FIELD_COUNT,
        bulkCreatedTables: CREATED_TABLE_COUNT,
        bulkCreatedTableRecords: CREATED_TABLE_RECORD_COUNT,
        sourceRecords: SOURCE_RECORD_COUNT,
        duplicateIncludesRecords: true,
        duplicateFieldIncludesRecordValues: [true, false],
      },
      operationIdentities: Object.fromEntries(
        CORE_EXTRA_CASES.map(({ key, identity }) => [key, identity])
      ),
    },
  };
}
