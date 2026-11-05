import { performance } from 'node:perf_hooks';

import {
  ActorId,
  CreateBaseCommand,
  type CreateBaseResult,
  CreateFieldCommand,
  type CreateFieldResult,
  CreateRecordsCommand,
  type CreateRecordsResult,
  CreateTableCommand,
  type CreateTableResult,
  DeleteRecordsCommand,
  type DeleteRecordsResult,
  ListTableRecordsQuery,
  type ListTableRecordsResult,
  UpdateRecordCommand,
  type UpdateRecordResult,
} from '@teable/v2-core';
import { type IComputedFlushReport, type IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';

import { createRuntimeForBackend } from '../case/loadSteps';
import { cleanupBenchBase, closeBenchRuntime, registerBenchBase } from '../case/runtimeLifecycle';
import type { HttpBenchRun } from '../httpBench/runner';
import { normalizeValue } from '../oracle/normalize';
import type { BenchOperationMeasurement, BenchOperationObservation } from '../runner/BenchRunner';
import {
  executeMeasured as executeOperation,
  finalizeMeasurement,
  makeMeasurements,
  RecordedBenchFailure,
  type MutableMeasurement,
  type OperationResult,
} from '../runner/operationMeasurements';
import { resolveBenchCommit } from '../runner/provenance';

export type RunCoreTransitionsBenchInput = {
  readonly backend: 'pglite' | 'postgres';
  readonly connectionString?: string;
  readonly samples: number;
  readonly warmup: number;
};

export const CORE_TRANSITIONS_OPERATIONS = [
  { key: 'core:CreateRecordsCommand/linked-record', kind: 'write-create' },
  {
    key: 'core:IHeadlessRuntime.flushComputed/linked-record-create',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateRecordCommand/conditional-rollup-enter',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/conditional-rollup-enter',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateRecordCommand/conditional-rollup-leave',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/conditional-rollup-leave',
    kind: 'flush-computed',
  },
  { key: 'core:DeleteRecordsCommand/linked-record', kind: 'write-delete' },
  {
    key: 'core:IHeadlessRuntime.flushComputed/linked-record-delete',
    kind: 'flush-computed',
  },
] as const satisfies ReadonlyArray<{
  readonly key: string;
  readonly kind: BenchOperationMeasurement['kind'];
}>;

type CoreTransitionsOperationKey = (typeof CORE_TRANSITIONS_OPERATIONS)[number]['key'];

type TransitionFixture = {
  readonly runtime: IHeadlessRuntime;
  readonly baseId: string;
  readonly hostRecordId: string;
};

type ExpectedItem = {
  readonly recordId: string;
  readonly status: typeof STATUS_INCLUDED | typeof STATUS_EXCLUDED;
};

const CASE_ID = 'headless-core-transitions-v1';
const CASE_IDENTITY_VERSION = 1;
const ACTOR_ID = 'usr_core_transitions_bench';
const ITEM_TITLE = 'linked-transition-item';
const ITEM_AMOUNT = 17;
const STATUS_INCLUDED = 'included';
const STATUS_EXCLUDED = 'excluded';

const IDS = {
  hostTable: 'tblcoretranshost000',
  hostPrimary: 'fldtranshosttitle00',
  hostConditionalCount: 'fldtranshostcount00',
  itemTable: 'tblcoretransitem000',
  itemPrimary: 'fldtransitemtitle00',
  itemAmount: 'fldtransitemamount0',
  itemStatus: 'fldtransitemstatus0',
  itemHostLink: 'fldtransitemlink000',
} as const;

const unwrap = <T, E>(result: Result<T, E>, label: string): T => {
  if (result.isErr()) throw new Error(`${label}: ${String(result.error)}`);
  return result.value;
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

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    );
  }
};

const assertStringArrayEqual = (
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
  label: string
): void => {
  assertEqual(actual.length, expected.length, `${label} length`);
  for (const [index, value] of expected.entries()) {
    assertEqual(actual[index], value, `${label}[${index}]`);
  }
};

const EXECUTION_CONTEXT = {
  actorId: unwrap(ActorId.create(ACTOR_ID), 'core transitions actor id'),
};

const validateInput = (input: RunCoreTransitionsBenchInput): void => {
  if (!Number.isInteger(input.samples) || input.samples < 1) {
    throw new Error('samples must be a positive integer');
  }
  if (!Number.isInteger(input.warmup) || input.warmup < 0) {
    throw new Error('warmup must be a non-negative integer');
  }
  if (input.backend === 'postgres' && !input.connectionString) {
    throw new Error('connectionString is required for the postgres backend');
  }
};

const assertFullyDrained = (report: IComputedFlushReport, label: string): void => {
  assertEqual(report.drained, true, `${label} drained`);
  assertEqual(report.state, 'no_claimable_work', `${label} state`);
  assertEqual(report.pending, 0, `${label} pending`);
  assertEqual(report.scheduled, 0, `${label} scheduled`);
  assertEqual(report.processing, 0, `${label} processing`);
  assertEqual(report.paused, 0, `${label} paused`);
  assertEqual(report.deadLetter, 0, `${label} dead letter`);
};

const createBase = async (runtime: IHeadlessRuntime, round: number): Promise<string> => {
  const result = unwrap(
    await runtime.commandBus.execute<CreateBaseCommand, CreateBaseResult>(
      EXECUTION_CONTEXT,
      unwrap(
        CreateBaseCommand.create({ name: `Core Transitions Benchmark ${round}` }),
        'create transitions base command'
      )
    ),
    'create transitions base'
  );
  const baseId = result.base.id().toString();
  registerBenchBase(runtime, baseId);
  return baseId;
};

const createTable = async (
  runtime: IHeadlessRuntime,
  input: Parameters<typeof CreateTableCommand.create>[0]
): Promise<string> => {
  const result = unwrap(
    await runtime.commandBus.execute<CreateTableCommand, CreateTableResult>(
      EXECUTION_CONTEXT,
      unwrap(CreateTableCommand.create(input), 'create transitions table command')
    ),
    'create transitions table'
  );
  return result.table.id().toString();
};

const createRecords = async (
  runtime: IHeadlessRuntime,
  tableId: string,
  records: ReadonlyArray<{ readonly fields: Readonly<Record<string, unknown>> }>
): Promise<ReadonlyArray<string>> => {
  const result = unwrap(
    await runtime.commandBus.execute<CreateRecordsCommand, CreateRecordsResult>(
      EXECUTION_CONTEXT,
      unwrap(
        CreateRecordsCommand.create({
          tableId,
          fieldKeyType: 'id',
          typecast: false,
          records,
        }),
        'create transitions records command'
      )
    ),
    'create transitions records'
  );
  assertEqual(result.records.length, records.length, `created record count for ${tableId}`);
  return result.records.map((record) => record.id().toString());
};

const createFixture = async (
  runtime: IHeadlessRuntime,
  baseId: string
): Promise<TransitionFixture> => {
  assertEqual(
    await createTable(runtime, {
      baseId,
      tableId: IDS.hostTable,
      name: 'Transition Hosts',
      fields: [
        {
          id: IDS.hostPrimary,
          name: 'Host',
          type: 'singleLineText',
          isPrimary: true,
        },
      ],
      views: [{ type: 'grid', name: 'Grid' }],
    }),
    IDS.hostTable,
    'host table id'
  );

  assertEqual(
    await createTable(runtime, {
      baseId,
      tableId: IDS.itemTable,
      name: 'Transition Items',
      fields: [
        {
          id: IDS.itemPrimary,
          name: 'Item',
          type: 'singleLineText',
          isPrimary: true,
        },
        { id: IDS.itemAmount, name: 'Amount', type: 'number' },
        { id: IDS.itemStatus, name: 'Status', type: 'singleLineText' },
        {
          id: IDS.itemHostLink,
          name: 'Host Link',
          type: 'link',
          options: {
            relationship: 'manyOne',
            foreignTableId: IDS.hostTable,
            lookupFieldId: IDS.hostPrimary,
            isOneWay: true,
          },
        },
      ],
      views: [{ type: 'grid', name: 'Grid' }],
    }),
    IDS.itemTable,
    'item table id'
  );

  unwrap(
    await runtime.commandBus.execute<CreateFieldCommand, CreateFieldResult>(
      EXECUTION_CONTEXT,
      unwrap(
        CreateFieldCommand.create({
          baseId,
          tableId: IDS.hostTable,
          field: {
            id: IDS.hostConditionalCount,
            name: 'Included Item Count',
            type: 'conditionalRollup',
            options: { expression: 'countall({values})' },
            config: {
              foreignTableId: IDS.itemTable,
              lookupFieldId: IDS.itemAmount,
              condition: {
                filter: {
                  conjunction: 'and',
                  filterSet: [
                    {
                      fieldId: IDS.itemStatus,
                      operator: 'is',
                      value: STATUS_INCLUDED,
                    },
                  ],
                },
              },
            },
          },
        }),
        'create conditional rollup field command'
      )
    ),
    'create conditional rollup field'
  );

  const [hostRecordId] = await createRecords(runtime, IDS.hostTable, [
    { fields: { [IDS.hostPrimary]: 'transition-host' } },
  ]);
  assert(hostRecordId, 'Host record was not created');
  return { runtime, baseId, hostRecordId };
};

const listRecords = async (
  runtime: IHeadlessRuntime,
  tableId: string,
  projection: ReadonlyArray<string>
): Promise<ListTableRecordsResult> =>
  unwrap(
    await runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
      EXECUTION_CONTEXT,
      unwrap(
        ListTableRecordsQuery.create({
          tableId,
          fieldKeyType: 'id',
          limit: 10,
          offset: 0,
          includeTotal: true,
          projection,
        }),
        `list persisted records command for ${tableId}`
      )
    ),
    `list persisted records for ${tableId}`
  );

const linkedRecordIds = (value: unknown): ReadonlyArray<string> => {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];
  return entries.map((entry, index) => {
    if (typeof entry === 'string') return entry;
    assert(
      entry && typeof entry === 'object' && 'id' in entry && typeof entry.id === 'string',
      `Host link entry ${index} does not contain an id`
    );
    return entry.id;
  });
};

const assertFieldKeys = (
  fields: Readonly<Record<string, unknown>>,
  expected: ReadonlyArray<string>,
  label: string
): void => {
  assertStringArrayEqual(Object.keys(fields).sort(), [...expected].sort(), `${label} field keys`);
};

const assertPersistedState = async (
  fixture: TransitionFixture,
  expectedItem: ExpectedItem | undefined,
  expectedConditionalCount: number,
  label: string
): Promise<void> => {
  const hostProjection = [IDS.hostPrimary, IDS.hostConditionalCount];
  const hosts = await listRecords(fixture.runtime, IDS.hostTable, hostProjection);
  assertEqual(hosts.total, 1, `${label} host total`);
  assertEqual(hosts.records.length, 1, `${label} host page size`);
  const host = hosts.records[0]!;
  assertEqual(host.id, fixture.hostRecordId, `${label} host record id`);
  assertFieldKeys(host.fields, hostProjection, `${label} host`);
  assertEqual(host.fields[IDS.hostPrimary], 'transition-host', `${label} host title`);
  assertEqual(
    normalizeValue(host.fields[IDS.hostConditionalCount]),
    expectedConditionalCount,
    `${label} conditional rollup count`
  );

  const itemProjection = [IDS.itemPrimary, IDS.itemAmount, IDS.itemStatus, IDS.itemHostLink];
  const items = await listRecords(fixture.runtime, IDS.itemTable, itemProjection);
  const expectedItemCount = expectedItem ? 1 : 0;
  assertEqual(items.total, expectedItemCount, `${label} item total`);
  assertEqual(items.records.length, expectedItemCount, `${label} item page size`);
  if (!expectedItem) return;

  const item = items.records[0]!;
  assertEqual(item.id, expectedItem.recordId, `${label} item record id`);
  assertFieldKeys(item.fields, itemProjection, `${label} item`);
  assertEqual(item.fields[IDS.itemPrimary], ITEM_TITLE, `${label} item title`);
  assertEqual(normalizeValue(item.fields[IDS.itemAmount]), ITEM_AMOUNT, `${label} item amount`);
  assertEqual(item.fields[IDS.itemStatus], expectedItem.status, `${label} item status`);
  assertStringArrayEqual(
    linkedRecordIds(item.fields[IDS.itemHostLink]),
    [fixture.hostRecordId],
    `${label} host link ids`
  );
};

const updateItemStatus = async (
  fixture: TransitionFixture,
  recordId: string,
  status: ExpectedItem['status']
): Promise<void> => {
  unwrap(
    await fixture.runtime.commandBus.execute<UpdateRecordCommand, UpdateRecordResult>(
      EXECUTION_CONTEXT,
      unwrap(
        UpdateRecordCommand.create({
          tableId: IDS.itemTable,
          recordId,
          fieldKeyType: 'id',
          typecast: false,
          fields: { [IDS.itemStatus]: status },
        }),
        `update item status to ${status} command`
      )
    ),
    `update item status to ${status}`
  );
};

const deleteItem = async (fixture: TransitionFixture, recordId: string): Promise<void> => {
  unwrap(
    await fixture.runtime.commandBus.execute<DeleteRecordsCommand, DeleteRecordsResult>(
      EXECUTION_CONTEXT,
      unwrap(
        DeleteRecordsCommand.create({ tableId: IDS.itemTable, recordIds: [recordId] }),
        'delete linked item command'
      )
    ),
    'delete linked item'
  );
};

const flushAndVerify = async (input: {
  readonly fixture: TransitionFixture;
  readonly expectedItem: ExpectedItem | undefined;
  readonly expectedConditionalCount: number;
  readonly label: string;
}): Promise<OperationResult<IComputedFlushReport>> => {
  const started = performance.now();
  const report = await input.fixture.runtime.flushComputed();
  const latencyMs = performance.now() - started;
  assertFullyDrained(report, `${input.label} computed queue`);
  await assertPersistedState(
    input.fixture,
    input.expectedItem,
    input.expectedConditionalCount,
    input.label
  );
  return { data: report, latencyMs, processed: report.processed };
};

const commandObservation = (
  recordId: string,
  fieldNames: ReadonlyArray<string>
): BenchOperationObservation => ({
  recordIds: [recordId],
  recordRelation: 'command-target',
  fieldNames,
  truncated: false,
});

const runTransitions = async (input: {
  readonly fixture: TransitionFixture;
  readonly measured: boolean;
  readonly measurements: Map<
    CoreTransitionsOperationKey,
    MutableMeasurement<CoreTransitionsOperationKey>
  >;
  readonly errors: string[];
}): Promise<void> => {
  const itemRecordId = await executeOperation({
    key: 'core:CreateRecordsCommand/linked-record',
    measured: input.measured,
    measurements: input.measurements,
    errors: input.errors,
    action: async () => {
      const started = performance.now();
      const [recordId] = await createRecords(input.fixture.runtime, IDS.itemTable, [
        {
          fields: {
            [IDS.itemPrimary]: ITEM_TITLE,
            [IDS.itemAmount]: ITEM_AMOUNT,
            [IDS.itemStatus]: STATUS_EXCLUDED,
            [IDS.itemHostLink]: [{ id: input.fixture.hostRecordId }],
          },
        },
      ]);
      const latencyMs = performance.now() - started;
      assert(recordId, 'Linked transition item was not created');
      return {
        data: recordId,
        latencyMs,
        rowsWritten: 1,
        observation: commandObservation(recordId, [
          IDS.itemPrimary,
          IDS.itemAmount,
          IDS.itemStatus,
          IDS.itemHostLink,
        ]),
      };
    },
  });

  const excludedItem = { recordId: itemRecordId, status: STATUS_EXCLUDED } as const;
  await executeOperation({
    key: 'core:IHeadlessRuntime.flushComputed/linked-record-create',
    measured: input.measured,
    measurements: input.measurements,
    errors: input.errors,
    action: () =>
      flushAndVerify({
        fixture: input.fixture,
        expectedItem: excludedItem,
        expectedConditionalCount: 0,
        label: 'linked record create',
      }),
  });

  await executeOperation({
    key: 'core:UpdateRecordCommand/conditional-rollup-enter',
    measured: input.measured,
    measurements: input.measurements,
    errors: input.errors,
    action: async () => {
      const started = performance.now();
      await updateItemStatus(input.fixture, itemRecordId, STATUS_INCLUDED);
      const latencyMs = performance.now() - started;
      return {
        data: undefined,
        latencyMs,
        rowsWritten: 1,
        observation: commandObservation(itemRecordId, [IDS.itemStatus]),
      };
    },
  });

  await executeOperation({
    key: 'core:IHeadlessRuntime.flushComputed/conditional-rollup-enter',
    measured: input.measured,
    measurements: input.measurements,
    errors: input.errors,
    action: () =>
      flushAndVerify({
        fixture: input.fixture,
        expectedItem: { recordId: itemRecordId, status: STATUS_INCLUDED },
        expectedConditionalCount: 1,
        label: 'conditional rollup membership enter',
      }),
  });

  await executeOperation({
    key: 'core:UpdateRecordCommand/conditional-rollup-leave',
    measured: input.measured,
    measurements: input.measurements,
    errors: input.errors,
    action: async () => {
      const started = performance.now();
      await updateItemStatus(input.fixture, itemRecordId, STATUS_EXCLUDED);
      const latencyMs = performance.now() - started;
      return {
        data: undefined,
        latencyMs,
        rowsWritten: 1,
        observation: commandObservation(itemRecordId, [IDS.itemStatus]),
      };
    },
  });

  await executeOperation({
    key: 'core:IHeadlessRuntime.flushComputed/conditional-rollup-leave',
    measured: input.measured,
    measurements: input.measurements,
    errors: input.errors,
    action: () =>
      flushAndVerify({
        fixture: input.fixture,
        expectedItem: excludedItem,
        expectedConditionalCount: 0,
        label: 'conditional rollup membership leave',
      }),
  });

  await executeOperation({
    key: 'core:DeleteRecordsCommand/linked-record',
    measured: input.measured,
    measurements: input.measurements,
    errors: input.errors,
    action: async () => {
      const started = performance.now();
      await deleteItem(input.fixture, itemRecordId);
      const latencyMs = performance.now() - started;
      return {
        data: undefined,
        latencyMs,
        rowsWritten: 1,
        observation: commandObservation(itemRecordId, []),
      };
    },
  });

  await executeOperation({
    key: 'core:IHeadlessRuntime.flushComputed/linked-record-delete',
    measured: input.measured,
    measurements: input.measurements,
    errors: input.errors,
    action: () =>
      flushAndVerify({
        fixture: input.fixture,
        expectedItem: undefined,
        expectedConditionalCount: 0,
        label: 'linked record delete final empty state',
      }),
  });
};

const runIsolatedRound = async (input: {
  readonly runtime: IHeadlessRuntime;
  readonly round: number;
  readonly measured: boolean;
  readonly measurements: Map<
    CoreTransitionsOperationKey,
    MutableMeasurement<CoreTransitionsOperationKey>
  >;
  readonly errors: string[];
}): Promise<void> => {
  const baseId = await createBase(input.runtime, input.round);
  let roundError: unknown;
  try {
    const fixture = await createFixture(input.runtime, baseId);
    const setupFlush = await input.runtime.flushComputed();
    assertFullyDrained(setupFlush, 'isolated round baseline queue');
    await assertPersistedState(fixture, undefined, 0, 'isolated round baseline');
    await runTransitions({
      fixture,
      measured: input.measured,
      measurements: input.measurements,
      errors: input.errors,
    });
  } catch (error) {
    roundError = error;
    // Preserve the original failure while still attempting scoped cleanup.
  } finally {
    try {
      await cleanupBenchBase(input.runtime, baseId);
    } catch (error) {
      const message = `Core transitions round cleanup failed for ${baseId}: ${errorMessage(error)}`;
      input.errors.push(message);
      if (!roundError) roundError = new RecordedBenchFailure(message);
    }
  }
  if (roundError) throw roundError;
};

/**
 * Measures four state transitions through the public Core command bus and times
 * each transition's computed drain independently. Every drain is followed by
 * an untimed persisted query readback. Every warmup and measured sample owns a
 * fresh base and removes only that registered base after reaching an empty end state.
 */
export async function runCoreTransitionsBench(
  input: RunCoreTransitionsBenchInput
): Promise<HttpBenchRun> {
  validateInput(input);
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const measurements = makeMeasurements(CORE_TRANSITIONS_OPERATIONS);
  let runtime: IHeadlessRuntime | undefined;

  try {
    runtime = await createRuntimeForBackend({
      backend: input.backend,
      ...(input.connectionString ? { connectionString: input.connectionString } : {}),
    });
    let round = 0;
    for (let index = 0; index < input.warmup; index += 1) {
      await runIsolatedRound({
        runtime,
        round: round++,
        measured: false,
        measurements,
        errors,
      });
    }
    for (let index = 0; index < input.samples; index += 1) {
      await runIsolatedRound({
        runtime,
        round: round++,
        measured: true,
        measurements,
        errors,
      });
    }
  } catch (error) {
    if (!(error instanceof RecordedBenchFailure)) {
      errors.push(`Core transitions benchmark execution failed: ${errorMessage(error)}`);
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
    operations: CORE_TRANSITIONS_OPERATIONS.map(({ key }) =>
      finalizeMeasurement(measurements.get(key)!)
    ),
    correctness: errors.length === 0 ? 'pass' : 'fail',
    errors,
    backend: input.backend,
    startedAt,
    completedAt: new Date().toISOString(),
    commit: resolveBenchCommit(),
    dimensions: {
      interface: 'v2-core-command-query-buses',
      runtime: '@teable/v2-headless-runtime',
      samples: input.samples,
      warmup: input.warmup,
      caseIdentityVersion: CASE_IDENTITY_VERSION,
      setupTiming: 'excluded',
      persistedReadbackTiming: 'excluded',
      measuredTiming:
        'four Core mutation commands and their four corresponding flushComputed drains, each timed independently',
      correctnessValidation: 'exact untimed ListTableRecordsQuery readback after every drain',
      sampleIsolation: {
        fixturePerRound: 'fresh registered base with deterministic schema and one host record',
        initialState: 'zero item rows and conditional rollup count 0',
        finalState: 'zero item rows and conditional rollup count 0',
        cleanup: 'cleanupBenchBase removes only the round-owned registered base',
        runtimeReuse: 'one runtime across rounds; no records or bases are reused between samples',
      },
      transitionCoverage: [
        'linked record create: persisted item scalars and exact host link id; rollup remains 0',
        'conditional membership enter: persisted status included; rollup becomes 1',
        'conditional membership leave: persisted status excluded; rollup returns to 0',
        'linked record delete: persisted item table is empty; rollup remains 0',
      ],
      persistedReadback: {
        afterEveryFlush: [
          'computed queue fully drained with no pending, scheduled, processing, paused, or dead-letter work',
          'host row count, id, exact projected field keys, title, and conditional rollup count',
          'item row count, id, exact projected field keys, title, amount, status, and sole host link id',
        ],
        finalEmptyState: { itemRows: 0, conditionalRollupCount: 0 },
      },
      operationIdentities: CORE_TRANSITIONS_OPERATIONS.map(({ key }) => key),
      excludedCapabilities: ['undo', 'redo', 'realtime'],
      isolation:
        input.backend === 'pglite'
          ? 'fresh-memory-runtime-with-owned-base-per-round-cleanup'
          : 'caller-provided-test-database-with-owned-base-per-round-cleanup',
    },
  };
}
