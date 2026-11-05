import { performance } from 'node:perf_hooks';

import {
  ActorId,
  AggregateTableRecordsQuery,
  type AggregateTableRecordsResult,
  CountTableRecordsQuery,
  type CountTableRecordsResult,
  CreateBaseCommand,
  type CreateBaseResult,
  CreateRecordsStreamCommand,
  type CreateRecordsStreamResult,
  CreateTableCommand,
  type CreateTableResult,
  CreateViewCommand,
  type CreateViewResult,
  ListTableRecordsQuery,
  type ListTableRecordsResult,
  UpdateViewFilterCommand,
  type UpdateViewFilterResult,
  UpdateViewSortCommand,
  type UpdateViewSortResult,
} from '@teable/v2-core';
import type { IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';

import { createRuntimeForBackend } from '../case/loadSteps';
import { cleanupBenchBase, closeBenchRuntime, registerBenchBase } from '../case/runtimeLifecycle';
import type { RunCoreOpsBenchInput } from '../coreOps/runner';
import type { HttpBenchRun } from '../httpBench/runner';
import type { BenchOperationObservation } from '../runner/BenchRunner';
import {
  executeMeasuredReplacingRelation as executeMeasured,
  finalizeMeasurement,
  makeMeasurements,
  RecordedOperationFailure,
  type MutableMeasurement,
  type OperationResult,
  type TimedOperationResult as TimedResult,
} from '../runner/operationMeasurements';
import { resolveBenchCommit } from '../runner/provenance';
import { CORE_QUERY_CASES, type CoreQueryCasesBenchCaseKey } from './cases';

export { CORE_QUERY_CASES, type CoreQueryCasesBenchCase } from './cases';

/** Input deliberately kept identical to the direct Core operations track. */
export type RunCoreQueryCasesBenchInput = RunCoreOpsBenchInput;
export type CoreQueryCasesBenchRun = HttpBenchRun;

type ExecutionContext = { readonly actorId: ActorId };
type Fixture = {
  readonly baseId: string;
  readonly tableId: string;
  readonly viewId: string;
  readonly titleFieldId: string;
  readonly amountFieldId: string;
  readonly categoryFieldId: string;
};
type ExpectedRow = {
  readonly title: string;
  readonly amount: number;
  readonly category: 'alpha' | 'beta' | 'gamma';
};

const CASE_ID = 'headless-core-query-cases';
const ACTOR_ID = 'usr_core_query_cases_bench';
const PAGE_SIZE = 3;
const EXPECTED_ROWS: ReadonlyArray<ExpectedRow> = [
  { title: 'North one', amount: 5, category: 'alpha' },
  { title: 'North two', amount: 10, category: 'alpha' },
  { title: 'South three', amount: 15, category: 'beta' },
  { title: 'North four', amount: 20, category: 'beta' },
  { title: 'West five', amount: 25, category: 'gamma' },
  { title: 'North six', amount: 30, category: 'gamma' },
  { title: 'East seven', amount: 35, category: 'alpha' },
  { title: 'North eight', amount: 40, category: 'beta' },
  { title: 'South nine', amount: 45, category: 'gamma' },
];
const SELECTIVE_TITLES = ['North four', 'North eight'] as const;
const SEARCH_TITLES = ['North one', 'North two', 'North four', 'North six', 'North eight'] as const;
const EXPECTED_AMOUNTS = EXPECTED_ROWS.map(({ amount }) => amount);
const VIEW_DEFAULT_AMOUNTS = [45, 40, 35, 30, 25, 20] as const;

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

const assertArrayEqual = (
  actual: ReadonlyArray<unknown>,
  expected: ReadonlyArray<unknown>,
  message: string
): void => {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
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
  fieldNames: ReadonlyArray<string>
): BenchOperationObservation => ({
  recordIds: recordIds.slice(0, 100),
  recordRelation: 'returned',
  fieldNames: [...fieldNames],
  truncated: recordIds.length > 100,
});

const createContext = (): ExecutionContext => ({
  actorId: unwrap(ActorId.create(ACTOR_ID), 'coreQuery.actor.invalid'),
});

const createFixture = async (
  runtime: IHeadlessRuntime,
  context: ExecutionContext,
  label: string
): Promise<Fixture> => {
  let baseId: string | undefined;
  try {
    const createdBase = unwrap(
      await runtime.commandBus.execute<CreateBaseCommand, CreateBaseResult>(
        context,
        unwrap(
          CreateBaseCommand.create({ name: `Core query cases ${label}` }),
          'coreQuery.fixture.base.invalid'
        )
      ),
      'coreQuery.fixture.base.failed'
    );
    baseId = createdBase.base.id().toString();
    registerBenchBase(runtime, baseId);

    const createdTable = unwrap(
      await runtime.commandBus.execute<CreateTableCommand, CreateTableResult>(
        context,
        unwrap(
          CreateTableCommand.create({
            baseId,
            name: `Query records ${label}`,
            fields: [
              { name: 'Title', type: 'singleLineText', isPrimary: true },
              { name: 'Amount', type: 'number' },
              { name: 'Category', type: 'singleLineText' },
            ],
          }),
          'coreQuery.fixture.table.invalid'
        )
      ),
      'coreQuery.fixture.table.failed'
    );
    const table = createdTable.table;
    const fieldId = (name: string): string => {
      const field = table.getFields().find((candidate) => candidate.name().toString() === name);
      assert(field, `Query fixture table is missing field ${name}`);
      return field.id().toString();
    };
    const tableId = table.id().toString();
    const titleFieldId = fieldId('Title');
    const amountFieldId = fieldId('Amount');
    const categoryFieldId = fieldId('Category');

    const createdRecords = unwrap(
      await runtime.commandBus.execute<CreateRecordsStreamCommand, CreateRecordsStreamResult>(
        context,
        unwrap(
          CreateRecordsStreamCommand.createFromIterable({
            tableId,
            batchSize: PAGE_SIZE,
            records: EXPECTED_ROWS.map(({ title, amount, category }) => ({
              fields: {
                [titleFieldId]: title,
                [amountFieldId]: amount,
                [categoryFieldId]: category,
              },
            })),
          }),
          'coreQuery.fixture.records.invalid'
        )
      ),
      'coreQuery.fixture.records.failed'
    );
    assertEqual(createdRecords.totalCreated, EXPECTED_ROWS.length, 'Query fixture row count');

    const createdView = unwrap(
      await runtime.commandBus.execute<CreateViewCommand, CreateViewResult>(
        context,
        unwrap(
          CreateViewCommand.create({
            tableId,
            view: { type: 'grid', name: `Amount at least twenty ${label}` },
          }),
          'coreQuery.fixture.view.invalid'
        )
      ),
      'coreQuery.fixture.view.failed'
    );
    const viewId = createdView.viewId.toString();
    unwrap(
      await runtime.commandBus.execute<UpdateViewFilterCommand, UpdateViewFilterResult>(
        context,
        unwrap(
          UpdateViewFilterCommand.create({
            tableId,
            viewId,
            filter: {
              conjunction: 'and',
              filterSet: [{ fieldId: amountFieldId, operator: 'isGreaterEqual', value: 20 }],
            },
          }),
          'coreQuery.fixture.view_filter.invalid'
        )
      ),
      'coreQuery.fixture.view_filter.failed'
    );
    unwrap(
      await runtime.commandBus.execute<UpdateViewSortCommand, UpdateViewSortResult>(
        context,
        unwrap(
          UpdateViewSortCommand.create({
            tableId,
            viewId,
            sort: { sortObjs: [{ fieldId: amountFieldId, order: 'desc' }] },
          }),
          'coreQuery.fixture.view_sort.invalid'
        )
      ),
      'coreQuery.fixture.view_sort.failed'
    );

    return { baseId, tableId, viewId, titleFieldId, amountFieldId, categoryFieldId };
  } catch (error) {
    if (baseId) await cleanupBenchBase(runtime, baseId);
    throw error;
  }
};

/**
 * Untimed persisted oracle. It reads the whole fixture with plain offset pages,
 * independently of every timed filter, cursor, group, search, count, aggregate,
 * and view-default query below.
 */
const verifyFixtureOracle = async (
  runtime: IHeadlessRuntime,
  context: ExecutionContext,
  fixture: Fixture
): Promise<ReadonlyMap<string, string>> => {
  const records: ListTableRecordsResult['records'][number][] = [];
  const ids = new Set<string>();
  let offset = 0;
  for (;;) {
    const query = unwrap(
      ListTableRecordsQuery.create({
        tableId: fixture.tableId,
        fieldKeyType: 'id',
        limit: 4,
        offset,
        projection: [fixture.titleFieldId, fixture.amountFieldId, fixture.categoryFieldId],
      }),
      'coreQuery.oracle.invalid'
    );
    const page = unwrap(
      await runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(context, query),
      'coreQuery.oracle.failed'
    );
    for (const record of page.records) {
      assert(!ids.has(record.id), `Persisted oracle returned duplicate record ${record.id}`);
      ids.add(record.id);
      records.push(record);
    }
    offset += page.records.length;
    if (page.records.length < 4) break;
  }

  assertEqual(records.length, EXPECTED_ROWS.length, 'Persisted oracle row count');
  const recordsByTitle = new Map(
    records.map((record) => [String(record.fields[fixture.titleFieldId]), record] as const)
  );
  assertEqual(recordsByTitle.size, EXPECTED_ROWS.length, 'Persisted oracle unique title count');
  const idsByTitle = new Map<string, string>();
  for (const expected of EXPECTED_ROWS) {
    const record = recordsByTitle.get(expected.title);
    assert(record, `Persisted oracle is missing ${expected.title}`);
    assertEqual(record.fields[fixture.amountFieldId], expected.amount, `${expected.title} amount`);
    assertEqual(
      record.fields[fixture.categoryFieldId],
      expected.category,
      `${expected.title} category`
    );
    idsByTitle.set(expected.title, record.id);
  }
  return idsByTitle;
};

const recordTitles = (
  result: ListTableRecordsResult,
  titleFieldId: string
): ReadonlyArray<string> => result.records.map((record) => String(record.fields[titleFieldId]));

const runRound = async (input: {
  round: number;
  measured: boolean;
  runtime: IHeadlessRuntime;
  context: ExecutionContext;
  measurements: Map<CoreQueryCasesBenchCaseKey, MutableMeasurement<CoreQueryCasesBenchCaseKey>>;
  errors: string[];
}): Promise<void> => {
  const measure = <T>(key: CoreQueryCasesBenchCaseKey, action: () => Promise<OperationResult<T>>) =>
    executeMeasured({
      key,
      action,
      measured: input.measured,
      measurements: input.measurements,
      errors: input.errors,
    });
  const label = `${input.measured ? 'sample' : 'warmup'}-${input.round}`;
  let fixture: Fixture | undefined;

  try {
    fixture = await createFixture(input.runtime, input.context, label);
    const { tableId, viewId, titleFieldId, amountFieldId, categoryFieldId } = fixture;
    const idsByTitle = await verifyFixtureOracle(input.runtime, input.context, fixture);

    const empty = await measure('ListTableRecordsQuery(filter-empty)', async () => {
      const query = unwrap(
        ListTableRecordsQuery.create({
          tableId,
          fieldKeyType: 'id',
          limit: 10,
          includeTotal: true,
          filter: { fieldId: amountFieldId, operator: 'isGreater', value: 1_000 },
          projection: [titleFieldId, amountFieldId],
        }),
        'coreQuery.filter_empty.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
            input.context,
            query
          ),
        'coreQuery.filter_empty.failed'
      );
      assertEqual(response.data.records.length, 0, 'Empty filter records');
      assertEqual(response.data.total, 0, 'Empty filter total');
      return { ...response, rowsRead: 0, rowsReturned: 0 };
    });
    assertEqual(empty.records.length, 0, 'Timed empty filter postcondition');
    await verifyFixtureOracle(input.runtime, input.context, fixture);

    const selective = await measure('ListTableRecordsQuery(filter-selective)', async () => {
      const query = unwrap(
        ListTableRecordsQuery.create({
          tableId,
          fieldKeyType: 'id',
          limit: 10,
          includeTotal: true,
          filter: {
            conjunction: 'and',
            items: [
              { fieldId: amountFieldId, operator: 'isGreaterEqual', value: 20 },
              { fieldId: categoryFieldId, operator: 'is', value: 'beta' },
            ],
          },
          sort: [{ fieldId: amountFieldId, order: 'asc' }],
          projection: [titleFieldId, amountFieldId, categoryFieldId],
        }),
        'coreQuery.filter_selective.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
            input.context,
            query
          ),
        'coreQuery.filter_selective.failed'
      );
      assertArrayEqual(
        recordTitles(response.data, titleFieldId),
        SELECTIVE_TITLES,
        'Selective filter titles'
      );
      assertArrayEqual(
        response.data.records.map((record) => record.fields[amountFieldId]),
        [20, 40],
        'Selective filter amounts'
      );
      assertEqual(response.data.total, SELECTIVE_TITLES.length, 'Selective filter total');
      return {
        ...response,
        rowsRead: response.data.records.length,
        rowsReturned: response.data.records.length,
        observation: observation(
          response.data.records.map(({ id }) => id),
          [titleFieldId, amountFieldId, categoryFieldId]
        ),
      };
    });
    assertArrayEqual(recordTitles(selective, titleFieldId), SELECTIVE_TITLES, 'Selective readback');
    await verifyFixtureOracle(input.runtime, input.context, fixture);

    const cursorWalk = await measure('ListTableRecordsQuery(cursor-complete)', async () => {
      const records: ListTableRecordsResult['records'][number][] = [];
      const seenRecordIds = new Set<string>();
      const seenCursors = new Set<string>();
      const pageSizes: number[] = [];
      let cursor: string | undefined;
      let latencyMs = 0;
      for (;;) {
        const query = unwrap(
          ListTableRecordsQuery.create({
            tableId,
            fieldKeyType: 'id',
            limit: PAGE_SIZE,
            includeTotal: true,
            sort: [{ fieldId: amountFieldId, order: 'asc' }],
            projection: [titleFieldId, amountFieldId],
            ...(cursor ? { cursor } : {}),
          }),
          'coreQuery.cursor.invalid'
        );
        const response = await timedResult(
          () =>
            input.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
              input.context,
              query
            ),
          'coreQuery.cursor.failed'
        );
        latencyMs += response.latencyMs;
        const page = response.data;
        assertEqual(page.total, EXPECTED_ROWS.length, 'Cursor page total');
        pageSizes.push(page.records.length);
        for (const record of page.records) {
          assert(!seenRecordIds.has(record.id), `Cursor walk duplicated record ${record.id}`);
          seenRecordIds.add(record.id);
          records.push(record);
        }
        if (!page.nextCursor) {
          assertEqual(page.hasMore, false, 'Terminal cursor page hasMore');
          break;
        }
        assert(page.hasMore, 'Cursor was returned without hasMore');
        assert(!seenCursors.has(page.nextCursor), 'Cursor walk repeated a cursor');
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      assertArrayEqual(pageSizes, [3, 3, 3], 'Complete cursor page sizes');
      assertArrayEqual(
        records.map((record) => record.fields[amountFieldId]),
        EXPECTED_AMOUNTS,
        'Complete cursor amounts'
      );
      assertEqual(records.length, EXPECTED_ROWS.length, 'Complete cursor row count');
      assertEqual(seenRecordIds.size, EXPECTED_ROWS.length, 'Complete cursor unique row count');
      assertArrayEqual(
        [...seenRecordIds].sort(),
        [...idsByTitle.values()].sort(),
        'Complete cursor persisted record ids'
      );
      return {
        data: { records, pageSizes },
        latencyMs,
        rowsRead: records.length,
        rowsReturned: records.length,
        observation: observation(
          records.map(({ id }) => id),
          [titleFieldId, amountFieldId]
        ),
      };
    });
    assertEqual(cursorWalk.records.length, EXPECTED_ROWS.length, 'Cursor walk readback coverage');
    await verifyFixtureOracle(input.runtime, input.context, fixture);

    const grouped = await measure('ListTableRecordsQuery(group-metadata)', async () => {
      const query = unwrap(
        ListTableRecordsQuery.create({
          tableId,
          fieldKeyType: 'id',
          limit: 20,
          includeTotal: true,
          groupBy: [categoryFieldId],
          includeGroups: true,
          projection: [titleFieldId, categoryFieldId],
        }),
        'coreQuery.group_metadata.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
            input.context,
            query
          ),
        'coreQuery.group_metadata.failed'
      );
      assertEqual(response.data.total, EXPECTED_ROWS.length, 'Grouped query total');
      assertEqual(response.data.records.length, EXPECTED_ROWS.length, 'Grouped query record count');
      assertArrayEqual(
        (response.data.appliedGroup ?? []).map(({ fieldId, order }) => [fieldId, order]),
        [[categoryFieldId, 'asc']],
        'Applied group metadata'
      );
      const groupCounts = new Map(
        (response.data.groups ?? []).map(({ fields, count }) => [
          String(fields[categoryFieldId]),
          count,
        ])
      );
      assertEqual(groupCounts.size, 3, 'Grouped metadata bucket count');
      assertEqual(groupCounts.get('alpha'), 3, 'Alpha group count');
      assertEqual(groupCounts.get('beta'), 3, 'Beta group count');
      assertEqual(groupCounts.get('gamma'), 3, 'Gamma group count');
      return {
        ...response,
        rowsRead: response.data.records.length,
        rowsReturned: response.data.records.length,
        observation: observation(
          response.data.records.map(({ id }) => id),
          [titleFieldId, categoryFieldId]
        ),
      };
    });
    assertEqual(grouped.groups?.length, 3, 'Grouped metadata readback');
    await verifyFixtureOracle(input.runtime, input.context, fixture);

    const searched = await measure('ListTableRecordsQuery(search-metadata)', async () => {
      const query = unwrap(
        ListTableRecordsQuery.create({
          tableId,
          fieldKeyType: 'id',
          limit: 20,
          includeTotal: true,
          search: ['North', titleFieldId, true],
          includeSearchMatches: true,
          searchIndexMode: 'matched',
          projection: [titleFieldId],
        }),
        'coreQuery.search_metadata.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
            input.context,
            query
          ),
        'coreQuery.search_metadata.failed'
      );
      assertArrayEqual(
        recordTitles(response.data, titleFieldId),
        SEARCH_TITLES,
        'Search result titles'
      );
      assertEqual(response.data.total, SEARCH_TITLES.length, 'Search result total');
      const matches = response.data.searchMatches ?? [];
      assertEqual(matches.length, SEARCH_TITLES.length, 'Search metadata count');
      assertArrayEqual(
        matches.map(({ index, fieldId, recordId }) => [
          index,
          fieldId.toString(),
          recordId.toString(),
        ]),
        SEARCH_TITLES.map((title, index) => [index + 1, titleFieldId, idsByTitle.get(title)]),
        'Exact search metadata'
      );
      return {
        ...response,
        rowsRead: response.data.records.length,
        rowsReturned: response.data.records.length,
        observation: observation(
          response.data.records.map(({ id }) => id),
          [titleFieldId]
        ),
      };
    });
    assertArrayEqual(recordTitles(searched, titleFieldId), SEARCH_TITLES, 'Search readback');
    await verifyFixtureOracle(input.runtime, input.context, fixture);

    const counted = await measure('CountTableRecordsQuery(selective)', async () => {
      const query = unwrap(
        CountTableRecordsQuery.create({
          tableId,
          fieldKeyType: 'id',
          filter: {
            conjunction: 'and',
            items: [
              { fieldId: amountFieldId, operator: 'isGreaterEqual', value: 20 },
              { fieldId: categoryFieldId, operator: 'is', value: 'beta' },
            ],
          },
        }),
        'coreQuery.count_selective.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<CountTableRecordsQuery, CountTableRecordsResult>(
            input.context,
            query
          ),
        'coreQuery.count_selective.failed'
      );
      assertEqual(response.data.count, SELECTIVE_TITLES.length, 'Selective count');
      return { ...response, rowsRead: response.data.count, rowsReturned: 1 };
    });
    assertEqual(counted.count, SELECTIVE_TITLES.length, 'Selective count readback');
    await verifyFixtureOracle(input.runtime, input.context, fixture);

    const aggregate = await measure('AggregateTableRecordsQuery(grouped)', async () => {
      const query = unwrap(
        AggregateTableRecordsQuery.create({
          tableId,
          fields: [{ fieldId: amountFieldId, statisticFunc: 'sum' }],
          groupBy: [{ fieldId: categoryFieldId, order: 'asc' }],
          ignoreViewQuery: true,
        }),
        'coreQuery.aggregate_grouped.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<AggregateTableRecordsQuery, AggregateTableRecordsResult>(
            input.context,
            query
          ),
        'coreQuery.aggregate_grouped.failed'
      );
      assertArrayEqual(
        response.data.groupBy.map(({ fieldId, order }) => [fieldId.toString(), order]),
        [[categoryFieldId, 'asc']],
        'Grouped aggregate definition'
      );
      const total = response.data.values.find(({ groupValues }) => groupValues === undefined);
      assert(total, 'Grouped aggregate total is missing');
      assertEqual(total.value, 225, 'Grouped aggregate total');
      const groupSums = new Map(
        response.data.values
          .filter(({ groupValues }) => groupValues !== undefined)
          .map(({ groupValues, value }) => [String(groupValues?.[0]), value])
      );
      assertEqual(groupSums.size, 3, 'Grouped aggregate bucket count');
      assertEqual(groupSums.get('alpha'), 50, 'Alpha aggregate sum');
      assertEqual(groupSums.get('beta'), 75, 'Beta aggregate sum');
      assertEqual(groupSums.get('gamma'), 100, 'Gamma aggregate sum');
      return {
        ...response,
        rowsRead: EXPECTED_ROWS.length,
        rowsReturned: response.data.values.length,
      };
    });
    assertEqual(aggregate.values.length, 4, 'Grouped aggregate readback');
    await verifyFixtureOracle(input.runtime, input.context, fixture);

    const viewDefaults = await measure('ListTableRecordsQuery(view-defaults)', async () => {
      const query = unwrap(
        ListTableRecordsQuery.create({
          tableId,
          viewId,
          fieldKeyType: 'id',
          limit: 20,
          includeTotal: true,
          projection: [titleFieldId, amountFieldId],
        }),
        'coreQuery.view_defaults.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
            input.context,
            query
          ),
        'coreQuery.view_defaults.failed'
      );
      assertArrayEqual(
        response.data.records.map((record) => record.fields[amountFieldId]),
        VIEW_DEFAULT_AMOUNTS,
        'View-default filter and sort values'
      );
      assertEqual(response.data.total, VIEW_DEFAULT_AMOUNTS.length, 'View-default total');
      return {
        ...response,
        rowsRead: response.data.records.length,
        rowsReturned: response.data.records.length,
        observation: observation(
          response.data.records.map(({ id }) => id),
          [titleFieldId, amountFieldId]
        ),
      };
    });
    assertArrayEqual(
      viewDefaults.records.map((record) => record.fields[amountFieldId]),
      VIEW_DEFAULT_AMOUNTS,
      'View-default readback'
    );
    await verifyFixtureOracle(input.runtime, input.context, fixture);
  } finally {
    if (fixture) await cleanupBenchBase(input.runtime, fixture.baseId);
  }
};

const validateInput = (input: RunCoreQueryCasesBenchInput): void => {
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
 * Exercise public Core query boundaries with deterministic, isolated fixtures.
 * Timed queries are checked against fixed values and an untimed persisted oracle.
 */
export async function runCoreQueryCasesBench(
  input: RunCoreQueryCasesBenchInput
): Promise<CoreQueryCasesBenchRun> {
  validateInput(input);
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const measurements = makeMeasurements(CORE_QUERY_CASES);
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
      errors.push(`Core query cases benchmark execution failed: ${errorMessage(error)}`);
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
    operations: CORE_QUERY_CASES.map(({ key }) => finalizeMeasurement(measurements.get(key)!)),
    correctness: errors.length === 0 ? 'pass' : 'fail',
    errors,
    backend: input.backend,
    startedAt,
    completedAt: new Date().toISOString(),
    commit: resolveBenchCommit(),
    dimensions: {
      transport: 'in-process-core-query-bus',
      application: '@teable/v2-core',
      actor: ACTOR_ID,
      samples: input.samples,
      warmup: input.warmup,
      fixtureRows: EXPECTED_ROWS.length,
      cursorPageSize: PAGE_SIZE,
      responseValidation: 'fixed-literal-assertions-and-untimed-persisted-offset-oracle',
      isolation:
        input.backend === 'pglite'
          ? 'fresh-memory-runtime-with-benchmark-owned-base-per-round'
          : 'caller-provided-test-database-with-benchmark-owned-base-per-round',
      cleanup: 'benchmark-owned base removed after every warmup and measured round',
      capabilities: [
        'empty-and-selective-record-filters',
        'complete-keyset-cursor-walk',
        'group-count-metadata',
        'search-match-metadata',
        'filtered-record-count',
        'grouped-aggregation',
        'view-filter-and-sort-defaults',
      ],
      unsupported: [
        'dedicated grouped-records query: no public Core query; ListTableRecordsQuery group metadata is covered',
        'dedicated search query: no public Core query; ListTableRecordsQuery search metadata is covered',
        'ids-only sweep: trusted host-only ListTableRecordsQuery option, not public query input',
        'record-index lookup: trusted host-only ListTableRecordsQuery option, not public query input',
        'search access-path selection: host-supplied query option, not public query input',
        'undo: explicitly excluded',
        'redo: explicitly excluded',
        'realtime: explicitly excluded',
      ],
      operationIdentities: Object.fromEntries(
        CORE_QUERY_CASES.map(({ key, identity }) => [key, identity])
      ),
    },
  };
}
