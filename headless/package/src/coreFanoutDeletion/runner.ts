import { performance } from 'node:perf_hooks';

import {
  ActorId,
  CreateBaseCommand,
  type CreateBaseResult,
  CreateRecordsCommand,
  type CreateRecordsResult,
  CreateTableCommand,
  type CreateTableResult,
  DeleteRecordsCommand,
  type DeleteRecordsResult,
  UpdateRecordCommand,
  type UpdateRecordResult,
} from '@teable/v2-core';
import { type IComputedFlushReport, type IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';

import { createRuntimeForBackend } from '../case/loadSteps';
import { cleanupBenchBase, closeBenchRuntime, registerBenchBase } from '../case/runtimeLifecycle';
import type { RunCoreOpsBenchInput } from '../coreOps/runner';
import type { HttpBenchRun } from '../httpBench/runner';
import { normalizeValue } from '../oracle/normalize';
import { listAllRecords, tableRowCount } from '../oracle/paging';
import {
  executeMeasured as executeOperation,
  finalizeMeasurement,
  makeMeasurements,
  RecordedOperationFailure,
  type MutableMeasurement,
  type OperationResult,
} from '../runner/operationMeasurements';
import { resolveBenchCommit } from '../runner/provenance';
import {
  coreFanoutDeletionCaseId,
  CORE_FANOUT_DELETION_CASE_ID_VERSION,
  CORE_FANOUT_DELETION_CASES,
  CORE_FANOUT_DELETION_CI_FANOUT,
  CORE_FANOUT_DELETION_LARGE_FANOUT,
  CORE_FANOUT_DELETION_UNAFFECTED_ROWS,
  type CoreFanoutDeletionBenchCaseKey,
} from './cases';

export {
  CORE_FANOUT_DELETION_CASES,
  CORE_FANOUT_DELETION_CI_FANOUT,
  CORE_FANOUT_DELETION_LARGE_FANOUT,
  type CoreFanoutDeletionBenchCase,
} from './cases';

/** The direct Core benchmark input plus the actual number of affected dependent rows. */
export type RunCoreFanoutDeletionBenchInput = RunCoreOpsBenchInput & {
  readonly fanout?: number;
};

export type CoreFanoutDeletionBenchRun = HttpBenchRun;

type ExecutionContext = { readonly actorId: ActorId };
type SeededDependent = {
  readonly id: string;
  readonly title: string;
};
type FanoutDeletionFixture = {
  readonly runtime: IHeadlessRuntime;
  readonly baseId: string;
  readonly targetSourceId: string;
  readonly survivorSourceId: string;
  readonly affected: ReadonlyArray<SeededDependent>;
  readonly unaffected: ReadonlyArray<SeededDependent>;
};
type FixturePhase = 'baseline' | 'updated' | 'deleted';

const ACTOR_ID = 'usr_core_fanout_deletion_bench';
const CREATE_BATCH_SIZE = 1_000;
const TARGET_INITIAL_AMOUNT = 7;
const TARGET_UPDATED_AMOUNT = 20;
const SURVIVOR_AMOUNT = 41;

const IDS = {
  sourceTable: 'tblfandelparents000',
  sourcePrimary: 'fldfandelparentname',
  sourceAmount: 'fldfandelparentamt0',
  dependentTable: 'tblfandelchildren00',
  dependentPrimary: 'fldfandelchildname0',
  dependentLink: 'fldfandelparentlink',
  dependentLookup: 'fldfandelamtlookup0',
  dependentRollup: 'fldfandelamtrollup0',
} as const;

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

const validateInput = (input: RunCoreFanoutDeletionBenchInput): number => {
  if (!Number.isInteger(input.samples) || input.samples < 1) {
    throw new Error('samples must be a positive integer');
  }
  if (!Number.isInteger(input.warmup) || input.warmup < 0) {
    throw new Error('warmup must be a non-negative integer');
  }
  if (input.backend === 'postgres' && !input.connectionString) {
    throw new Error('connectionString is required for the postgres backend');
  }
  const fanout = input.fanout ?? CORE_FANOUT_DELETION_CI_FANOUT;
  if (!Number.isInteger(fanout) || fanout < 1) {
    throw new Error('fanout must be a positive integer');
  }
  return fanout;
};

const context = (): ExecutionContext => ({
  actorId: unwrap(ActorId.create(ACTOR_ID), 'coreFanoutDeletion.actor.invalid'),
});

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
        CreateBaseCommand.create({ name: `Core Fanout Deletion ${round}` }),
        'coreFanoutDeletion.createBase.invalid'
      )
    ),
    'coreFanoutDeletion.createBase.failed'
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
      unwrap(CreateTableCommand.create(input), 'coreFanoutDeletion.createTable.invalid')
    ),
    'coreFanoutDeletion.createTable.failed'
  );
  return result.table.id().toString();
};

const createSchema = async (runtime: IHeadlessRuntime, baseId: string): Promise<void> => {
  const sourceTableId = await createTable(runtime, {
    baseId,
    tableId: IDS.sourceTable,
    name: 'Fanout Deletion Parents',
    fields: [
      {
        id: IDS.sourcePrimary,
        name: 'Parent',
        type: 'singleLineText',
        isPrimary: true,
      },
      { id: IDS.sourceAmount, name: 'Amount', type: 'number' },
    ],
    views: [{ type: 'grid', name: 'Grid' }],
  });
  assertEqual(sourceTableId, IDS.sourceTable, 'source table id');

  const dependentTableId = await createTable(runtime, {
    baseId,
    tableId: IDS.dependentTable,
    name: 'Fanout Deletion Children',
    fields: [
      {
        id: IDS.dependentPrimary,
        name: 'Child',
        type: 'singleLineText',
        isPrimary: true,
      },
      {
        id: IDS.dependentLink,
        name: 'Parent Link',
        type: 'link',
        options: {
          relationship: 'manyOne',
          foreignTableId: IDS.sourceTable,
          lookupFieldId: IDS.sourcePrimary,
          isOneWay: true,
        },
      },
      {
        id: IDS.dependentLookup,
        name: 'Parent Amount Lookup',
        type: 'lookup',
        options: {
          linkFieldId: IDS.dependentLink,
          foreignTableId: IDS.sourceTable,
          lookupFieldId: IDS.sourceAmount,
        },
      },
      {
        id: IDS.dependentRollup,
        name: 'Parent Amount Rollup',
        type: 'rollup',
        options: { expression: 'sum({values})' },
        config: {
          linkFieldId: IDS.dependentLink,
          foreignTableId: IDS.sourceTable,
          lookupFieldId: IDS.sourceAmount,
        },
      },
    ],
    views: [{ type: 'grid', name: 'Grid' }],
  });
  assertEqual(dependentTableId, IDS.dependentTable, 'dependent table id');
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
        'coreFanoutDeletion.createRecords.invalid'
      )
    ),
    'coreFanoutDeletion.createRecords.failed'
  );
  assertEqual(result.records.length, records.length, `created record count for ${tableId}`);
  return result.records.map((record) => record.id().toString());
};

const seedFixture = async (input: {
  readonly runtime: IHeadlessRuntime;
  readonly baseId: string;
  readonly fanout: number;
}): Promise<FanoutDeletionFixture> => {
  await createSchema(input.runtime, input.baseId);
  const sourceIds = await createRecords(input.runtime, IDS.sourceTable, [
    {
      fields: {
        [IDS.sourcePrimary]: 'target-parent',
        [IDS.sourceAmount]: TARGET_INITIAL_AMOUNT,
      },
    },
    {
      fields: {
        [IDS.sourcePrimary]: 'survivor-parent',
        [IDS.sourceAmount]: SURVIVOR_AMOUNT,
      },
    },
  ]);
  const targetSourceId = sourceIds[0];
  const survivorSourceId = sourceIds[1];
  assert(targetSourceId, 'Target source record was not created');
  assert(survivorSourceId, 'Survivor source record was not created');
  assert(targetSourceId !== survivorSourceId, 'Source record IDs must be distinct');

  const affected: SeededDependent[] = [];
  for (let offset = 0; offset < input.fanout; offset += CREATE_BATCH_SIZE) {
    const count = Math.min(CREATE_BATCH_SIZE, input.fanout - offset);
    const titles = Array.from(
      { length: count },
      (_, index) => `affected-${(offset + index).toString().padStart(8, '0')}`
    );
    const ids = await createRecords(
      input.runtime,
      IDS.dependentTable,
      titles.map((title) => ({
        fields: {
          [IDS.dependentPrimary]: title,
          [IDS.dependentLink]: { id: targetSourceId },
        },
      }))
    );
    for (const [index, id] of ids.entries()) {
      affected.push({ id, title: titles[index]! });
    }
  }

  const unaffectedTitles = Array.from(
    { length: CORE_FANOUT_DELETION_UNAFFECTED_ROWS },
    (_, index) => `unaffected-${index.toString().padStart(2, '0')}`
  );
  const unaffectedIds = await createRecords(
    input.runtime,
    IDS.dependentTable,
    unaffectedTitles.map((title) => ({
      fields: {
        [IDS.dependentPrimary]: title,
        [IDS.dependentLink]: { id: survivorSourceId },
      },
    }))
  );
  const unaffected = unaffectedIds.map((id, index) => ({
    id,
    title: unaffectedTitles[index]!,
  }));

  assertEqual(affected.length, input.fanout, 'actual affected fanout seed count');
  assertEqual(
    new Set(affected.map(({ id }) => id)).size,
    input.fanout,
    'distinct affected fanout seed count'
  );
  assertEqual(
    new Set(unaffected.map(({ id }) => id)).size,
    CORE_FANOUT_DELETION_UNAFFECTED_ROWS,
    'distinct unaffected seed count'
  );

  const fixture = {
    runtime: input.runtime,
    baseId: input.baseId,
    targetSourceId,
    survivorSourceId,
    affected,
    unaffected,
  };
  const setupReport = await input.runtime.flushComputed();
  assertFullyDrained(setupReport, 'setup computed queue');
  await assertFixtureState(fixture, 'baseline');
  return fixture;
};

const fieldsOf = (record: Record<string, unknown>, label: string): Record<string, unknown> => {
  const fields = record.fields;
  assert(
    fields && typeof fields === 'object' && !Array.isArray(fields),
    `${label}: missing fields`
  );
  return fields as Record<string, unknown>;
};

const linkedRecordIds = (value: unknown, label: string): ReadonlyArray<string> => {
  if (value == null) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry, index) => {
    assert(
      entry && typeof entry === 'object' && 'id' in entry && typeof entry.id === 'string',
      `${label}[${index}]: expected linked record object`
    );
    return entry.id;
  });
};

const numericValues = (value: unknown, label: string): ReadonlyArray<number> => {
  const normalized = normalizeValue(value);
  if (normalized == null) return [];
  const entries = Array.isArray(normalized) ? normalized : [normalized];
  return entries.map((entry, index) => {
    assert(typeof entry === 'number', `${label}[${index}]: expected numeric value`);
    return entry;
  });
};

const numericRollup = (value: unknown, label: string): number => {
  const normalized = normalizeValue(value);
  if (normalized == null) return 0;
  assert(typeof normalized === 'number', `${label}: expected numeric rollup value`);
  return normalized;
};

const assertLinkedComputedState = (input: {
  readonly fields: Record<string, unknown>;
  readonly expectedSourceId: string;
  readonly expectedAmount: number;
  readonly label: string;
}): void => {
  const linkIds = linkedRecordIds(input.fields[IDS.dependentLink], `${input.label} link`);
  assertEqual(linkIds.length, 1, `${input.label} link count`);
  assertEqual(linkIds[0], input.expectedSourceId, `${input.label} link target`);
  const lookup = numericValues(input.fields[IDS.dependentLookup], `${input.label} lookup`);
  assertEqual(lookup.length, 1, `${input.label} lookup count`);
  assertEqual(lookup[0], input.expectedAmount, `${input.label} lookup value`);
  assertEqual(
    numericRollup(input.fields[IDS.dependentRollup], `${input.label} rollup`),
    input.expectedAmount,
    `${input.label} rollup value`
  );
};

const assertClearedComputedState = (fields: Record<string, unknown>, label: string): void => {
  assertEqual(
    linkedRecordIds(fields[IDS.dependentLink], `${label} link`).length,
    0,
    `${label} link`
  );
  assertEqual(
    numericValues(fields[IDS.dependentLookup], `${label} lookup`).length,
    0,
    `${label} lookup`
  );
  assertEqual(
    numericRollup(fields[IDS.dependentRollup], `${label} rollup`),
    0,
    `${label} empty rollup`
  );
};

const assertSourceState = async (
  fixture: FanoutDeletionFixture,
  phase: FixturePhase
): Promise<void> => {
  const records = await listAllRecords({
    runtime: fixture.runtime,
    actorId: ACTOR_ID,
    tableId: IDS.sourceTable,
    projection: [IDS.sourcePrimary, IDS.sourceAmount],
  });
  const expectedCount = phase === 'deleted' ? 1 : 2;
  assertEqual(records.length, expectedCount, `${phase} source record count`);
  assertEqual(
    new Set(records.map((record) => String(record.id))).size,
    expectedCount,
    `${phase} distinct source record count`
  );
  const byId = new Map(records.map((record) => [String(record.id), record]));
  const survivor = byId.get(fixture.survivorSourceId);
  assert(survivor, `${phase}: survivor source is missing`);
  const survivorFields = fieldsOf(survivor, `${phase} survivor source`);
  assertEqual(survivorFields[IDS.sourcePrimary], 'survivor-parent', `${phase} survivor title`);
  assertEqual(
    numericRollup(survivorFields[IDS.sourceAmount], `${phase} survivor amount`),
    SURVIVOR_AMOUNT,
    `${phase} survivor amount`
  );

  const target = byId.get(fixture.targetSourceId);
  if (phase === 'deleted') {
    assertEqual(target, undefined, 'deleted target source must be absent');
    return;
  }
  assert(target, `${phase}: target source is missing`);
  const targetFields = fieldsOf(target, `${phase} target source`);
  assertEqual(targetFields[IDS.sourcePrimary], 'target-parent', `${phase} target title`);
  assertEqual(
    numericRollup(targetFields[IDS.sourceAmount], `${phase} target amount`),
    phase === 'baseline' ? TARGET_INITIAL_AMOUNT : TARGET_UPDATED_AMOUNT,
    `${phase} target amount`
  );
};

const assertDependentState = async (
  fixture: FanoutDeletionFixture,
  phase: FixturePhase
): Promise<void> => {
  const expectedCount = fixture.affected.length + fixture.unaffected.length;
  const records = await listAllRecords({
    runtime: fixture.runtime,
    actorId: ACTOR_ID,
    tableId: IDS.dependentTable,
    projection: [IDS.dependentPrimary, IDS.dependentLink, IDS.dependentLookup, IDS.dependentRollup],
  });
  assertEqual(records.length, expectedCount, `${phase} dependent record count`);
  assertEqual(
    new Set(records.map((record) => String(record.id))).size,
    expectedCount,
    `${phase} distinct dependent record count`
  );
  const byId = new Map(records.map((record) => [String(record.id), record]));
  const targetAmount = phase === 'baseline' ? TARGET_INITIAL_AMOUNT : TARGET_UPDATED_AMOUNT;

  for (const [index, expected] of fixture.affected.entries()) {
    const record = byId.get(expected.id);
    assert(record, `${phase}: affected dependent ${expected.id} is missing`);
    const label = `${phase} affected dependent ${index}`;
    const fields = fieldsOf(record, label);
    assertEqual(fields[IDS.dependentPrimary], expected.title, `${label} title`);
    if (phase === 'deleted') {
      assertClearedComputedState(fields, label);
    } else {
      assertLinkedComputedState({
        fields,
        expectedSourceId: fixture.targetSourceId,
        expectedAmount: targetAmount,
        label,
      });
    }
  }

  for (const [index, expected] of fixture.unaffected.entries()) {
    const record = byId.get(expected.id);
    assert(record, `${phase}: unaffected dependent ${expected.id} is missing`);
    const label = `${phase} unaffected dependent ${index}`;
    const fields = fieldsOf(record, label);
    assertEqual(fields[IDS.dependentPrimary], expected.title, `${label} title`);
    assertLinkedComputedState({
      fields,
      expectedSourceId: fixture.survivorSourceId,
      expectedAmount: SURVIVOR_AMOUNT,
      label,
    });
  }
};

const assertFixtureState = async (
  fixture: FanoutDeletionFixture,
  phase: FixturePhase
): Promise<void> => {
  assertEqual(
    await tableRowCount({
      runtime: fixture.runtime,
      actorId: ACTOR_ID,
      tableId: IDS.sourceTable,
    }),
    phase === 'deleted' ? 1 : 2,
    `${phase} source table row count`
  );
  assertEqual(
    await tableRowCount({
      runtime: fixture.runtime,
      actorId: ACTOR_ID,
      tableId: IDS.dependentTable,
    }),
    fixture.affected.length + fixture.unaffected.length,
    `${phase} dependent table row count`
  );
  await assertSourceState(fixture, phase);
  await assertDependentState(fixture, phase);
};

const updateSource = async (
  fixture: FanoutDeletionFixture
): Promise<OperationResult<UpdateRecordResult>> => {
  const command = unwrap(
    UpdateRecordCommand.create({
      tableId: IDS.sourceTable,
      recordId: fixture.targetSourceId,
      fieldKeyType: 'id',
      typecast: false,
      fields: { [IDS.sourceAmount]: TARGET_UPDATED_AMOUNT },
    }),
    'coreFanoutDeletion.updateSource.invalid'
  );
  const started = performance.now();
  const result = await fixture.runtime.commandBus.execute<UpdateRecordCommand, UpdateRecordResult>(
    context(),
    command
  );
  const latencyMs = performance.now() - started;
  return {
    data: unwrap(result, 'coreFanoutDeletion.updateSource.failed'),
    latencyMs,
    rowsWritten: 1,
    observation: {
      recordIds: [fixture.targetSourceId],
      recordRelation: 'command-target',
      fieldNames: [IDS.sourceAmount],
      truncated: false,
    },
  };
};

const deleteSource = async (
  fixture: FanoutDeletionFixture
): Promise<OperationResult<DeleteRecordsResult>> => {
  const command = unwrap(
    DeleteRecordsCommand.create({
      tableId: IDS.sourceTable,
      recordIds: [fixture.targetSourceId],
    }),
    'coreFanoutDeletion.deleteSource.invalid'
  );
  const started = performance.now();
  const result = await fixture.runtime.commandBus.execute<
    DeleteRecordsCommand,
    DeleteRecordsResult
  >(context(), command);
  const latencyMs = performance.now() - started;
  const response = unwrap(result, 'coreFanoutDeletion.deleteSource.failed');
  assertEqual(response.deletedRecordIds.length, 1, 'deleted source result count');
  assertEqual(response.deletedRecordIds[0], fixture.targetSourceId, 'deleted source result id');
  return {
    data: response,
    latencyMs,
    rowsWritten: response.deletedRecordIds.length,
    observation: {
      recordIds: [fixture.targetSourceId],
      recordRelation: 'command-target',
      fieldNames: [IDS.dependentLink, IDS.dependentLookup, IDS.dependentRollup],
      truncated: false,
    },
  };
};

const flushAndAssert = async (input: {
  readonly fixture: FanoutDeletionFixture;
  readonly phase: Extract<FixturePhase, 'updated' | 'deleted'>;
}): Promise<OperationResult<IComputedFlushReport>> => {
  const started = performance.now();
  const report = await input.fixture.runtime.flushComputed();
  const latencyMs = performance.now() - started;
  assertFullyDrained(report, `${input.phase} computed queue`);
  await assertFixtureState(input.fixture, input.phase);
  return { data: report, latencyMs, processed: report.processed };
};

const runTransitions = async (input: {
  readonly fixture: FanoutDeletionFixture;
  readonly measured: boolean;
  readonly measurements: Map<
    CoreFanoutDeletionBenchCaseKey,
    MutableMeasurement<CoreFanoutDeletionBenchCaseKey>
  >;
  readonly errors: string[];
}): Promise<void> => {
  const execute = <T>(
    key: CoreFanoutDeletionBenchCaseKey,
    action: () => Promise<OperationResult<T>>
  ): Promise<T> =>
    executeOperation({
      key,
      action,
      measured: input.measured,
      measurements: input.measurements,
      errors: input.errors,
    });

  await execute('core:UpdateRecordCommand/linked-source-before-delete', () =>
    updateSource(input.fixture)
  );
  await execute('core:IHeadlessRuntime.flushComputed/linked-source-update-fanout', () =>
    flushAndAssert({ fixture: input.fixture, phase: 'updated' })
  );
  await execute('core:DeleteRecordsCommand/linked-source', () => deleteSource(input.fixture));
  await execute('core:IHeadlessRuntime.flushComputed/linked-source-delete-fanout', () =>
    flushAndAssert({ fixture: input.fixture, phase: 'deleted' })
  );
};

const runIsolatedRound = async (input: {
  readonly runtime: IHeadlessRuntime;
  readonly round: number;
  readonly fanout: number;
  readonly measured: boolean;
  readonly measurements: Map<
    CoreFanoutDeletionBenchCaseKey,
    MutableMeasurement<CoreFanoutDeletionBenchCaseKey>
  >;
  readonly errors: string[];
}): Promise<void> => {
  const baseId = await createBase(input.runtime, input.round);
  let roundError: unknown;
  try {
    const fixture = await seedFixture({
      runtime: input.runtime,
      baseId,
      fanout: input.fanout,
    });
    await runTransitions({
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
      const message = `Core fanout deletion cleanup failed for ${baseId}: ${errorMessage(error)}`;
      input.errors.push(message);
      if (!roundError) {
        roundError = new RecordedOperationFailure(
          'core:DeleteRecordsCommand/linked-source',
          message
        );
      }
    }
  }
  if (roundError) throw roundError;
};

/**
 * Benchmarks an update and subsequent deletion of one source record referenced by
 * many dependent rows. Mutation, drain, and exhaustive correctness readback have
 * separate timing boundaries; each round owns and cleans an isolated base.
 */
export async function runCoreFanoutDeletionBench(
  input: RunCoreFanoutDeletionBenchInput
): Promise<CoreFanoutDeletionBenchRun> {
  const fanout = validateInput(input);
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const measurements = makeMeasurements(CORE_FANOUT_DELETION_CASES);
  const caseId = coreFanoutDeletionCaseId(fanout);
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
        fanout,
        measured: false,
        measurements,
        errors,
      });
    }
    for (let index = 0; index < input.samples; index += 1) {
      await runIsolatedRound({
        runtime,
        round: round++,
        fanout,
        measured: true,
        measurements,
        errors,
      });
    }
  } catch (error) {
    if (!(error instanceof RecordedOperationFailure)) {
      errors.push(`Core fanout deletion benchmark execution failed: ${errorMessage(error)}`);
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
    caseId,
    operations: CORE_FANOUT_DELETION_CASES.map(({ key }) =>
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
      actualFanoutRows: fanout,
      unaffectedDependentRows: CORE_FANOUT_DELETION_UNAFFECTED_ROWS,
      sourceRows: 2,
      dependentRows: fanout + CORE_FANOUT_DELETION_UNAFFECTED_ROWS,
      seededRows: fanout + CORE_FANOUT_DELETION_UNAFFECTED_ROWS + 2,
      createBatchSize: CREATE_BATCH_SIZE,
      ciFanoutRows: CORE_FANOUT_DELETION_CI_FANOUT,
      largeFanoutRows: CORE_FANOUT_DELETION_LARGE_FANOUT,
      caseIdentityVersion: CORE_FANOUT_DELETION_CASE_ID_VERSION,
      scaleIdentity: caseId,
      deterministicRecipe: 'target-and-survivor-parent-with-indexed-dependents-v1',
      relationship: 'one-way-manyOne-dependent-to-source',
      propagationFields: ['dependent.link', 'dependent.lookup', 'dependent.rollup'],
      measuredTiming:
        'UpdateRecordCommand, update flushComputed, DeleteRecordsCommand, and delete flushComputed are separate',
      setupTiming: 'excluded',
      correctnessValidation:
        'untimed-exhaustive-core-readback-after-setup-update-and-delete-with-full-drain-reports',
      sampleInvariant: {
        transition: `${TARGET_INITIAL_AMOUNT}->${TARGET_UPDATED_AMOUNT}->source-deleted`,
        freshGraphPerRound: true,
        affectedRows: fanout,
        unaffectedRows: CORE_FANOUT_DELETION_UNAFFECTED_ROWS,
      },
      cleanup: 'owned-base-cleanup-after-every-round-and-runtime-close',
      operationIdentities: CORE_FANOUT_DELETION_CASES.map(({ key, identity }) => ({
        key,
        identity,
      })),
      excludedCapabilities: ['undo', 'redo', 'realtime'],
      isolation:
        input.backend === 'pglite'
          ? 'fresh-memory-runtime-with-round-scoped-owned-base-cleanup'
          : 'caller-provided-test-database-with-round-scoped-owned-base-cleanup',
    },
  };
}
