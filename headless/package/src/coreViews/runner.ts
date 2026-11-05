import { performance } from 'node:perf_hooks';

import {
  ActorId,
  CreateBaseCommand,
  type CreateBaseResult,
  CreateRecordsCommand,
  type CreateRecordsResult,
  CreateTableCommand,
  type CreateTableResult,
  CreateViewCommand,
  type CreateViewResult,
  DeleteViewCommand,
  type DeleteViewResult,
  DuplicateViewCommand,
  type DuplicateViewResult,
  GetViewQuery,
  type GetViewResult,
  type GetViewResultView,
  ListTableRecordsQuery,
  type ListTableRecordsResult,
  ListViewsQuery,
  type ListViewsResult,
  RenameViewCommand,
  type RenameViewResult,
  UpdateViewColumnMetaCommand,
  type UpdateViewColumnMetaResult,
  UpdateViewDescriptionCommand,
  type UpdateViewDescriptionResult,
  UpdateViewFilterCommand,
  type UpdateViewFilterResult,
  UpdateViewGroupCommand,
  type UpdateViewGroupResult,
  UpdateViewSortCommand,
  type UpdateViewSortResult,
} from '@teable/v2-core';
import type { IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';

import { canonicalJson } from '../case/canonicalJson';
import { createRuntimeForBackend } from '../case/loadSteps';
import { cleanupBenchBase, closeBenchRuntime, registerBenchBase } from '../case/runtimeLifecycle';
import type { HttpBenchRun } from '../httpBench/runner';
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
import { CORE_VIEWS_CASES, type CoreViewsBenchCaseKey } from './cases';

export { CORE_VIEWS_CASES, type CoreViewsBenchCase } from './cases';

export type RunCoreViewsBenchInput = {
  readonly backend: 'pglite' | 'postgres';
  readonly connectionString?: string;
  readonly samples: number;
  readonly warmup: number;
};

type ExecutionContext = { readonly actorId: ActorId };

type Fixture = {
  readonly baseId: string;
  readonly tableId: string;
  readonly titleFieldId: string;
  readonly amountFieldId: string;
  readonly categoryFieldId: string;
  readonly recordIds: readonly [string, string, string, string];
};

const CASE_ID = 'headless-core-views-v2';
const CASE_IDENTITY_VERSION = 2;
const ACTOR_ID = 'usr_core_views_bench';
const AVAILABLE_UNMEASURED_VIEW_COMMANDS = [
  'UpdateViewOptionsCommand',
  'UpdateViewLockedCommand',
  'UpdateViewOrderCommand',
  'ApplyViewManualSortCommand',
  'EnableViewShareCommand',
  'DisableViewShareCommand',
  'RefreshViewShareIdCommand',
  'UpdateViewShareMetaCommand',
  'UpdateViewPluginStorageCommand',
  'ApplyViewSnapshotCommand',
] as const;
const ABSENT_VIEW_COMMANDS = [
  'UpdateViewCommand: no generic public Core command; use granular commands',
  'RestoreViewCommand: no public Core command',
  'UpdateViewTypeCommand: no public Core command',
] as const;
const ABSENT_VIEW_QUERIES = [
  'GetViewRecordsQuery: no dedicated public Core query; use ListTableRecordsQuery with viewId',
] as const;

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

const assertDeepEqual = (actual: unknown, expected: unknown, message: string): void => {
  const actualJson = canonicalJson(actual);
  const expectedJson = canonicalJson(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, received ${actualJson}`);
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

const createContext = (): ExecutionContext => ({
  actorId: unwrap(ActorId.create(ACTOR_ID), 'coreViews.actor.invalid'),
});

const getView = async (
  runtime: IHeadlessRuntime,
  context: ExecutionContext,
  tableId: string,
  viewId: string
): Promise<GetViewResultView> => {
  const query = unwrap(GetViewQuery.create({ tableId, viewId }), 'coreViews.view.get.invalid');
  return unwrap(
    await runtime.queryBus.execute<GetViewQuery, GetViewResult>(context, query),
    'coreViews.view.get.failed'
  ).view;
};

const listViews = async (
  runtime: IHeadlessRuntime,
  context: ExecutionContext,
  tableId: string
): Promise<ListViewsResult> => {
  const query = unwrap(ListViewsQuery.create({ tableId }), 'coreViews.view.list.invalid');
  return unwrap(
    await runtime.queryBus.execute<ListViewsQuery, ListViewsResult>(context, query),
    'coreViews.view.list.failed'
  );
};

const createFixture = async (
  runtime: IHeadlessRuntime,
  context: ExecutionContext,
  label: string
): Promise<Fixture> => {
  const createdBase = unwrap(
    await runtime.commandBus.execute<CreateBaseCommand, CreateBaseResult>(
      context,
      unwrap(
        CreateBaseCommand.create({ name: `Core Views ${label}` }),
        'coreViews.fixture.base.invalid'
      )
    ),
    'coreViews.fixture.base.failed'
  );
  const baseId = createdBase.base.id().toString();
  registerBenchBase(runtime, baseId);

  const createdTable = unwrap(
    await runtime.commandBus.execute<CreateTableCommand, CreateTableResult>(
      context,
      unwrap(
        CreateTableCommand.create({
          baseId,
          name: `Projects ${label}`,
          fields: [
            { name: 'Title', type: 'singleLineText', isPrimary: true },
            { name: 'Amount', type: 'number' },
            { name: 'Category', type: 'singleLineText' },
          ],
        }),
        'coreViews.fixture.table.invalid'
      )
    ),
    'coreViews.fixture.table.failed'
  );
  const fieldId = (name: string): string => {
    const field = createdTable.table
      .getFields()
      .find((candidate) => candidate.name().toString() === name);
    assert(field, `Fixture table is missing field ${name}`);
    return field.id().toString();
  };
  const tableId = createdTable.table.id().toString();
  const titleFieldId = fieldId('Title');
  const amountFieldId = fieldId('Amount');
  const categoryFieldId = fieldId('Category');
  const createdRecords = unwrap(
    await runtime.commandBus.execute<CreateRecordsCommand, CreateRecordsResult>(
      context,
      unwrap(
        CreateRecordsCommand.create({
          tableId,
          fieldKeyType: 'id',
          typecast: false,
          records: [
            {
              fields: {
                [titleFieldId]: 'Backlog',
                [amountFieldId]: 5,
                [categoryFieldId]: 'Internal',
              },
            },
            {
              fields: {
                [titleFieldId]: 'Build',
                [amountFieldId]: 25,
                [categoryFieldId]: 'External',
              },
            },
            {
              fields: {
                [titleFieldId]: 'Check',
                [amountFieldId]: 15,
                [categoryFieldId]: 'Internal',
              },
            },
            {
              fields: {
                [titleFieldId]: 'Deliver',
                [amountFieldId]: 40,
                [categoryFieldId]: 'External',
              },
            },
          ],
        }),
        'coreViews.fixture.records.invalid'
      )
    ),
    'coreViews.fixture.records.failed'
  );
  assertEqual(createdRecords.records.length, 4, 'Fixture record count');

  return {
    baseId,
    tableId,
    titleFieldId,
    amountFieldId,
    categoryFieldId,
    recordIds: [
      createdRecords.records[0]!.id().toString(),
      createdRecords.records[1]!.id().toString(),
      createdRecords.records[2]!.id().toString(),
      createdRecords.records[3]!.id().toString(),
    ],
  };
};

const runRound = async (input: {
  round: number;
  measured: boolean;
  runtime: IHeadlessRuntime;
  context: ExecutionContext;
  measurements: Map<CoreViewsBenchCaseKey, MutableMeasurement<CoreViewsBenchCaseKey>>;
  errors: string[];
}): Promise<void> => {
  const measure = <T>(key: CoreViewsBenchCaseKey, action: () => Promise<OperationResult<T>>) =>
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
    const { tableId, titleFieldId, amountFieldId, categoryFieldId, recordIds } = fixture;
    const initialName = `Planning ${label}`;

    const created = await measure('CreateViewCommand', async () => {
      const command = unwrap(
        CreateViewCommand.create({ tableId, view: { type: 'grid', name: initialName } }),
        'coreViews.view.create.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<CreateViewCommand, CreateViewResult>(
            input.context,
            command
          ),
        'coreViews.view.create.failed'
      );
      return { ...response, rowsWritten: 1 };
    });
    const viewId = created.viewId.toString();
    const persistedCreated = await getView(input.runtime, input.context, tableId, viewId);
    assertEqual(persistedCreated.name, initialName, 'Persisted created View name');
    assertEqual(persistedCreated.type, 'grid', 'Persisted created View type');

    const listed = await measure('ListViewsQuery', async () => {
      const query = unwrap(ListViewsQuery.create({ tableId }), 'coreViews.view.list.invalid');
      const response = await timedResult(
        () => input.runtime.queryBus.execute<ListViewsQuery, ListViewsResult>(input.context, query),
        'coreViews.view.list.failed'
      );
      return {
        ...response,
        rowsRead: response.data.views.length,
        rowsReturned: response.data.views.length,
      };
    });
    assert(
      listed.views.some((view) => view.id === viewId && view.name === initialName),
      'Created View is absent from timed persisted View list'
    );

    const renamedName = `Delivery ${label}`;
    await measure('RenameViewCommand', async () => {
      const command = unwrap(
        RenameViewCommand.create({ tableId, viewId, name: renamedName }),
        'coreViews.view.rename.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<RenameViewCommand, RenameViewResult>(
            input.context,
            command
          ),
        'coreViews.view.rename.failed'
      );
      return { ...response, rowsWritten: 1 };
    });
    assertEqual(
      (await getView(input.runtime, input.context, tableId, viewId)).name,
      renamedName,
      'Persisted View rename'
    );

    const description = `Projects above budget for ${label}`;
    await measure('UpdateViewDescriptionCommand', async () => {
      const command = unwrap(
        UpdateViewDescriptionCommand.create({ tableId, viewId, description }),
        'coreViews.view.description.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<
            UpdateViewDescriptionCommand,
            UpdateViewDescriptionResult
          >(input.context, command),
        'coreViews.view.description.failed'
      );
      return { ...response, rowsWritten: 1 };
    });
    assertEqual(
      (await getView(input.runtime, input.context, tableId, viewId)).description,
      description,
      'Persisted View description'
    );

    const filter = {
      conjunction: 'and' as const,
      filterSet: [{ fieldId: amountFieldId, operator: 'isGreater' as const, value: 10 }],
    };
    await measure('UpdateViewFilterCommand', async () => {
      const command = unwrap(
        UpdateViewFilterCommand.create({ tableId, viewId, filter }),
        'coreViews.view.filter.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<UpdateViewFilterCommand, UpdateViewFilterResult>(
            input.context,
            command
          ),
        'coreViews.view.filter.failed'
      );
      return { ...response, rowsWritten: 1 };
    });
    assertDeepEqual(
      (await getView(input.runtime, input.context, tableId, viewId)).filter,
      filter,
      'Persisted View filter'
    );

    const sort = { sortObjs: [{ fieldId: amountFieldId, order: 'desc' as const }] };
    await measure('UpdateViewSortCommand', async () => {
      const command = unwrap(
        UpdateViewSortCommand.create({ tableId, viewId, sort }),
        'coreViews.view.sort.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<UpdateViewSortCommand, UpdateViewSortResult>(
            input.context,
            command
          ),
        'coreViews.view.sort.failed'
      );
      return { ...response, rowsWritten: 1 };
    });
    assertDeepEqual(
      (await getView(input.runtime, input.context, tableId, viewId)).sort,
      sort,
      'Persisted View sort'
    );

    const viewRecords = await measure('ListTableRecordsQuery(view-filter-sort)', async () => {
      const query = unwrap(
        ListTableRecordsQuery.create({
          tableId,
          viewId,
          fieldKeyType: 'id',
          limit: 10,
          includeTotal: true,
          projection: [titleFieldId, amountFieldId],
        }),
        'coreViews.view.records.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
            input.context,
            query
          ),
        'coreViews.view.records.failed'
      );
      return {
        ...response,
        rowsRead: response.data.records.length,
        rowsReturned: response.data.records.length,
      };
    });
    assertEqual(viewRecords.total, 3, 'View-filtered record total');
    assertDeepEqual(
      viewRecords.records.map((record) => ({
        id: record.id,
        title: record.fields[titleFieldId],
        amount: record.fields[amountFieldId],
      })),
      [
        { id: recordIds[3], title: 'Deliver', amount: 40 },
        { id: recordIds[1], title: 'Build', amount: 25 },
        { id: recordIds[2], title: 'Check', amount: 15 },
      ],
      'View-filtered and sorted records'
    );

    const group = [{ fieldId: categoryFieldId, order: 'asc' as const }];
    await measure('UpdateViewGroupCommand', async () => {
      const command = unwrap(
        UpdateViewGroupCommand.create({ tableId, viewId, group }),
        'coreViews.view.group.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<UpdateViewGroupCommand, UpdateViewGroupResult>(
            input.context,
            command
          ),
        'coreViews.view.group.failed'
      );
      return { ...response, rowsWritten: 1 };
    });
    assertDeepEqual(
      (await getView(input.runtime, input.context, tableId, viewId)).group,
      group,
      'Persisted View group'
    );

    await measure('UpdateViewColumnMetaCommand', async () => {
      const command = unwrap(
        UpdateViewColumnMetaCommand.create({
          tableId,
          viewId,
          columnMeta: [
            { fieldId: titleFieldId, columnMeta: { width: 320, hidden: false } },
            { fieldId: categoryFieldId, columnMeta: { width: 180, hidden: true } },
          ],
        }),
        'coreViews.view.column_meta.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<UpdateViewColumnMetaCommand, UpdateViewColumnMetaResult>(
            input.context,
            command
          ),
        'coreViews.view.column_meta.failed'
      );
      return { ...response, rowsWritten: 1 };
    });
    const persistedColumnMeta = (await getView(input.runtime, input.context, tableId, viewId))
      .columnMeta;
    assertEqual(persistedColumnMeta[titleFieldId]?.width, 320, 'Persisted Title width');
    assertEqual(persistedColumnMeta[titleFieldId]?.hidden, false, 'Persisted Title visibility');
    assertEqual(persistedColumnMeta[categoryFieldId]?.width, 180, 'Persisted Category width');
    assertEqual(
      persistedColumnMeta[categoryFieldId]?.hidden,
      true,
      'Persisted Category visibility'
    );

    const queriedView = await measure('GetViewQuery', async () => {
      const query = unwrap(
        GetViewQuery.create({ tableId, viewId }),
        'coreViews.view.measured_get.invalid'
      );
      const response = await timedResult(
        () => input.runtime.queryBus.execute<GetViewQuery, GetViewResult>(input.context, query),
        'coreViews.view.measured_get.failed'
      );
      return { ...response, data: response.data.view, rowsRead: 1, rowsReturned: 1 };
    });
    assertDeepEqual(
      {
        id: queriedView.id,
        name: queriedView.name,
        type: queriedView.type,
        description: queriedView.description,
        filter: queriedView.filter,
        sort: queriedView.sort,
        group: queriedView.group,
        titleColumn: queriedView.columnMeta[titleFieldId],
        categoryColumn: queriedView.columnMeta[categoryFieldId],
      },
      {
        id: viewId,
        name: renamedName,
        type: 'grid',
        description,
        filter,
        sort,
        group,
        titleColumn: { order: 0, width: 320, hidden: false },
        categoryColumn: { order: 2, width: 180, hidden: true },
      },
      'Timed GetViewQuery persisted configuration'
    );

    const sourceBeforeDuplicate = await getView(input.runtime, input.context, tableId, viewId);
    const duplicated = await measure('DuplicateViewCommand', async () => {
      const command = unwrap(
        DuplicateViewCommand.create({ tableId, viewId }),
        'coreViews.view.duplicate.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<DuplicateViewCommand, DuplicateViewResult>(
            input.context,
            command
          ),
        'coreViews.view.duplicate.failed'
      );
      return { ...response, rowsWritten: 1 };
    });
    const duplicateViewId = duplicated.viewId.toString();
    assert(duplicateViewId !== viewId, 'Duplicate View reused the source View id');
    const persistedDuplicate = await getView(
      input.runtime,
      input.context,
      tableId,
      duplicateViewId
    );
    assertEqual(
      persistedDuplicate.description,
      sourceBeforeDuplicate.description,
      'Duplicated View description'
    );
    assertDeepEqual(
      persistedDuplicate.filter,
      sourceBeforeDuplicate.filter,
      'Duplicated View filter'
    );
    assertDeepEqual(persistedDuplicate.sort, sourceBeforeDuplicate.sort, 'Duplicated View sort');
    assertDeepEqual(persistedDuplicate.group, sourceBeforeDuplicate.group, 'Duplicated View group');
    assertDeepEqual(
      persistedDuplicate.columnMeta,
      sourceBeforeDuplicate.columnMeta,
      'Duplicated View column metadata'
    );

    await measure('DeleteViewCommand', async () => {
      const command = unwrap(
        DeleteViewCommand.create({ tableId, viewId: duplicateViewId }),
        'coreViews.view.delete.invalid'
      );
      const response = await timedResult(
        () =>
          input.runtime.commandBus.execute<DeleteViewCommand, DeleteViewResult>(
            input.context,
            command
          ),
        'coreViews.view.delete.failed'
      );
      return { ...response, rowsWritten: 1 };
    });
    const persistedViews = await listViews(input.runtime, input.context, tableId);
    assert(
      !persistedViews.views.some((view) => view.id === duplicateViewId),
      'Deleted View remains visible in persisted View list'
    );
    assert(
      persistedViews.views.some((view) => view.id === viewId),
      'Deleting the duplicate also removed the source View'
    );
  } finally {
    if (fixture) await cleanupBenchBase(input.runtime, fixture.baseId);
  }
};

const validateInput = (input: RunCoreViewsBenchInput): void => {
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
 * Benchmark the public Core View lifecycle and view-scoped record read model.
 * Fixture creation and independent persistence postconditions are outside the
 * timed interval. Each warmup and measured sample owns a new base and table.
 */
export async function runCoreViewsBench(input: RunCoreViewsBenchInput): Promise<HttpBenchRun> {
  validateInput(input);
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const measurements = makeMeasurements(CORE_VIEWS_CASES);
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
      errors.push(`Core Views benchmark execution failed: ${errorMessage(error)}`);
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
    operations: CORE_VIEWS_CASES.map(({ key }) => finalizeMeasurement(measurements.get(key)!)),
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
      caseIdentityVersion: CASE_IDENTITY_VERSION,
      responseValidation:
        'exact-command-result-and-query-values-plus-independent-get-view-or-list-views-readback',
      isolation:
        input.backend === 'pglite'
          ? 'fresh-memory-runtime-and-fresh-owned-base-table-per-round'
          : 'caller-provided-test-database-with-fresh-owned-base-table-cleanup-per-round',
      fixtureRecords: 4,
      viewFilteredRecords: 3,
      capabilities: [
        'view-create-get-list-rename-description-duplicate-delete',
        'view-filter-sort-group-column-metadata-update',
        'view-scoped-record-filter-and-sort-read',
      ],
      benchmarkedCommands: CORE_VIEWS_CASES.filter(({ identity }) =>
        identity.endsWith('Command')
      ).map(({ identity }) => identity),
      benchmarkedQueries: CORE_VIEWS_CASES.filter(({ identity }) => identity.endsWith('Query')).map(
        ({ identity }) => identity
      ),
      supportedCommands: [
        ...CORE_VIEWS_CASES.filter(({ identity }) => identity.endsWith('Command')).map(
          ({ identity }) => identity
        ),
        ...AVAILABLE_UNMEASURED_VIEW_COMMANDS,
      ],
      supportedQueries: ['ListViewsQuery', 'GetViewQuery', 'ListTableRecordsQuery'],
      viewRecordReadModel:
        'ListTableRecordsQuery(viewId) applies the persisted View filter and sort',
      untimedPersistenceQueries: [
        'GetViewQuery (after every metadata write)',
        'ListViewsQuery (after delete)',
      ],
      availableUnmeasuredCommands: AVAILABLE_UNMEASURED_VIEW_COMMANDS,
      absentCommands: ABSENT_VIEW_COMMANDS,
      absentQueries: ABSENT_VIEW_QUERIES,
      unsupported: [
        'view-restore: no public Core command',
        'view-type-update: no public Core command',
        'generic view update: no public Core command; use granular commands',
        'dedicated view-record query: no public GetViewRecordsQuery; use ListTableRecordsQuery with viewId',
        'timeline view type: rejected by CreateViewCommand',
        'undo: explicitly excluded',
        'redo: explicitly excluded',
        'realtime: explicitly excluded',
        'view snapshot replay: undo/redo infrastructure, explicitly excluded',
        'share and plugin configuration: host-facing lifecycle, not this metadata benchmark',
      ],
      operationIdentities: Object.fromEntries(
        CORE_VIEWS_CASES.map(({ key, identity }) => [key, identity])
      ),
    },
  };
}
