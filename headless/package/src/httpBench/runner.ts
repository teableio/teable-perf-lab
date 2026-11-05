import { once } from 'node:events';
import { performance } from 'node:perf_hooks';

import { serve, type ServerType } from '@hono/node-server';
import { createHeadlessHttpApp } from '@teable/v2-headless-http';
import type { IHeadlessRuntime } from '@teable/v2-headless-runtime';

import { createRuntimeForBackend } from '../case/loadSteps';
import { cleanupBenchBase, closeBenchRuntime, registerBenchBase } from '../case/runtimeLifecycle';
import type { BenchOperationMeasurement, BenchOperationObservation } from '../runner/BenchRunner';
import {
  executeMeasured,
  finalizeMeasurement,
  makeMeasurements,
  RecordedOperationFailure,
  type MutableMeasurement,
  type OperationResult,
  type TimedOperationResult as HttpResponse,
} from '../runner/operationMeasurements';
import { resolveBenchCommit } from '../runner/provenance';
import {
  HTTP_BENCH_CASE_BY_KEY,
  HTTP_BENCH_CASES,
  type HttpBenchCase,
  type HttpBenchCaseKey,
} from './cases';

export { HTTP_BENCH_CASES, type HttpBenchCase } from './cases';

export type HttpBenchRun = {
  readonly caseId: string;
  readonly operations: ReadonlyArray<BenchOperationMeasurement>;
  readonly correctness: 'pass' | 'fail';
  readonly errors: ReadonlyArray<string>;
  readonly backend: 'pglite' | 'postgres';
  readonly startedAt: string;
  readonly completedAt: string;
  readonly commit: string;
  readonly dimensions: Readonly<Record<string, unknown>>;
};

export type RunHttpBenchInput = {
  readonly backend: 'pglite' | 'postgres';
  readonly connectionString?: string;
  readonly samples: number;
  readonly warmup: number;
};

type ApiError = {
  readonly code?: string;
  readonly message?: string;
  readonly tags?: ReadonlyArray<string>;
};

type ApiEnvelope<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiError };

type FieldDto = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly isPrimary?: boolean;
  readonly description?: string | null;
};

type TableDto = {
  readonly id: string;
  readonly baseId: string;
  readonly name: string;
  readonly fields: ReadonlyArray<FieldDto>;
};

type RecordDto = {
  readonly id: string;
  readonly fields: Readonly<Record<string, unknown>>;
};

type ListRecordsData = {
  readonly records: ReadonlyArray<RecordDto>;
  readonly pagination: {
    readonly total: number;
    readonly offset: number;
    readonly limit: number;
    readonly hasMore: boolean;
    readonly nextCursor?: string;
  };
};

type RequestOptions = {
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
};

const ACTOR_ID = 'usr_http_bench';
const CREATE_BATCH_SIZE = 12;
const CSV_APPEND_ROWS = 3;
const CSV_TABLE_ROWS = 3;
const CASE_ID = 'headless-http-crud-csv-v2';

const requestUrl = (baseUrl: string, route: string, query?: RequestOptions['query']): string => {
  const url = new URL(route, baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(
      key,
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value)
    );
  }
  return url.toString();
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
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

const isEnvelope = <T>(value: unknown): value is ApiEnvelope<T> =>
  typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean';

class LoopbackHttpClient {
  constructor(private readonly baseUrl: string) {}

  async request<T>(
    method: HttpBenchCase['method'],
    route: string,
    expectedStatus: number,
    options: RequestOptions = {}
  ): Promise<HttpResponse<T>> {
    const headers = new Headers();
    headers.set('x-teable-actor', ACTOR_ID);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const started = performance.now();
    const response = await fetch(requestUrl(this.baseUrl, route, options.query), {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new Error(
        `${method} ${route} returned non-JSON status ${response.status}: ${errorMessage(error)}`
      );
    }
    const latencyMs = performance.now() - started;
    if (!isEnvelope<T>(json)) {
      throw new Error(`${method} ${route} returned an invalid JSON envelope`);
    }
    if (response.status !== expectedStatus || !json.ok) {
      const apiError = json.ok ? undefined : json.error;
      throw new Error(
        `${method} ${route} expected HTTP ${expectedStatus}, received ${response.status}` +
          (apiError
            ? ` (${apiError.code ?? 'unknown'}: ${apiError.message ?? 'unknown error'})`
            : '')
      );
    }
    return { data: json.data, latencyMs };
  }

  timed<T>(key: HttpBenchCaseKey, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    const benchCase = HTTP_BENCH_CASE_BY_KEY.get(key);
    assert(benchCase, `Missing HTTP benchmark case ${key}`);
    return this.request<T>(benchCase.method, benchCase.route, benchCase.expectedStatus, options);
  }

  get<T>(route: string, query: Readonly<Record<string, unknown>>): Promise<HttpResponse<T>> {
    return this.request<T>('GET', route, 200, { query });
  }
}

const closeServer = async (server: ServerType): Promise<void> => {
  if (!server.listening) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  if ('closeIdleConnections' in server) server.closeIdleConnections();
  await promise;
};

type StartedLoopbackServer = {
  readonly client: LoopbackHttpClient;
  readonly server: ServerType;
};

const startLoopbackServer = async (runtime: IHeadlessRuntime): Promise<StartedLoopbackServer> => {
  const app = createHeadlessHttpApp(runtime);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string', 'Loopback HTTP server did not bind a TCP port');
  return {
    client: new LoopbackHttpClient(`http://127.0.0.1:${address.port}`),
    server,
  };
};

const observation = (
  recordIds: ReadonlyArray<string>,
  recordRelation: BenchOperationObservation['recordRelation'],
  fieldNames: ReadonlyArray<string>
): BenchOperationObservation => ({
  recordIds,
  recordRelation,
  fieldNames,
  truncated: false,
});

const listRecords = async (
  client: LoopbackHttpClient,
  tableId: string,
  extra: Readonly<Record<string, unknown>> = {}
): Promise<ListRecordsData> =>
  (
    await client.get<ListRecordsData>('/tables/listRecords', {
      tableId,
      fieldKeyType: 'id',
      limit: 100,
      ...extra,
    })
  ).data;

const tableField = (table: TableDto, name: string): FieldDto => {
  const field = table.fields.find((candidate) => candidate.name === name);
  assert(field, `Table ${table.name} is missing field ${name}`);
  return field;
};

const verifyImportedTable = async (client: LoopbackHttpClient, table: TableDto): Promise<void> => {
  const nameField = tableField(table, 'Name');
  const amountField = tableField(table, 'Amount');
  assertEqual(nameField.isPrimary, true, 'Imported Name field must be primary');
  assertEqual(amountField.type, 'number', 'Imported Amount field must be numeric');
  const listed = await listRecords(client, table.id);
  assertEqual(listed.pagination.total, CSV_TABLE_ROWS, 'New-table CSV persisted row count');
  const values = listed.records
    .map((record) => [record.fields[nameField.id], record.fields[amountField.id]] as const)
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  assertEqual(
    JSON.stringify(values),
    JSON.stringify([
      ['CSV Newline Name', 17],
      ['Gamma, Incorporated', 11],
      ['Omega', 13],
    ]),
    'New-table CSV persisted values'
  );
};

const verifyMainTable = async (input: {
  client: LoopbackHttpClient;
  baseId: string;
  tableId: string;
  renamedTable: string;
  nameFieldId: string;
  amountFieldId: string;
  formulaFieldId: string;
  deletedRecordIds: ReadonlyArray<string>;
  deletedFieldId: string;
}): Promise<void> => {
  const tableData = (
    await input.client.get<{ table: TableDto }>('/tables/get', {
      baseId: input.baseId,
      tableId: input.tableId,
    })
  ).data;
  assertEqual(tableData.table.name, input.renamedTable, 'Renamed table was not persisted');
  assert(
    !tableData.table.fields.some((field) => field.id === input.deletedFieldId),
    'Deleted field is still present in persisted schema'
  );

  const listed = await listRecords(input.client, input.tableId);
  assertEqual(listed.pagination.total, 14, 'Final main-table row count');
  const remainingIds = new Set(listed.records.map(({ id }) => id));
  for (const deletedId of input.deletedRecordIds) {
    assert(!remainingIds.has(deletedId), `Deleted record ${deletedId} is still persisted`);
  }

  const expected = new Map<string, readonly [number, number]>([
    ['Initial', [101, 202]],
    ['Batch 2', [200, 400]],
    ['Batch 3', [200, 400]],
    ['Batch 4', [24, 48]],
    ['Batch 5', [25, 50]],
    ['Batch 6', [26, 52]],
    ['Batch 7', [27, 54]],
    ['Batch 8', [28, 56]],
    ['Batch 9', [29, 58]],
    ['Batch 10', [30, 60]],
    ['Batch 11', [31, 62]],
    ['CSV, Alpha', [7, 14]],
    ['CSV Beta', [9, 18]],
    ['CSV Plain', [15, 30]],
  ]);
  assertEqual(listed.records.length, expected.size, 'Persisted record verification coverage');
  for (const record of listed.records) {
    const name = String(record.fields[input.nameFieldId]);
    const values = expected.get(name);
    assert(values, `Unexpected persisted record ${name}`);
    assertEqual(record.fields[input.amountFieldId], values[0], `Persisted amount for ${name}`);
    assertEqual(record.fields[input.formulaFieldId], values[1], `Computed value for ${name}`);
  }
};

const verifyBaseVisible = async (
  client: LoopbackHttpClient,
  baseId: string,
  expectedName: string
): Promise<void> => {
  let offset = 0;
  for (;;) {
    const page = (
      await client.get<{
        bases: ReadonlyArray<{ id: string; name: string }>;
        pagination: { total: number; limit: number; offset: number };
      }>('/bases/list', { limit: 100, offset })
    ).data;
    const base = page.bases.find(({ id }) => id === baseId);
    if (base) {
      assertEqual(base.name, expectedName, 'Created base name was not persisted');
      return;
    }
    offset += page.pagination.limit;
    assert(offset < page.pagination.total, `Created base ${baseId} is absent from /bases/list`);
  }
};

const runRound = async (input: {
  round: number;
  measured: boolean;
  runtime: IHeadlessRuntime;
  client: LoopbackHttpClient;
  measurements: Map<HttpBenchCaseKey, MutableMeasurement<HttpBenchCaseKey>>;
  errors: string[];
}): Promise<void> => {
  const measure = <T>(key: HttpBenchCaseKey, action: () => Promise<OperationResult<T>>) =>
    executeMeasured({
      key,
      action,
      measured: input.measured,
      measurements: input.measurements,
      errors: input.errors,
    });
  const roundLabel = `${input.measured ? 'sample' : 'warmup'}-${input.round}`;
  const baseName = `HTTP benchmark ${roundLabel}`;
  const renamedTable = `Items ${roundLabel} verified`;
  const fieldSuffix = `${input.measured ? 's' : 'w'}${input.round.toString(36)}`;
  const nameFieldId = `fldHttpName${fieldSuffix}`;
  const amountFieldId = `fldHttpAmount${fieldSuffix}`;
  const formulaFieldId = `fldHttpDouble${fieldSuffix}`;
  const notesFieldId = `fldHttpNotes${fieldSuffix}`;

  const createdBase = await measure('POST /bases/create', async () => {
    const response = await input.client.timed<{ base: { id: string; name: string } }>(
      'POST /bases/create',
      { body: { name: baseName } }
    );
    assert(response.data.base.id, 'Base create response is missing an id');
    assertEqual(response.data.base.name, baseName, 'Base create response name');
    return { ...response, rowsWritten: 1 };
  });
  const baseId = createdBase.base.id;
  registerBenchBase(input.runtime, baseId);

  await measure('GET /bases/list', async () => {
    const response = await input.client.timed<{
      bases: ReadonlyArray<{ id: string; name: string }>;
      pagination: { total: number };
    }>('GET /bases/list', { query: { limit: 100 } });
    assert(response.data.pagination.total >= 1, 'Base list returned an empty persisted state');
    return {
      ...response,
      rowsRead: response.data.bases.length,
      rowsReturned: response.data.bases.length,
    };
  });
  await verifyBaseVisible(input.client, baseId, baseName);

  const createdTable = await measure('POST /tables/create', async () => {
    const response = await input.client.timed<{ table: TableDto }>('POST /tables/create', {
      body: {
        baseId,
        name: `Items ${roundLabel}`,
        fields: [
          { id: nameFieldId, name: 'Name', type: 'singleLineText', isPrimary: true },
          { id: amountFieldId, name: 'Amount', type: 'number' },
          {
            id: formulaFieldId,
            name: 'Double',
            type: 'formula',
            options: { expression: `{${amountFieldId}} * 2` },
          },
        ],
      },
    });
    assertEqual(response.data.table.fields.length, 3, 'Created table field count');
    return { ...response, rowsWritten: 1 };
  });
  const tableId = createdTable.table.id;

  await measure('GET /tables/list', async () => {
    const response = await input.client.timed<{ tables: ReadonlyArray<TableDto> }>(
      'GET /tables/list',
      { query: { baseId } }
    );
    assert(
      response.data.tables.some((table) => table.id === tableId),
      'Created table is absent from table list'
    );
    return {
      ...response,
      rowsRead: response.data.tables.length,
      rowsReturned: response.data.tables.length,
    };
  });

  await measure('POST /tables/rename', async () => {
    const response = await input.client.timed<{ table: TableDto }>('POST /tables/rename', {
      body: { baseId, tableId, name: renamedTable },
    });
    assertEqual(response.data.table.name, renamedTable, 'Renamed table response');
    return { ...response, rowsWritten: 1 };
  });

  await measure('POST /tables/createField', async () => {
    const response = await input.client.timed<{ table: TableDto }>('POST /tables/createField', {
      body: {
        baseId,
        tableId,
        field: { id: notesFieldId, name: 'Notes', type: 'longText' },
      },
    });
    assert(
      response.data.table.fields.some((field) => field.id === notesFieldId),
      'Created field is absent from schema response'
    );
    return { ...response, rowsWritten: 1 };
  });

  await measure('POST /tables/updateField', async () => {
    const response = await input.client.timed<{ table: TableDto }>('POST /tables/updateField', {
      body: {
        tableId,
        fieldId: notesFieldId,
        field: { name: 'Description', description: 'HTTP benchmark mutable field' },
      },
    });
    const updated = response.data.table.fields.find((field) => field.id === notesFieldId);
    assert(updated, 'Updated field is absent from schema response');
    assertEqual(updated.name, 'Description', 'Updated field name');
    assertEqual(updated.description, 'HTTP benchmark mutable field', 'Updated field description');
    return { ...response, rowsWritten: 1 };
  });

  const schemaAfterFieldUpdate = (
    await input.client.get<{ table: TableDto }>('/tables/get', { baseId, tableId })
  ).data.table;
  const persistedDescription = schemaAfterFieldUpdate.fields.find(
    (field) => field.id === notesFieldId
  );
  assert(persistedDescription, 'Updated field is absent from persisted schema');
  assertEqual(persistedDescription.name, 'Description', 'Persisted updated field name');
  assertEqual(
    persistedDescription.description,
    'HTTP benchmark mutable field',
    'Persisted updated field description'
  );

  const createdRecord = await measure('POST /tables/createRecord', async () => {
    const response = await input.client.timed<{ record: RecordDto }>('POST /tables/createRecord', {
      body: {
        tableId,
        fieldKeyType: 'id',
        fields: { [nameFieldId]: 'Initial', [amountFieldId]: 10 },
      },
    });
    assert(response.data.record.id, 'Single-record create response is missing an id');
    return {
      ...response,
      rowsWritten: 1,
      observation: observation([response.data.record.id], 'returned', [nameFieldId, amountFieldId]),
    };
  });

  const createdBatch = await measure('POST /tables/createRecords', async () => {
    const response = await input.client.timed<{ records: ReadonlyArray<RecordDto> }>(
      'POST /tables/createRecords',
      {
        body: {
          tableId,
          fieldKeyType: 'id',
          records: Array.from({ length: CREATE_BATCH_SIZE }, (_, index) => ({
            fields: { [nameFieldId]: `Batch ${index}`, [amountFieldId]: 20 + index },
          })),
        },
      }
    );
    assertEqual(response.data.records.length, CREATE_BATCH_SIZE, 'Batch create response count');
    assertEqual(
      new Set(response.data.records.map(({ id }) => id)).size,
      CREATE_BATCH_SIZE,
      'Batch create record ids must be unique'
    );
    return {
      ...response,
      rowsWritten: response.data.records.length,
      observation: observation(
        response.data.records.map(({ id }) => id),
        'returned',
        [nameFieldId, amountFieldId]
      ),
    };
  });

  await measure('GET /tables/getRecord', async () => {
    const response = await input.client.timed<{ record: RecordDto }>('GET /tables/getRecord', {
      query: { tableId, recordId: createdRecord.record.id },
    });
    assertEqual(response.data.record.fields[nameFieldId], 'Initial', 'Single-record readback name');
    assertEqual(response.data.record.fields[amountFieldId], 10, 'Single-record readback amount');
    return {
      ...response,
      rowsRead: 1,
      rowsReturned: 1,
      observation: observation([response.data.record.id], 'returned', [nameFieldId, amountFieldId]),
    };
  });

  await measure('GET /tables/listRecords?page', async () => {
    const response = await input.client.timed<ListRecordsData>('GET /tables/listRecords?page', {
      query: {
        tableId,
        fieldKeyType: 'id',
        limit: 5,
        offset: 2,
        includeTotal: true,
        projection: [nameFieldId, amountFieldId],
        sort: [
          { fieldId: amountFieldId, order: 'asc' },
          { fieldId: nameFieldId, order: 'asc' },
        ],
      },
    });
    assertEqual(response.data.records.length, 5, 'Offset page response size');
    assertEqual(response.data.pagination.total, 13, 'Offset page total');
    assertEqual(response.data.pagination.hasMore, true, 'Offset page hasMore');
    const expectedPage = createdBatch.records.slice(1, 6).map((record, index) => ({
      id: record.id,
      name: `Batch ${index + 1}`,
      amount: index + 21,
    }));
    assertEqual(
      JSON.stringify(
        response.data.records.map((record) => ({
          id: record.id,
          name: record.fields[nameFieldId],
          amount: record.fields[amountFieldId],
        }))
      ),
      JSON.stringify(expectedPage),
      'Offset page ordered records'
    );
    return {
      ...response,
      rowsRead: response.data.records.length,
      rowsReturned: response.data.records.length,
      observation: observation(
        response.data.records.map(({ id }) => id),
        'returned',
        [nameFieldId, amountFieldId]
      ),
    };
  });

  await measure('GET /tables/listRecords?filter+sort', async () => {
    const response = await input.client.timed<ListRecordsData>(
      'GET /tables/listRecords?filter+sort',
      {
        query: {
          tableId,
          fieldKeyType: 'id',
          limit: 4,
          includeTotal: true,
          filter: { fieldId: amountFieldId, operator: 'isLessEqual', value: 25 },
          sort: [
            { fieldId: amountFieldId, order: 'desc' },
            { fieldId: nameFieldId, order: 'asc' },
          ],
          projection: [nameFieldId, amountFieldId],
        },
      }
    );
    assertEqual(response.data.records.length, 4, 'Filtered page response size');
    assertEqual(response.data.pagination.total, 7, 'Filtered page total');
    const expectedFiltered = [5, 4, 3, 2].map((index) => ({
      id: createdBatch.records[index]!.id,
      name: `Batch ${index}`,
      amount: 20 + index,
    }));
    assertEqual(
      JSON.stringify(
        response.data.records.map((record) => ({
          id: record.id,
          name: record.fields[nameFieldId],
          amount: record.fields[amountFieldId],
        }))
      ),
      JSON.stringify(expectedFiltered),
      'Filtered page ordered records'
    );
    return {
      ...response,
      rowsRead: response.data.records.length,
      rowsReturned: response.data.records.length,
      observation: observation(
        response.data.records.map(({ id }) => id),
        'returned',
        [nameFieldId, amountFieldId]
      ),
    };
  });

  await measure('POST /tables/updateRecord', async () => {
    const response = await input.client.timed<{ record: RecordDto }>('POST /tables/updateRecord', {
      body: {
        tableId,
        recordId: createdRecord.record.id,
        fieldKeyType: 'id',
        fields: { [amountFieldId]: 101 },
      },
    });
    assertEqual(response.data.record.fields[amountFieldId], 101, 'Single-record update response');
    return {
      ...response,
      rowsWritten: 1,
      observation: observation([createdRecord.record.id], 'command-target', [amountFieldId]),
    };
  });

  const bulkUpdateIds = createdBatch.records.slice(0, 4).map(({ id }) => id);
  await measure('POST /tables/updateRecords', async () => {
    const response = await input.client.timed<{ updatedCount: number }>(
      'POST /tables/updateRecords',
      {
        body: {
          tableId,
          fieldKeyType: 'id',
          recordIds: bulkUpdateIds,
          fields: { [amountFieldId]: 200 },
        },
      }
    );
    assertEqual(response.data.updatedCount, bulkUpdateIds.length, 'Batch update response count');
    return {
      ...response,
      rowsWritten: response.data.updatedCount,
      observation: observation(bulkUpdateIds, 'command-target', [amountFieldId]),
    };
  });

  await measure('POST /tables/importRecords', async () => {
    const response = await input.client.timed<{ totalImported: number }>(
      'POST /tables/importRecords',
      {
        body: {
          tableId,
          fileType: 'csv',
          csvData: 'Name,Amount\n"CSV, Alpha",7\n"CSV\nBeta",9\nCSV Plain,15\n',
          sourceColumnMap: { [nameFieldId]: 0, [amountFieldId]: 1 },
          options: { skipFirstNLines: 1, batchSize: 3 },
        },
      }
    );
    assertEqual(response.data.totalImported, CSV_APPEND_ROWS, 'Existing-table CSV import count');
    return { ...response, rowsWritten: response.data.totalImported };
  });

  await measure('POST /runtime/flushComputed', async () => {
    const response = await input.client.timed<{
      processed: number;
      drained: boolean;
      pending: number;
      scheduled: number;
      processing: number;
      paused: number;
      deadLetter: number;
    }>('POST /runtime/flushComputed');
    assertEqual(response.data.drained, true, 'Computed queue must be fully drained');
    assertEqual(response.data.pending, 0, 'Computed queue pending count');
    assertEqual(response.data.scheduled, 0, 'Computed queue scheduled count');
    assertEqual(response.data.processing, 0, 'Computed queue processing count');
    assertEqual(response.data.paused, 0, 'Computed queue paused count');
    assertEqual(response.data.deadLetter, 0, 'Computed queue dead-letter count');
    return { ...response, processed: response.data.processed };
  });

  const importedTable = await measure('POST /tables/importCsv', async () => {
    const response = await input.client.timed<{ table: TableDto; totalImported: number }>(
      'POST /tables/importCsv',
      {
        body: {
          baseId,
          tableName: `CSV table ${roundLabel}`,
          csvData: 'Name,Amount\n"Gamma, Incorporated",11\nOmega,13\n"CSV Newline\nName",17\n',
          useFirstRowAsHeader: true,
          importData: true,
          batchSize: 3,
          columns: [
            { name: 'Name', sourceColumnIndex: 0, type: 'singleLineText' },
            { name: 'Amount', sourceColumnIndex: 1, type: 'number' },
          ],
        },
      }
    );
    assertEqual(response.data.totalImported, CSV_TABLE_ROWS, 'New-table CSV import count');
    assertEqual(response.data.table.fields.length, 2, 'New-table CSV field count');
    return { ...response, rowsWritten: response.data.totalImported };
  });
  await verifyImportedTable(input.client, importedTable.table);

  const deletedRecordIds = createdBatch.records.slice(0, 2).map(({ id }) => id);
  await measure('DELETE /tables/deleteRecords', async () => {
    const response = await input.client.timed<{ deletedRecordIds: ReadonlyArray<string> }>(
      'DELETE /tables/deleteRecords',
      { body: { tableId, recordIds: deletedRecordIds } }
    );
    assertEqual(
      JSON.stringify([...response.data.deletedRecordIds].sort()),
      JSON.stringify([...deletedRecordIds].sort()),
      'Deleted record ids'
    );
    return {
      ...response,
      rowsWritten: response.data.deletedRecordIds.length,
      observation: observation(deletedRecordIds, 'command-target', []),
    };
  });

  await measure('DELETE /tables/deleteField', async () => {
    const response = await input.client.timed<{ table: TableDto }>('DELETE /tables/deleteField', {
      body: { baseId, tableId, fieldId: notesFieldId },
    });
    assert(
      !response.data.table.fields.some((field) => field.id === notesFieldId),
      'Deleted field remains in delete response schema'
    );
    return { ...response, rowsWritten: 1 };
  });

  await verifyMainTable({
    client: input.client,
    baseId,
    tableId,
    renamedTable,
    nameFieldId,
    amountFieldId,
    formulaFieldId,
    deletedRecordIds,
    deletedFieldId: notesFieldId,
  });

  await measure('DELETE /tables/delete', async () => {
    const response = await input.client.timed<unknown>('DELETE /tables/delete', {
      body: { baseId, tableId: importedTable.table.id, mode: 'permanent' },
    });
    return { ...response, rowsWritten: 1 };
  });
  const tablesAfterDelete = (
    await input.client.get<{ tables: ReadonlyArray<TableDto> }>('/tables/list', { baseId })
  ).data.tables;
  assert(
    !tablesAfterDelete.some(({ id }) => id === importedTable.table.id),
    'Permanently deleted CSV table is still visible'
  );
  await cleanupBenchBase(input.runtime, baseId);
};

const validateInput = (input: RunHttpBenchInput): void => {
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

export async function runHttpBench(input: RunHttpBenchInput): Promise<HttpBenchRun> {
  validateInput(input);
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const measurements = makeMeasurements(HTTP_BENCH_CASES);
  let runtime: IHeadlessRuntime | undefined;
  let server: ServerType | undefined;

  try {
    runtime = await createRuntimeForBackend({
      backend: input.backend,
      ...(input.connectionString ? { connectionString: input.connectionString } : {}),
    });
    const started = await startLoopbackServer(runtime);
    server = started.server;

    for (let index = 0; index < input.warmup; index += 1) {
      await runRound({
        round: index,
        measured: false,
        runtime,
        client: started.client,
        measurements,
        errors,
      });
    }
    for (let index = 0; index < input.samples; index += 1) {
      await runRound({
        round: index,
        measured: true,
        runtime,
        client: started.client,
        measurements,
        errors,
      });
    }
  } catch (error) {
    if (!(error instanceof RecordedOperationFailure)) {
      errors.push(`HTTP benchmark execution failed: ${errorMessage(error)}`);
    }
  } finally {
    if (server) {
      try {
        await closeServer(server);
      } catch (error) {
        errors.push(`HTTP listener cleanup failed: ${errorMessage(error)}`);
      }
    }
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
    operations: HTTP_BENCH_CASES.map(({ key }) => finalizeMeasurement(measurements.get(key)!)),
    correctness: errors.length === 0 ? 'pass' : 'fail',
    errors,
    backend: input.backend,
    startedAt,
    completedAt: new Date().toISOString(),
    commit: resolveBenchCommit(),
    dimensions: {
      transport: 'loopback-tcp-http',
      server: '@hono/node-server',
      application: '@teable/v2-headless-http',
      actor: ACTOR_ID,
      samples: input.samples,
      warmup: input.warmup,
      responseValidation: 'status-and-json-envelope',
      persistenceValidation: 'untimed-http-readback',
      isolation:
        input.backend === 'pglite'
          ? 'fresh-memory-runtime-with-scoped-base-cleanup-per-round'
          : 'caller-provided-test-database-with-scoped-base-cleanup-per-round',
      workloadRows: {
        createRecords: CREATE_BATCH_SIZE,
        importRecords: CSV_APPEND_ROWS,
        importCsv: CSV_TABLE_ROWS,
      },
      capabilities: [
        'base-create-list',
        'table-create-list-rename-delete',
        'field-create-update-delete',
        'record-create-read-update-delete',
        'record-batch-create-update-delete',
        'record-filter-sort-offset-page',
        'csv-append-existing-table',
        'csv-create-table',
        'formula-computed-drain',
      ],
      unsupportedOperations: ['base-update', 'base-delete'],
    },
  };
}
