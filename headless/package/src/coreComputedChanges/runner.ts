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
  FormulaField,
  ListFieldsQuery,
  type ListFieldsResult,
  ListTableRecordsQuery,
  type ListTableRecordsResult,
  UpdateFieldCommand,
  type UpdateFieldResult,
  UpdateRecordCommand,
  type UpdateRecordResult,
} from '@teable/v2-core';
import { type IComputedFlushReport, type IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';

import { createRuntimeForBackend } from '../case/loadSteps';
import { cleanupBenchBase, closeBenchRuntime, registerBenchBase } from '../case/runtimeLifecycle';
import type { HttpBenchRun } from '../httpBench/runner';
import { normalizeValue } from '../oracle/normalize';
import type { BenchOperationObservation } from '../runner/BenchRunner';
import {
  executeMeasured as executeOperation,
  finalizeMeasurement,
  makeMeasurements,
  RecordedBenchFailure,
  type MutableMeasurement,
  type OperationResult,
  type TimedOperationResult as TimedResult,
} from '../runner/operationMeasurements';
import { resolveBenchCommit } from '../runner/provenance';
import { CORE_COMPUTED_CHANGES_CASES, type CoreComputedChangesBenchCaseKey } from './cases';

export { CORE_COMPUTED_CHANGES_CASES, type CoreComputedChangesBenchCase } from './cases';

export type RunCoreComputedChangesBenchInput = {
  readonly backend: 'pglite' | 'postgres';
  readonly connectionString?: string;
  readonly samples: number;
  readonly warmup: number;
};

type ExecutionContext = { readonly actorId: ActorId };
type SourceRecord = {
  readonly id: string;
  readonly title: string;
  readonly amount: number;
};
type ComputedChangesFixture = {
  readonly runtime: IHeadlessRuntime;
  readonly baseId: string;
  readonly sources: readonly [SourceRecord, SourceRecord];
  readonly hostRecordIds: ReadonlyArray<string>;
  readonly hostSeeds: ReadonlyMap<string, number>;
  readonly selectedHostRecordId: string;
};
type ExpectedPersistedState = {
  readonly formulaExpression?: string;
  readonly formulaMultiplier?: number;
  readonly sourceAAmount: number;
  readonly selectedHostLinked: boolean;
};

const CASE_ID = 'headless-core-computed-changes-v1';
const CASE_IDENTITY_VERSION = 1;
const ACTOR_ID = 'usr_core_computed_changes_bench';
const POPULATED_HOST_ROWS = 64;
const SOURCE_A_INITIAL_AMOUNT = 10;
const SOURCE_A_UPDATED_AMOUNT = 15;
const SOURCE_B_AMOUNT = 20;
const FORMULA_INITIAL_MULTIPLIER = 2;
const FORMULA_UPDATED_MULTIPLIER = 3;

const IDS = {
  sourceTable: 'tblcccccccccccccccc',
  sourcePrimary: 'fldaaaaaaaaaaaaaaaa',
  sourceAmount: 'fldbbbbbbbbbbbbbbbb',
  hostTable: 'tbldddddddddddddddd',
  hostPrimary: 'fldeeeeeeeeeeeeeeee',
  hostSeed: 'fldffffffffffffffff',
  hostLink: 'fldgggggggggggggggg',
  hostLookup: 'fldhhhhhhhhhhhhhhhh',
  hostRollup: 'fldiiiiiiiiiiiiiiii',
  hostFormula: 'fldjjjjjjjjjjjjjjjj',
} as const;

const formulaExpression = (multiplier: number): string => `{${IDS.hostSeed}} * ${multiplier}`;

const unwrap = <T, E>(result: Result<T, E>, code: string): T => {
  if (result.isErr()) throw new Error(`${code}: ${errorMessage(result.error)}`);
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

const assertStringMembers = (
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
  label: string
): void => {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  assertEqual(actualSorted.length, expectedSorted.length, `${label} length`);
  for (const [index, value] of expectedSorted.entries()) {
    assertEqual(actualSorted[index], value, `${label}[${index}]`);
  }
};

const assertNumberMembers = (
  actual: ReadonlyArray<number>,
  expected: ReadonlyArray<number>,
  label: string
): void => {
  const actualSorted = [...actual].sort((left, right) => left - right);
  const expectedSorted = [...expected].sort((left, right) => left - right);
  assertEqual(actualSorted.length, expectedSorted.length, `${label} length`);
  for (const [index, value] of expectedSorted.entries()) {
    assertEqual(actualSorted[index], value, `${label}[${index}]`);
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

const context = (): ExecutionContext => ({
  actorId: unwrap(ActorId.create(ACTOR_ID), 'coreComputedChanges.actor.invalid'),
});

const validateInput = (input: RunCoreComputedChangesBenchInput): void => {
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
      context(),
      unwrap(
        CreateBaseCommand.create({ name: `Core Computed Changes Benchmark ${round}` }),
        'coreComputedChanges.base.create.invalid'
      )
    ),
    'coreComputedChanges.base.create.failed'
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
      context(),
      unwrap(CreateTableCommand.create(input), 'coreComputedChanges.table.create.invalid')
    ),
    'coreComputedChanges.table.create.failed'
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
      context(),
      unwrap(
        CreateRecordsCommand.create({
          tableId,
          fieldKeyType: 'id',
          typecast: false,
          records,
        }),
        'coreComputedChanges.records.create.invalid'
      )
    ),
    'coreComputedChanges.records.create.failed'
  );
  assertEqual(result.records.length, records.length, `created record count for ${tableId}`);
  return result.records.map((record) => record.id().toString());
};

const createFixture = async (
  runtime: IHeadlessRuntime,
  baseId: string
): Promise<ComputedChangesFixture> => {
  assertEqual(
    await createTable(runtime, {
      baseId,
      tableId: IDS.sourceTable,
      name: 'Computed Change Sources',
      fields: [
        {
          id: IDS.sourcePrimary,
          name: 'Source',
          type: 'singleLineText',
          isPrimary: true,
        },
        { id: IDS.sourceAmount, name: 'Amount', type: 'number' },
      ],
      views: [{ type: 'grid', name: 'Grid' }],
    }),
    IDS.sourceTable,
    'source table id'
  );

  assertEqual(
    await createTable(runtime, {
      baseId,
      tableId: IDS.hostTable,
      name: 'Computed Change Hosts',
      fields: [
        {
          id: IDS.hostPrimary,
          name: 'Host',
          type: 'singleLineText',
          isPrimary: true,
        },
        { id: IDS.hostSeed, name: 'Seed', type: 'number' },
        {
          id: IDS.hostLink,
          name: 'Sources',
          type: 'link',
          options: {
            relationship: 'manyMany',
            foreignTableId: IDS.sourceTable,
            lookupFieldId: IDS.sourcePrimary,
            isOneWay: true,
          },
        },
        {
          id: IDS.hostLookup,
          name: 'Source Amounts',
          type: 'lookup',
          options: {
            linkFieldId: IDS.hostLink,
            foreignTableId: IDS.sourceTable,
            lookupFieldId: IDS.sourceAmount,
          },
        },
        {
          id: IDS.hostRollup,
          name: 'Source Total',
          type: 'rollup',
          options: { expression: 'sum({values})' },
          config: {
            linkFieldId: IDS.hostLink,
            foreignTableId: IDS.sourceTable,
            lookupFieldId: IDS.sourceAmount,
          },
        },
      ],
      views: [{ type: 'grid', name: 'Grid' }],
    }),
    IDS.hostTable,
    'host table id'
  );

  const sourceIds = await createRecords(runtime, IDS.sourceTable, [
    {
      fields: {
        [IDS.sourcePrimary]: 'source-a',
        [IDS.sourceAmount]: SOURCE_A_INITIAL_AMOUNT,
      },
    },
    {
      fields: { [IDS.sourcePrimary]: 'source-b', [IDS.sourceAmount]: SOURCE_B_AMOUNT },
    },
  ]);
  const sourceAId = sourceIds[0];
  const sourceBId = sourceIds[1];
  assert(sourceAId && sourceBId, 'Source records were not created');

  const hostSeeds = new Map<string, number>();
  const hostRecordIds = await createRecords(
    runtime,
    IDS.hostTable,
    Array.from({ length: POPULATED_HOST_ROWS }, (_, index) => ({
      fields: {
        [IDS.hostPrimary]: `host-${index.toString().padStart(3, '0')}`,
        [IDS.hostSeed]: index + 1,
        [IDS.hostLink]: [{ id: sourceAId }, { id: sourceBId }],
      },
    }))
  );
  for (const [index, recordId] of hostRecordIds.entries()) {
    hostSeeds.set(recordId, index + 1);
  }
  const selectedHostRecordId = hostRecordIds[0];
  assert(selectedHostRecordId, 'Selected host record was not created');

  const fixture: ComputedChangesFixture = {
    runtime,
    baseId,
    sources: [
      { id: sourceAId, title: 'source-a', amount: SOURCE_A_INITIAL_AMOUNT },
      { id: sourceBId, title: 'source-b', amount: SOURCE_B_AMOUNT },
    ],
    hostRecordIds,
    hostSeeds,
    selectedHostRecordId,
  };
  const setupFlush = await runtime.flushComputed();
  assertFullyDrained(setupFlush, 'computed changes setup queue');
  await assertPersistedState(fixture, {
    sourceAAmount: SOURCE_A_INITIAL_AMOUNT,
    selectedHostLinked: true,
  });
  return fixture;
};

const listRecords = async (
  runtime: IHeadlessRuntime,
  tableId: string,
  projection: ReadonlyArray<string>
): Promise<ListTableRecordsResult> =>
  unwrap(
    await runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
      context(),
      unwrap(
        ListTableRecordsQuery.create({
          tableId,
          fieldKeyType: 'id',
          limit: 100,
          offset: 0,
          includeTotal: true,
          projection,
        }),
        `coreComputedChanges.records.list.invalid:${tableId}`
      )
    ),
    `coreComputedChanges.records.list.failed:${tableId}`
  );

const listFields = async (runtime: IHeadlessRuntime): Promise<ListFieldsResult> =>
  unwrap(
    await runtime.queryBus.execute<ListFieldsQuery, ListFieldsResult>(
      context(),
      unwrap(
        ListFieldsQuery.create({ tableId: IDS.hostTable }),
        'coreComputedChanges.fields.list.invalid'
      )
    ),
    'coreComputedChanges.fields.list.failed'
  );

const numericValue = (value: unknown, label: string): number => {
  const normalized = normalizeValue(value);
  assert(typeof normalized === 'number', `${label}: expected numeric value`);
  return normalized;
};

const numericValues = (value: unknown, label: string): ReadonlyArray<number> => {
  const normalized = normalizeValue(value);
  if (normalized == null) return [];
  const entries = Array.isArray(normalized) ? normalized : [normalized];
  return entries.map((entry, index) => numericValue(entry, `${label}[${index}]`));
};

const linkedRecordIds = (value: unknown, label: string): ReadonlyArray<string> => {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];
  return entries.map((entry, index) => {
    if (typeof entry === 'string') return entry;
    assert(
      entry && typeof entry === 'object' && 'id' in entry && typeof entry.id === 'string',
      `${label}[${index}]: expected linked record id`
    );
    return entry.id;
  });
};

const assertFormulaSchema = async (
  runtime: IHeadlessRuntime,
  expectedExpression: string | undefined
): Promise<void> => {
  const fields = (await listFields(runtime)).fields;
  const formula = fields.find((field) => field.id().toString() === IDS.hostFormula);
  if (expectedExpression == null) {
    assertEqual(formula, undefined, 'baseline formula field');
    return;
  }
  assert(formula instanceof FormulaField, 'Persisted formula field has the wrong type');
  assertEqual(formula.expression().toString(), expectedExpression, 'persisted formula expression');
};

const assertSourceState = async (
  fixture: ComputedChangesFixture,
  sourceAAmount: number
): Promise<void> => {
  const projection = [IDS.sourcePrimary, IDS.sourceAmount];
  const result = await listRecords(fixture.runtime, IDS.sourceTable, projection);
  assertEqual(result.total, fixture.sources.length, 'persisted source total');
  assertEqual(result.records.length, fixture.sources.length, 'persisted source page size');
  const expectedAmounts = new Map([
    [fixture.sources[0].id, sourceAAmount],
    [fixture.sources[1].id, SOURCE_B_AMOUNT],
  ]);
  for (const source of result.records) {
    const expectedAmount = expectedAmounts.get(source.id);
    assert(expectedAmount != null, `Unexpected persisted source ${source.id}`);
    const expectedSource = fixture.sources.find(({ id }) => id === source.id);
    assert(expectedSource, `Missing source fixture for ${source.id}`);
    assertEqual(
      source.fields[IDS.sourcePrimary],
      expectedSource.title,
      `source ${source.id} title`
    );
    assertEqual(
      numericValue(source.fields[IDS.sourceAmount], `source ${source.id} amount`),
      expectedAmount,
      `source ${source.id} amount`
    );
  }
};

const assertHostState = async (
  fixture: ComputedChangesFixture,
  expected: ExpectedPersistedState
): Promise<void> => {
  const projection = [
    IDS.hostPrimary,
    IDS.hostSeed,
    IDS.hostLink,
    IDS.hostLookup,
    IDS.hostRollup,
    ...(expected.formulaMultiplier == null ? [] : [IDS.hostFormula]),
  ];
  const result = await listRecords(fixture.runtime, IDS.hostTable, projection);
  assertEqual(result.total, POPULATED_HOST_ROWS, 'persisted host total');
  assertEqual(result.records.length, POPULATED_HOST_ROWS, 'persisted host page size');
  assertEqual(new Set(result.records.map(({ id }) => id)).size, POPULATED_HOST_ROWS, 'host ids');

  for (const host of result.records) {
    const seed = fixture.hostSeeds.get(host.id);
    assert(seed != null, `Unexpected persisted host ${host.id}`);
    assertEqual(
      host.fields[IDS.hostPrimary],
      `host-${(seed - 1).toString().padStart(3, '0')}`,
      `host ${host.id} title`
    );
    const selectedUnlinked =
      host.id === fixture.selectedHostRecordId && !expected.selectedHostLinked;
    const expectedSourceIds = selectedUnlinked ? [] : fixture.sources.map(({ id }) => id);
    const expectedLookupValues = selectedUnlinked ? [] : [expected.sourceAAmount, SOURCE_B_AMOUNT];
    assertStringMembers(
      linkedRecordIds(host.fields[IDS.hostLink], `host ${host.id} links`),
      expectedSourceIds,
      `host ${host.id} links`
    );
    assertNumberMembers(
      numericValues(host.fields[IDS.hostLookup], `host ${host.id} lookup`),
      expectedLookupValues,
      `host ${host.id} lookup`
    );
    assertEqual(
      numericValue(host.fields[IDS.hostRollup], `host ${host.id} rollup`),
      expectedLookupValues.reduce((sum, value) => sum + value, 0),
      `host ${host.id} rollup`
    );
    assertEqual(
      numericValue(host.fields[IDS.hostSeed], `host ${host.id} seed`),
      seed,
      `host ${host.id} seed`
    );
    if (expected.formulaMultiplier != null) {
      assertEqual(
        numericValue(host.fields[IDS.hostFormula], `host ${host.id} formula`),
        seed * expected.formulaMultiplier,
        `host ${host.id} formula`
      );
    }
  }
};

const assertPersistedState = async (
  fixture: ComputedChangesFixture,
  expected: ExpectedPersistedState
): Promise<void> => {
  assertEqual(
    expected.formulaExpression == null,
    expected.formulaMultiplier == null,
    'formula expectation completeness'
  );
  await assertFormulaSchema(fixture.runtime, expected.formulaExpression);
  await assertSourceState(fixture, expected.sourceAAmount);
  await assertHostState(fixture, expected);
};

const commandObservation = (
  recordId: string,
  fieldNames: ReadonlyArray<string>
): BenchOperationObservation => ({
  recordIds: [recordId],
  recordRelation: 'command-target',
  fieldNames: [...fieldNames],
  truncated: false,
});

const createFormulaField = async (
  fixture: ComputedChangesFixture
): Promise<OperationResult<CreateFieldResult>> => {
  const command = unwrap(
    CreateFieldCommand.create({
      baseId: fixture.baseId,
      tableId: IDS.hostTable,
      field: {
        id: IDS.hostFormula,
        name: 'Scaled Seed',
        type: 'formula',
        options: { expression: formulaExpression(FORMULA_INITIAL_MULTIPLIER) },
      },
    }),
    'coreComputedChanges.formula.create.invalid'
  );
  const response = await timedResult(
    () =>
      fixture.runtime.commandBus.execute<CreateFieldCommand, CreateFieldResult>(context(), command),
    'coreComputedChanges.formula.create.failed'
  );
  const formula = response.data.table
    .getFields()
    .find((field) => field.id().toString() === IDS.hostFormula);
  assert(formula instanceof FormulaField, 'CreateFieldCommand did not return the formula field');
  return { ...response, rowsWritten: POPULATED_HOST_ROWS };
};

const updateFormulaExpression = async (
  fixture: ComputedChangesFixture
): Promise<OperationResult<UpdateFieldResult>> => {
  const command = unwrap(
    UpdateFieldCommand.create({
      tableId: IDS.hostTable,
      fieldId: IDS.hostFormula,
      field: { options: { expression: formulaExpression(FORMULA_UPDATED_MULTIPLIER) } },
    }),
    'coreComputedChanges.formula.update.invalid'
  );
  const response = await timedResult(
    () =>
      fixture.runtime.commandBus.execute<UpdateFieldCommand, UpdateFieldResult>(context(), command),
    'coreComputedChanges.formula.update.failed'
  );
  const formula = response.data.table
    .getFields()
    .find((field) => field.id().toString() === IDS.hostFormula);
  assert(formula instanceof FormulaField, 'UpdateFieldCommand did not return the formula field');
  assertEqual(
    formula.expression().toString(),
    formulaExpression(FORMULA_UPDATED_MULTIPLIER),
    'updated formula command result'
  );
  return { ...response, rowsWritten: POPULATED_HOST_ROWS };
};

const updateRecord = async (input: {
  readonly fixture: ComputedChangesFixture;
  readonly tableId: string;
  readonly recordId: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly label: string;
}): Promise<OperationResult<UpdateRecordResult>> => {
  const command = unwrap(
    UpdateRecordCommand.create({
      tableId: input.tableId,
      recordId: input.recordId,
      fieldKeyType: 'id',
      typecast: false,
      fields: input.fields,
    }),
    `coreComputedChanges.${input.label}.invalid`
  );
  const response = await timedResult(
    () =>
      input.fixture.runtime.commandBus.execute<UpdateRecordCommand, UpdateRecordResult>(
        context(),
        command
      ),
    `coreComputedChanges.${input.label}.failed`
  );
  return {
    ...response,
    rowsWritten: 1,
    observation: commandObservation(input.recordId, Object.keys(input.fields)),
  };
};

const flushAndVerify = async (input: {
  readonly fixture: ComputedChangesFixture;
  readonly expected: ExpectedPersistedState;
  readonly label: string;
}): Promise<OperationResult<IComputedFlushReport>> => {
  const started = performance.now();
  const report = await input.fixture.runtime.flushComputed();
  const latencyMs = performance.now() - started;
  assertFullyDrained(report, `${input.label} computed queue`);
  await assertPersistedState(input.fixture, input.expected);
  return { data: report, latencyMs, processed: report.processed };
};

const runChanges = async (input: {
  readonly fixture: ComputedChangesFixture;
  readonly measured: boolean;
  readonly measurements: Map<
    CoreComputedChangesBenchCaseKey,
    MutableMeasurement<CoreComputedChangesBenchCaseKey>
  >;
  readonly errors: string[];
}): Promise<void> => {
  const execute = <T>(
    key: CoreComputedChangesBenchCaseKey,
    action: () => Promise<OperationResult<T>>
  ): Promise<T> =>
    executeOperation({
      key,
      action,
      measured: input.measured,
      measurements: input.measurements,
      errors: input.errors,
    });

  await execute('core:CreateFieldCommand/formula-populated', () =>
    createFormulaField(input.fixture)
  );
  await execute('core:IHeadlessRuntime.flushComputed/formula-create', () =>
    flushAndVerify({
      fixture: input.fixture,
      label: 'formula create',
      expected: {
        formulaExpression: formulaExpression(FORMULA_INITIAL_MULTIPLIER),
        formulaMultiplier: FORMULA_INITIAL_MULTIPLIER,
        sourceAAmount: SOURCE_A_INITIAL_AMOUNT,
        selectedHostLinked: true,
      },
    })
  );

  await execute('core:UpdateFieldCommand/formula-expression', () =>
    updateFormulaExpression(input.fixture)
  );
  await execute('core:IHeadlessRuntime.flushComputed/formula-expression', () =>
    flushAndVerify({
      fixture: input.fixture,
      label: 'formula expression update',
      expected: {
        formulaExpression: formulaExpression(FORMULA_UPDATED_MULTIPLIER),
        formulaMultiplier: FORMULA_UPDATED_MULTIPLIER,
        sourceAAmount: SOURCE_A_INITIAL_AMOUNT,
        selectedHostLinked: true,
      },
    })
  );

  await execute('core:UpdateRecordCommand/linked-source-update', () =>
    updateRecord({
      fixture: input.fixture,
      tableId: IDS.sourceTable,
      recordId: input.fixture.sources[0].id,
      fields: { [IDS.sourceAmount]: SOURCE_A_UPDATED_AMOUNT },
      label: 'source.update',
    })
  );
  await execute('core:IHeadlessRuntime.flushComputed/linked-source-update', () =>
    flushAndVerify({
      fixture: input.fixture,
      label: 'linked source update',
      expected: {
        formulaExpression: formulaExpression(FORMULA_UPDATED_MULTIPLIER),
        formulaMultiplier: FORMULA_UPDATED_MULTIPLIER,
        sourceAAmount: SOURCE_A_UPDATED_AMOUNT,
        selectedHostLinked: true,
      },
    })
  );

  await execute('core:UpdateRecordCommand/link-unlink', () =>
    updateRecord({
      fixture: input.fixture,
      tableId: IDS.hostTable,
      recordId: input.fixture.selectedHostRecordId,
      fields: { [IDS.hostLink]: [] },
      label: 'link.unlink',
    })
  );
  await execute('core:IHeadlessRuntime.flushComputed/link-unlink', () =>
    flushAndVerify({
      fixture: input.fixture,
      label: 'host unlink',
      expected: {
        formulaExpression: formulaExpression(FORMULA_UPDATED_MULTIPLIER),
        formulaMultiplier: FORMULA_UPDATED_MULTIPLIER,
        sourceAAmount: SOURCE_A_UPDATED_AMOUNT,
        selectedHostLinked: false,
      },
    })
  );

  await execute('core:UpdateRecordCommand/link-relink', () =>
    updateRecord({
      fixture: input.fixture,
      tableId: IDS.hostTable,
      recordId: input.fixture.selectedHostRecordId,
      fields: {
        [IDS.hostLink]: input.fixture.sources.map(({ id }) => ({ id })),
      },
      label: 'link.relink',
    })
  );
  await execute('core:IHeadlessRuntime.flushComputed/link-relink', () =>
    flushAndVerify({
      fixture: input.fixture,
      label: 'host relink',
      expected: {
        formulaExpression: formulaExpression(FORMULA_UPDATED_MULTIPLIER),
        formulaMultiplier: FORMULA_UPDATED_MULTIPLIER,
        sourceAAmount: SOURCE_A_UPDATED_AMOUNT,
        selectedHostLinked: true,
      },
    })
  );
};

const runIsolatedRound = async (input: {
  readonly runtime: IHeadlessRuntime;
  readonly round: number;
  readonly measured: boolean;
  readonly measurements: Map<
    CoreComputedChangesBenchCaseKey,
    MutableMeasurement<CoreComputedChangesBenchCaseKey>
  >;
  readonly errors: string[];
}): Promise<void> => {
  const baseId = await createBase(input.runtime, input.round);
  let roundError: unknown;
  try {
    const fixture = await createFixture(input.runtime, baseId);
    await runChanges({
      fixture,
      measured: input.measured,
      measurements: input.measurements,
      errors: input.errors,
    });
  } catch (error) {
    roundError = error;
  } finally {
    try {
      await cleanupBenchBase(input.runtime, baseId);
    } catch (error) {
      const message = `Core computed changes cleanup failed for ${baseId}: ${errorMessage(error)}`;
      input.errors.push(message);
      if (!roundError) roundError = new RecordedBenchFailure(message);
    }
  }
  if (roundError) throw roundError;
};

/**
 * Benchmarks computed schema changes and linked lookup/rollup invalidation via
 * public Core commands. Every measured command has a separately measured drain;
 * exact schema and record readback remains outside both timings.
 */
export async function runCoreComputedChangesBench(
  input: RunCoreComputedChangesBenchInput
): Promise<HttpBenchRun> {
  validateInput(input);
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const measurements = makeMeasurements(CORE_COMPUTED_CHANGES_CASES);
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
      errors.push(`Core computed changes benchmark execution failed: ${errorMessage(error)}`);
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
    operations: CORE_COMPUTED_CHANGES_CASES.map(({ key }) =>
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
      populatedHostRows: POPULATED_HOST_ROWS,
      linkedSourceRows: 2,
      setupTiming: 'excluded',
      computedDrainTiming: 'measured-separately-from-triggering-command',
      persistedReadbackTiming: 'excluded',
      correctnessValidation:
        'untimed ListFieldsQuery and ListTableRecordsQuery readback after every computed drain',
      sampleIsolation: {
        fixturePerRound:
          'fresh registered base with deterministic source and populated host tables',
        cleanup: 'cleanupBenchBase removes only the round-owned registered base',
        runtimeReuse:
          'one runtime across rounds; bases, tables, fields, and records are never reused',
      },
      changeCoverage: [
        'formula field creation backfills a populated table',
        'formula expression update recomputes every populated row',
        'linked source value update propagates to dependent lookup and rollup values',
        'unlink clears the selected host lookup and resets its rollup without changing other hosts',
        'relink restores the selected host lookup and rollup values',
      ],
      operationIdentities: Object.fromEntries(
        CORE_COMPUTED_CHANGES_CASES.map(({ key, identity }) => [key, identity])
      ),
      excludedCapabilities: ['undo', 'redo', 'realtime'],
      isolation:
        input.backend === 'pglite'
          ? 'fresh-memory-runtime-with-owned-base-per-round-cleanup'
          : 'caller-provided-test-database-with-owned-base-per-round-cleanup',
    },
  };
}
