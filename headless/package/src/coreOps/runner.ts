import { performance } from 'node:perf_hooks';

import {
  ActorId,
  AggregateTableRecordsQuery,
  type AggregateTableRecordsResult,
  ClearCommand,
  type ClearResult,
  CreateBaseCommand,
  type CreateBaseResult,
  CreateFieldCommand,
  type CreateFieldResult,
  CreateRecordsStreamCommand,
  type CreateRecordsStreamResult,
  CreateTableCommand,
  type CreateTableResult,
  DeleteByRangeCommand,
  type DeleteByRangeResult,
  DeleteFieldCommand,
  type DeleteFieldResult,
  DeleteTableCommand,
  type DeleteTableResult,
  type Field,
  ImportCsvCommand,
  type ImportCsvResult,
  ImportExcelCommand,
  type ImportExcelResult,
  ListBasesQuery,
  type ListBasesResult,
  ListFieldsQuery,
  type ListFieldsResult,
  ListTableRecordsQuery,
  type ListTableRecordsResult,
  ListTablesQuery,
  type ListTablesResult,
  PasteCommand,
  type PasteResult,
  RenameTableCommand,
  type RenameTableResult,
  type Table,
  UpdateFieldCommand,
  type UpdateFieldResult,
  UpsertRecordsCommand,
  type UpsertRecordsResult,
} from '@teable/v2-core';
import type { IHeadlessRuntime } from '@teable/v2-headless-runtime';
import { strToU8, zipSync } from 'fflate';
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
import { CORE_OPS_CASES, type CoreOpsBenchCaseKey } from './cases';

export { CORE_OPS_CASES, type CoreOpsBenchCase } from './cases';

/** Input shared by standalone benchmark tracks. */
export type RunCoreOpsBenchInput = {
  readonly backend: 'pglite' | 'postgres';
  readonly connectionString?: string;
  readonly samples: number;
  readonly warmup: number;
};

/**
 * The Core operations track intentionally has the same report shape as the
 * loopback HTTP track so CI/reporting can consume either without an adapter.
 */
export type CoreOpsBenchRun = HttpBenchRun;

type ExecutionContext = { readonly actorId: ActorId };

const CASE_ID = 'headless-core-operations-v2';
const ACTOR_ID = 'usr_core_ops_bench';
const STREAM_ROWS = 6;
const EXPECTED_FINAL_ROWS = 5;
const EXPECTED_AGGREGATE_SUM = 515;

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
  actorId: unwrap(ActorId.create(ACTOR_ID), 'coreOps.actor.invalid'),
});

const listTables = async (
  runtime: IHeadlessRuntime,
  context: ExecutionContext,
  baseId: string
): Promise<ListTablesResult> =>
  unwrap(
    await runtime.queryBus.execute<ListTablesQuery, ListTablesResult>(
      context,
      unwrap(ListTablesQuery.create({ baseId }), 'coreOps.table.list.invalid')
    ),
    'coreOps.table.list.failed'
  );

const getTable = async (
  runtime: IHeadlessRuntime,
  context: ExecutionContext,
  baseId: string,
  tableId: string
): Promise<Table> => {
  const listed = await listTables(runtime, context, baseId);
  const table = listed.tables.find((candidate) => candidate.id().toString() === tableId);
  assert(table, `Table ${tableId} is absent from persisted schema`);
  return table;
};

const tableField = (table: Table, name: string): Field => {
  const field = table.getFields().find((candidate) => candidate.name().toString() === name);
  assert(field, `Table ${table.name().toString()} is missing field ${name}`);
  return field;
};

const listRecords = async (
  runtime: IHeadlessRuntime,
  context: ExecutionContext,
  tableId: string,
  extra: Readonly<Record<string, unknown>> = {}
): Promise<ListTableRecordsResult> =>
  unwrap(
    await runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
      context,
      unwrap(
        ListTableRecordsQuery.create({
          tableId,
          fieldKeyType: 'id',
          limit: 1000,
          includeTotal: true,
          ...extra,
        }),
        'coreOps.records.list.invalid'
      )
    ),
    'coreOps.records.list.failed'
  );

const verifyBaseVisible = async (
  runtime: IHeadlessRuntime,
  context: ExecutionContext,
  baseId: string,
  name: string
): Promise<void> => {
  for (let offset = 0; ; offset += 100) {
    const page = unwrap(
      await runtime.queryBus.execute<ListBasesQuery, ListBasesResult>(
        context,
        unwrap(ListBasesQuery.create({ limit: 100, offset }), 'coreOps.base.list.invalid')
      ),
      'coreOps.base.list.failed'
    );
    const found = page.bases.find((base) => base.id().toString() === baseId);
    if (found) {
      assertEqual(found.name().toString(), name, 'Persisted base name');
      return;
    }
    if (offset + page.limit >= page.total) break;
  }
  throw new Error(`Created base ${baseId} is absent from ListBasesQuery`);
};

const xml = (value: string): Uint8Array => strToU8(value);

/** Build a deterministic two-row XLSX fixture without involving a host upload seam. */
const EXCEL_FIXTURE: Uint8Array = zipSync({
  ['[Content_Types].xml']: xml(
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>'
  ),
  ['_rels/.rels']: xml(
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'
  ),
  ['xl/workbook.xml']: xml(
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Items" sheetId="1" r:id="rId1"/></sheets></workbook>'
  ),
  ['xl/_rels/workbook.xml.rels']: xml(
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>'
  ),
  ['xl/worksheets/sheet1.xml']: xml(
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>Excel Alpha</t></is></c><c r="B2"><v>41</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Excel Beta</t></is></c><c r="B3"><v>43</v></c></row>' +
      '</sheetData></worksheet>'
  ),
});

const verifyImportedTable = async (input: {
  runtime: IHeadlessRuntime;
  context: ExecutionContext;
  table: Table;
  expectedValues: ReadonlyArray<readonly [name: string, amount: number]>;
}): Promise<void> => {
  const nameField = tableField(input.table, 'Name');
  const amountField = tableField(input.table, 'Amount');
  assertEqual(nameField.type().toString(), 'singleLineText', 'Imported Name field type');
  assertEqual(amountField.type().toString(), 'number', 'Imported Amount field type');
  const nameId = nameField.id().toString();
  const amountId = amountField.id().toString();
  const records = await listRecords(input.runtime, input.context, input.table.id().toString());
  assertEqual(
    records.total,
    input.expectedValues.length,
    `${input.table.name().toString()} imported row count`
  );
  const values = records.records
    .map((record) => [record.fields[nameId], record.fields[amountId]] as const)
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  for (const [name, amount] of values) {
    assertEqual(typeof name, 'string', `${input.table.name().toString()} imported Name value type`);
    assertEqual(
      typeof amount,
      'number',
      `${input.table.name().toString()} imported Amount value type`
    );
  }
  assertEqual(
    JSON.stringify(values),
    JSON.stringify([...input.expectedValues].sort(([left], [right]) => left.localeCompare(right))),
    `${input.table.name().toString()} imported values`
  );
};

const runRound = async (input: {
  round: number;
  measured: boolean;
  runtime: IHeadlessRuntime;
  context: ExecutionContext;
  measurements: Map<CoreOpsBenchCaseKey, MutableMeasurement<CoreOpsBenchCaseKey>>;
  errors: string[];
}): Promise<void> => {
  const measure = <T>(key: CoreOpsBenchCaseKey, action: () => Promise<OperationResult<T>>) =>
    executeMeasured({
      key,
      action,
      measured: input.measured,
      measurements: input.measurements,
      errors: input.errors,
    });
  const label = `${input.measured ? 'sample' : 'warmup'}-${input.round}`;
  const baseName = `Core operations ${label}`;
  let baseId: string | undefined;

  try {
    const createdBase = await measure('CreateBaseCommand', async () => {
      const command = unwrap(
        CreateBaseCommand.create({ name: baseName }),
        'coreOps.base.create.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<CreateBaseCommand, CreateBaseResult>(
            input.context,
            command
          ),
        'coreOps.base.create.failed'
      );
      baseId = response.data.base.id().toString();
      registerBenchBase(input.runtime, baseId);
      assertEqual(response.data.base.name().toString(), baseName, 'Created base name');
      return { ...response, rowsWritten: 1 };
    });
    baseId = createdBase.base.id().toString();

    await measure('ListBasesQuery', async () => {
      const query = unwrap(
        ListBasesQuery.create({ limit: 100, offset: 0 }),
        'coreOps.base.list.invalid'
      );
      const response = await timedResult(
        () => input.runtime.queryBus.execute<ListBasesQuery, ListBasesResult>(input.context, query),
        'coreOps.base.list.failed'
      );
      return {
        ...response,
        rowsRead: response.data.bases.length,
        rowsReturned: response.data.bases.length,
      };
    });
    await verifyBaseVisible(input.runtime, input.context, baseId, baseName);

    const createdTable = await measure('CreateTableCommand', async () => {
      const command = unwrap(
        CreateTableCommand.create({
          baseId,
          name: `Items ${label}`,
          fields: [
            { name: 'Name', type: 'singleLineText', isPrimary: true },
            { name: 'Key', type: 'singleLineText', unique: true },
            { name: 'Amount', type: 'number' },
            { name: 'Convertible', type: 'singleLineText' },
            { name: 'Temp', type: 'longText' },
          ],
        }),
        'coreOps.table.create.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<CreateTableCommand, CreateTableResult>(
            input.context,
            command
          ),
        'coreOps.table.create.failed'
      );
      assertEqual(response.data.table.getFields().length, 5, 'Created table field count');
      return { ...response, rowsWritten: 1 };
    });
    const tableId = createdTable.table.id().toString();

    await measure('ListTablesQuery', async () => {
      const query = unwrap(ListTablesQuery.create({ baseId }), 'coreOps.table.list.invalid');
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<ListTablesQuery, ListTablesResult>(input.context, query),
        'coreOps.table.list.failed'
      );
      assert(
        response.data.tables.some((table) => table.id().toString() === tableId),
        'Created table is absent from ListTablesQuery'
      );
      return {
        ...response,
        rowsRead: response.data.tables.length,
        rowsReturned: response.data.tables.length,
      };
    });

    const renamedTableName = `Renamed Items ${label}`;
    await measure('RenameTableCommand', async () => {
      const command = unwrap(
        RenameTableCommand.create({ baseId, tableId, name: renamedTableName }),
        'coreOps.table.rename.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<RenameTableCommand, RenameTableResult>(
            input.context,
            command
          ),
        'coreOps.table.rename.failed'
      );
      assertEqual(
        response.data.table.name().toString(),
        renamedTableName,
        'Renamed table response'
      );
      return { ...response, rowsWritten: 1 };
    });
    assertEqual(
      (await getTable(input.runtime, input.context, baseId, tableId)).name().toString(),
      renamedTableName,
      'Persisted table rename'
    );

    const createdField = await measure('CreateFieldCommand', async () => {
      const command = unwrap(
        CreateFieldCommand.create({
          baseId,
          tableId,
          field: { name: 'Notes', type: 'longText' },
        }),
        'coreOps.field.create.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<CreateFieldCommand, CreateFieldResult>(
            input.context,
            command
          ),
        'coreOps.field.create.failed'
      );
      tableField(response.data.table, 'Notes');
      return { ...response, rowsWritten: 1 };
    });
    const notesId = tableField(createdField.table, 'Notes').id().toString();
    assertEqual(
      tableField(await getTable(input.runtime, input.context, baseId, tableId), 'Notes')
        .id()
        .toString(),
      notesId,
      'Persisted created field'
    );
    await measure('ListFieldsQuery', async () => {
      const query = unwrap(
        ListFieldsQuery.create({ tableId, fieldIds: [notesId] }),
        'coreOps.field.list.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<ListFieldsQuery, ListFieldsResult>(input.context, query),
        'coreOps.field.list.failed'
      );
      assertEqual(response.data.fields.length, 1, 'Field list result size');
      assertEqual(response.data.fields[0]?.id().toString(), notesId, 'Field list identity');
      return {
        ...response,
        rowsRead: response.data.fields.length,
        rowsReturned: response.data.fields.length,
      };
    });

    await measure('UpdateFieldCommand(rename)', async () => {
      const command = unwrap(
        UpdateFieldCommand.create({
          tableId,
          fieldId: notesId,
          field: { name: 'Details' },
        }),
        'coreOps.field.rename.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<UpdateFieldCommand, UpdateFieldResult>(
            input.context,
            command
          ),
        'coreOps.field.rename.failed'
      );
      tableField(response.data.table, 'Details');
      return { ...response, rowsWritten: 1 };
    });
    const schemaAfterRename = await getTable(input.runtime, input.context, baseId, tableId);
    assert(
      !schemaAfterRename.getFields().some((field) => field.name().toString() === 'Notes'),
      'Old field name remains after rename'
    );

    const nameId = tableField(schemaAfterRename, 'Name').id().toString();
    const keyId = tableField(schemaAfterRename, 'Key').id().toString();
    const amountId = tableField(schemaAfterRename, 'Amount').id().toString();
    const convertibleId = tableField(schemaAfterRename, 'Convertible').id().toString();
    const tempId = tableField(schemaAfterRename, 'Temp').id().toString();
    const detailsId = tableField(schemaAfterRename, 'Details').id().toString();
    const viewId = unwrap(schemaAfterRename.defaultView(), 'coreOps.table.default_view.missing')
      .id()
      .toString();

    await measure('CreateRecordsStreamCommand', async () => {
      const command = unwrap(
        CreateRecordsStreamCommand.createFromIterable({
          tableId,
          batchSize: 2,
          records: Array.from({ length: STREAM_ROWS }, (_, index) => ({
            fields: {
              [nameId]: `Item ${index + 1}`,
              [keyId]: `K${index + 1}`,
              [amountId]: index + 1,
              [convertibleId]: String((index + 1) * 10),
              [tempId]: `temporary-${index + 1}`,
              [detailsId]: `detail-${index + 1}`,
            },
          })),
        }),
        'coreOps.records.stream.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<CreateRecordsStreamCommand, CreateRecordsStreamResult>(
            input.context,
            command
          ),
        'coreOps.records.stream.failed'
      );
      assertEqual(response.data.totalCreated, STREAM_ROWS, 'Stream-created row count');
      return { ...response, rowsWritten: response.data.totalCreated };
    });
    assertEqual(
      (await listRecords(input.runtime, input.context, tableId)).total,
      STREAM_ROWS,
      'Persisted stream-created row count'
    );

    await measure('UpdateFieldCommand(convert-populated)', async () => {
      const command = unwrap(
        UpdateFieldCommand.create({
          tableId,
          fieldId: convertibleId,
          field: { type: 'number' },
        }),
        'coreOps.field.convert.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<UpdateFieldCommand, UpdateFieldResult>(
            input.context,
            command
          ),
        'coreOps.field.convert.failed'
      );
      assertEqual(
        tableField(response.data.table, 'Convertible').type().toString(),
        'number',
        'Converted field type'
      );
      return { ...response, rowsWritten: STREAM_ROWS };
    });
    const convertedSchema = await getTable(input.runtime, input.context, baseId, tableId);
    assertEqual(
      tableField(convertedSchema, 'Convertible').type().toString(),
      'number',
      'Persisted converted field type'
    );
    const convertedRecords = await listRecords(input.runtime, input.context, tableId);
    assertEqual(convertedRecords.total, STREAM_ROWS, 'Conversion preserved row count');
    for (const record of convertedRecords.records) {
      const key = String(record.fields[keyId]);
      const sequence = Number(key.slice(1));
      assert(Number.isInteger(sequence) && sequence >= 1, `Unexpected converted-row key ${key}`);
      assertEqual(
        record.fields[convertibleId],
        sequence * 10,
        `Converted populated value for ${key}`
      );
    }
    const convertedRecordIdsByKey = new Map(
      convertedRecords.records.map((record) => [String(record.fields[keyId]), record.id])
    );
    assertEqual(convertedRecordIdsByKey.size, STREAM_ROWS, 'Converted record identity coverage');

    const pasteResult = await measure('PasteCommand', async () => {
      const command = unwrap(
        PasteCommand.create({
          tableId,
          viewId,
          ranges: [
            [0, 0],
            [1, 1],
          ],
          projection: [nameId, amountId],
          content: [
            ['Pasted Alpha', 101],
            ['Pasted Beta', 102],
          ],
        }),
        'coreOps.paste.invalid'
      );
      const response = await timedResult(
        () => input.runtime.commandBus.execute<PasteCommand, PasteResult>(input.context, command),
        'coreOps.paste.failed'
      );
      assertEqual(response.data.updatedCount, 2, 'Paste updated row count');
      assertEqual(response.data.createdCount, 0, 'Paste unexpectedly created rows');
      return { ...response, rowsWritten: response.data.updatedCount };
    });
    const pasted = await listRecords(input.runtime, input.context, tableId, {
      search: ['Pasted', nameId, true],
    });
    assertEqual(pasted.total, 2, 'Persisted pasted rows');
    assertEqual(pasteResult.createdCount, 0, 'Paste result postcondition');

    const clearResult = await measure('ClearCommand', async () => {
      const command = unwrap(
        ClearCommand.create({
          tableId,
          viewId,
          ranges: [
            [0, 0],
            [0, 1],
          ],
          projection: [detailsId],
        }),
        'coreOps.clear.invalid'
      );
      const response = await timedResult(
        () => input.runtime.commandBus.execute<ClearCommand, ClearResult>(input.context, command),
        'coreOps.clear.failed'
      );
      assertEqual(response.data.updatedCount, 2, 'Clear updated row count');
      return { ...response, rowsWritten: response.data.updatedCount };
    });
    const afterClear = await listRecords(input.runtime, input.context, tableId, {
      search: ['Pasted', nameId, true],
    });
    assertEqual(afterClear.records.length, 2, 'Cleared record readback coverage');
    for (const record of afterClear.records) {
      assert(
        record.fields[detailsId] == null,
        `Cleared field ${detailsId} retained a value on ${record.id}`
      );
    }
    assertEqual(clearResult.updatedCount, 2, 'Clear result postcondition');

    const upsert = await measure('UpsertRecordsCommand', async () => {
      const command = unwrap(
        UpsertRecordsCommand.create({
          tableId,
          matchField: keyId,
          onConflict: 'update',
          typecast: false,
          fieldKeyType: 'id',
          records: [
            { fields: { [keyId]: 'K3', [nameId]: 'Upserted Existing', [amountId]: 303 } },
            {
              fields: {
                [keyId]: 'K7',
                [nameId]: 'Upserted New',
                [amountId]: 707,
                [convertibleId]: 70,
              },
            },
          ],
        }),
        'coreOps.upsert.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<UpsertRecordsCommand, UpsertRecordsResult>(
            input.context,
            command
          ),
        'coreOps.upsert.failed'
      );
      assertEqual(response.data.summary.updated, 1, 'Upsert updated count');
      assertEqual(response.data.summary.created, 1, 'Upsert created count');
      return {
        ...response,
        rowsWritten: response.data.summary.updated + response.data.summary.created,
        observation: observation(
          response.data.results.flatMap((result) =>
            result.recordId === undefined ? [] : [result.recordId]
          ),
          'command-target',
          [keyId, nameId, amountId]
        ),
      };
    });
    assertEqual(
      (await listRecords(input.runtime, input.context, tableId)).total,
      STREAM_ROWS + 1,
      'Persisted row count after upsert'
    );
    assertEqual(upsert.summary.updated, 1, 'Upsert summary postcondition');

    const deletedRange = await measure('DeleteByRangeCommand', async () => {
      const command = unwrap(
        DeleteByRangeCommand.create({
          tableId,
          viewId,
          type: 'rows',
          ranges: [[5, 6]],
          ignoreViewQuery: true,
        }),
        'coreOps.delete_range.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<DeleteByRangeCommand, DeleteByRangeResult>(
            input.context,
            command
          ),
        'coreOps.delete_range.failed'
      );
      assertEqual(response.data.deletedCount, 2, 'Delete-range row count');
      return {
        ...response,
        rowsWritten: response.data.deletedCount,
        observation: observation(response.data.deletedRecordIds, 'command-target', []),
      };
    });
    const afterDelete = await listRecords(input.runtime, input.context, tableId);
    assertEqual(afterDelete.total, EXPECTED_FINAL_ROWS, 'Persisted delete-range row count');
    const remainingIds = new Set(afterDelete.records.map((record) => record.id));
    for (const id of deletedRange.deletedRecordIds) {
      assert(!remainingIds.has(id), `Delete-range record ${id} remains visible`);
    }

    await measure('ListTableRecordsQuery(page)', async () => {
      const query = unwrap(
        ListTableRecordsQuery.create({
          tableId,
          fieldKeyType: 'id',
          limit: 3,
          offset: 1,
          includeTotal: true,
          projection: [nameId, amountId],
          sort: [
            { fieldId: amountId, order: 'asc' },
            { fieldId: nameId, order: 'asc' },
          ],
        }),
        'coreOps.records.page.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
            input.context,
            query
          ),
        'coreOps.records.page.failed'
      );
      assertEqual(response.data.records.length, 3, 'Paged query result size');
      assertEqual(response.data.total, EXPECTED_FINAL_ROWS, 'Paged query total');
      const expectedPage = [
        { id: convertedRecordIdsByKey.get('K5'), name: 'Item 5', amount: 5 },
        { id: convertedRecordIdsByKey.get('K1'), name: 'Pasted Alpha', amount: 101 },
        { id: convertedRecordIdsByKey.get('K2'), name: 'Pasted Beta', amount: 102 },
      ];
      assert(
        expectedPage.every(({ id }) => id !== undefined),
        'Paged query expected record identity is missing'
      );
      assertEqual(
        JSON.stringify(
          response.data.records.map((record) => ({
            id: record.id,
            name: record.fields[nameId],
            amount: record.fields[amountId],
          }))
        ),
        JSON.stringify(expectedPage),
        'Paged query ordered records'
      );
      return {
        ...response,
        rowsRead: response.data.records.length,
        rowsReturned: response.data.records.length,
        observation: observation(
          response.data.records.map((record) => record.id),
          'returned',
          [nameId, amountId]
        ),
      };
    });

    await measure('ListTableRecordsQuery(filter)', async () => {
      const query = unwrap(
        ListTableRecordsQuery.create({
          tableId,
          fieldKeyType: 'id',
          limit: 10,
          filter: { fieldId: amountId, operator: 'isGreaterEqual', value: 100 },
          projection: [nameId, amountId],
        }),
        'coreOps.records.filter.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
            input.context,
            query
          ),
        'coreOps.records.filter.failed'
      );
      const amounts = response.data.records
        .map((record) => Number(record.fields[amountId]))
        .sort((left, right) => left - right);
      assertEqual(JSON.stringify(amounts), JSON.stringify([101, 102, 303]), 'Filtered values');
      return {
        ...response,
        rowsRead: response.data.records.length,
        rowsReturned: response.data.records.length,
        observation: observation(
          response.data.records.map((record) => record.id),
          'returned',
          [nameId, amountId]
        ),
      };
    });

    await measure('ListTableRecordsQuery(sort)', async () => {
      const query = unwrap(
        ListTableRecordsQuery.create({
          tableId,
          fieldKeyType: 'id',
          limit: 10,
          sort: [{ fieldId: amountId, order: 'desc' }],
          projection: [nameId, amountId],
        }),
        'coreOps.records.sort.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
            input.context,
            query
          ),
        'coreOps.records.sort.failed'
      );
      assertEqual(
        JSON.stringify(response.data.records.map((record) => record.fields[amountId])),
        JSON.stringify([303, 102, 101, 5, 4]),
        'Sorted values'
      );
      return {
        ...response,
        rowsRead: response.data.records.length,
        rowsReturned: response.data.records.length,
        observation: observation(
          response.data.records.map((record) => record.id),
          'returned',
          [nameId, amountId]
        ),
      };
    });

    await measure('ListTableRecordsQuery(search)', async () => {
      const query = unwrap(
        ListTableRecordsQuery.create({
          tableId,
          fieldKeyType: 'id',
          limit: 10,
          search: ['Pasted', nameId, true],
          projection: [nameId],
          includeTotal: true,
        }),
        'coreOps.records.search.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
            input.context,
            query
          ),
        'coreOps.records.search.failed'
      );
      assertEqual(response.data.records.length, 2, 'Search result size');
      return {
        ...response,
        rowsRead: response.data.records.length,
        rowsReturned: response.data.records.length,
        observation: observation(
          response.data.records.map((record) => record.id),
          'returned',
          [nameId]
        ),
      };
    });

    await measure('AggregateTableRecordsQuery', async () => {
      const query = unwrap(
        AggregateTableRecordsQuery.create({
          tableId,
          fields: [{ fieldId: amountId, statisticFunc: 'sum' }],
          ignoreViewQuery: true,
        }),
        'coreOps.records.aggregate.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<AggregateTableRecordsQuery, AggregateTableRecordsResult>(
            input.context,
            query
          ),
        'coreOps.records.aggregate.failed'
      );
      const sum = response.data.values.find(
        (value) => value.fieldId.toString() === amountId && value.statisticFunc === 'sum'
      );
      assert(sum, 'Aggregate sum result is missing');
      assertEqual(sum.value, EXPECTED_AGGREGATE_SUM, 'Aggregate sum');
      return {
        ...response,
        rowsRead: EXPECTED_FINAL_ROWS,
        rowsReturned: response.data.values.length,
      };
    });
    const finalRecords = await listRecords(input.runtime, input.context, tableId);
    const expectedFinal: Readonly<
      Record<string, readonly [string, number, number, string | null]>
    > = {
      K1: ['Pasted Alpha', 101, 10, null],
      K2: ['Pasted Beta', 102, 20, null],
      K3: ['Upserted Existing', 303, 30, 'detail-3'],
      K4: ['Item 4', 4, 40, 'detail-4'],
      K5: ['Item 5', 5, 50, 'detail-5'],
    };
    assertEqual(
      finalRecords.records.length,
      Object.keys(expectedFinal).length,
      'Final-state verification coverage'
    );
    for (const record of finalRecords.records) {
      const key = String(record.fields[keyId]);
      const expected = expectedFinal[key];
      assert(expected, `Unexpected final-state key ${key}`);
      assertEqual(record.fields[nameId], expected[0], `Final name for ${key}`);
      assertEqual(record.fields[amountId], expected[1], `Final amount for ${key}`);
      assertEqual(record.fields[convertibleId], expected[2], `Final converted value for ${key}`);
      assertEqual(record.fields[detailsId] ?? null, expected[3], `Final details for ${key}`);
    }

    const importBaseId = createdBase.base.id().toString();

    const csvImport = await measure('ImportCsvCommand', async () => {
      const command = unwrap(
        ImportCsvCommand.createFromString({
          baseId: importBaseId,
          tableName: `CSV ${label}`,
          csvData: 'Name,Amount\nCSV Alpha,11\nCSV Beta,13\nCSV Gamma,17\n',
          useFirstRowAsHeader: true,
          batchSize: 2,
          columns: [
            { name: 'Name', sourceColumnIndex: 0, type: 'singleLineText' },
            { name: 'Amount', sourceColumnIndex: 1, type: 'number' },
          ],
        }),
        'coreOps.csv_import.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<ImportCsvCommand, ImportCsvResult>(
            input.context,
            command
          ),
        'coreOps.csv_import.failed'
      );
      assertEqual(response.data.totalImported, 3, 'CSV imported row count');
      return { ...response, rowsWritten: response.data.totalImported + 1 };
    });
    await verifyImportedTable({
      runtime: input.runtime,
      context: input.context,
      table: csvImport.table,
      expectedValues: [
        ['CSV Alpha', 11],
        ['CSV Beta', 13],
        ['CSV Gamma', 17],
      ],
    });

    const excelImport = await measure('ImportExcelCommand', async () => {
      const command = unwrap(
        ImportExcelCommand.createFromBuffer({
          baseId: importBaseId,
          tableName: `Excel ${label}`,
          excelData: EXCEL_FIXTURE,
          fileType: 'xlsx',
          sheetName: 'Items',
          useFirstRowAsHeader: true,
          batchSize: 2,
          columns: [
            { name: 'Name', sourceColumnIndex: 0, type: 'singleLineText' },
            { name: 'Amount', sourceColumnIndex: 1, type: 'number' },
          ],
        }),
        'coreOps.excel_import.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<ImportExcelCommand, ImportExcelResult>(
            input.context,
            command
          ),
        'coreOps.excel_import.failed'
      );
      assertEqual(response.data.totalImported, 2, 'Excel imported row count');
      return { ...response, rowsWritten: response.data.totalImported + 1 };
    });
    await verifyImportedTable({
      runtime: input.runtime,
      context: input.context,
      table: excelImport.table,
      expectedValues: [
        ['Excel Alpha', 41],
        ['Excel Beta', 43],
      ],
    });

    await measure('DeleteFieldCommand', async () => {
      const command = unwrap(
        DeleteFieldCommand.create({ baseId, tableId, fieldId: tempId }),
        'coreOps.field.delete.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<DeleteFieldCommand, DeleteFieldResult>(
            input.context,
            command
          ),
        'coreOps.field.delete.failed'
      );
      assert(
        !response.data.table.getFields().some((field) => field.id().toString() === tempId),
        'Deleted field remains in command result'
      );
      return { ...response, rowsWritten: 1 };
    });
    assert(
      !(await getTable(input.runtime, input.context, baseId, tableId))
        .getFields()
        .some((field) => field.id().toString() === tempId),
      'Deleted field remains in persisted schema'
    );

    await measure('DeleteTableCommand', async () => {
      const command = unwrap(
        DeleteTableCommand.create({ baseId, tableId, mode: 'permanent' }),
        'coreOps.table.delete.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<DeleteTableCommand, DeleteTableResult>(
            input.context,
            command
          ),
        'coreOps.table.delete.failed'
      );
      assertEqual(response.data.table.id().toString(), tableId, 'Deleted table response');
      return { ...response, rowsWritten: 1 };
    });
    assert(
      !(await listTables(input.runtime, input.context, baseId)).tables.some(
        (table) => table.id().toString() === tableId
      ),
      'Permanently deleted table remains visible'
    );
  } finally {
    if (baseId) await cleanupBenchBase(input.runtime, baseId);
  }
};

const validateInput = (input: RunCoreOpsBenchInput): void => {
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
 * Benchmark the public Core command/query buses directly. Every timed mutation
 * is followed by an untimed independent query postcondition; every round owns
 * one base and removes it even when an operation or postcondition fails.
 */
export async function runCoreOpsBench(input: RunCoreOpsBenchInput): Promise<CoreOpsBenchRun> {
  validateInput(input);
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const measurements = makeMeasurements(CORE_OPS_CASES);
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
      errors.push(`Core operations benchmark execution failed: ${errorMessage(error)}`);
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
    operations: CORE_OPS_CASES.map(({ key }) => finalizeMeasurement(measurements.get(key)!)),
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
      responseValidation: 'domain-result-and-independent-query-readback',
      isolation:
        input.backend === 'pglite'
          ? 'fresh-memory-runtime-with-scoped-base-cleanup-per-round'
          : 'caller-provided-test-database-with-scoped-base-cleanup-per-round',
      workloadRows: {
        streamCreate: STREAM_ROWS,
        finalMainTable: EXPECTED_FINAL_ROWS,
        csvImport: 3,
        excelImport: 2,
      },
      capabilities: [
        'base-create-list',
        'table-create-list-rename-permanent-delete',
        'field-create-read-rename-convert-populated-delete',
        'record-stream-create',
        'record-paste-clear-delete-range-upsert',
        'record-page-filter-sort-search-aggregation',
        'csv-create-table-import',
        'xlsx-create-table-import',
      ],
      unsupported: [
        'base-update: no public Core command',
        'base-delete: no public Core command; benchmark-owned cleanup is infrastructure-only',
        'undo: explicitly excluded',
        'redo: explicitly excluded',
        'realtime: explicitly excluded',
        'duplicate operations: explicitly excluded',
        'host folder placement: outside Core host boundary',
      ],
      operationIdentities: Object.fromEntries(
        CORE_OPS_CASES.map(({ key, identity }) => [key, identity])
      ),
      excelFixture: 'minimal deterministic Office Open XML workbook',
    },
  };
}
