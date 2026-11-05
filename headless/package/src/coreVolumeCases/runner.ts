import { performance } from 'node:perf_hooks';

import {
  ActorId,
  CountTableRecordsQuery,
  type CountTableRecordsResult,
  CreateBaseCommand,
  type CreateBaseResult,
  CreateRecordsStreamCommand,
  type CreateRecordsStreamResult,
  CreateTableCommand,
  type CreateTableResult,
  DeleteRecordsCommand,
  type DeleteRecordsResult,
  type Field,
  ListTableRecordsQuery,
  type ListTableRecordsResult,
  type Table,
  UpdateRecordsCommand,
  type UpdateRecordsResult,
} from '@teable/v2-core';
import type { IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';

import { createRuntimeForBackend } from '../case/loadSteps';
import { cleanupBenchBase, closeBenchRuntime, registerBenchBase } from '../case/runtimeLifecycle';
import type { HttpBenchRun } from '../httpBench/runner';
import { listAllRecords } from '../oracle/paging';
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
import { CORE_VOLUME_CASES, type CoreVolumeBenchCaseKey } from './cases';
import {
  coreVolumeCaseId,
  CORE_VOLUME_CASE_ID_VERSION,
  deterministicVolumeRow,
  expectedVolumeCounts,
  resolveCoreVolumeProfile,
  type CoreVolumeProfileSelection,
  type DeterministicVolumeRow,
  type ResolvedCoreVolumeProfile,
} from './scenarios';

export { CORE_VOLUME_CASES, type CoreVolumeBenchCase } from './cases';
export {
  coreVolumeCaseId,
  CORE_VOLUME_CASE_ID_VERSION,
  CORE_VOLUME_PROFILES,
  deterministicVolumeRow,
  expectedVolumeCounts,
  resolveCoreVolumeProfile,
  type CoreVolumeConfig,
  type CoreVolumeProfileSelection,
  type ResolvedCoreVolumeProfile,
} from './scenarios';

export type RunCoreVolumeCasesBenchInput = {
  readonly backend: 'pglite' | 'postgres';
  readonly connectionString?: string;
  readonly samples: number;
  readonly warmup: number;
  readonly profile?: CoreVolumeProfileSelection;
};

export type CoreVolumeCasesBenchRun = HttpBenchRun;

type ExecutionContext = { readonly actorId: ActorId };

type VolumeFields = {
  readonly name: string;
  readonly segment: string;
  readonly status: string;
  readonly amount: string;
  readonly guard: string;
};

type VolumeFixture = {
  readonly runtime: IHeadlessRuntime;
  readonly baseId: string;
  readonly tableId: string;
  readonly fields: VolumeFields;
};

type ValidatedState = {
  readonly updateRecordIds: ReadonlyArray<string>;
  readonly deleteRecordIds: ReadonlyArray<string>;
};

type VolumeStage = 'seeded' | 'updated' | 'deleted';

const ACTOR_ID = 'usr_core_volume_cases_bench';
const UPDATED_STATUS = 'updated';

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

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    );
  }
};

const createContext = (): ExecutionContext => ({
  actorId: unwrap(ActorId.create(ACTOR_ID), 'coreVolume.actor.invalid'),
});

const timedResult = async <T, E>(
  action: () => Promise<Result<T, E>>,
  errorCode: string
): Promise<TimedResult<T>> => {
  const started = performance.now();
  const result = await action();
  const latencyMs = performance.now() - started;
  return { data: unwrap(result, errorCode), latencyMs };
};

const tableField = (table: Table, name: string): Field => {
  const field = table.getFields().find((candidate) => candidate.name().toString() === name);
  assert(field, `Table ${table.name().toString()} is missing field ${name}`);
  return field;
};

const createFixture = async (input: {
  readonly runtime: IHeadlessRuntime;
  readonly context: ExecutionContext;
  readonly label: string;
}): Promise<VolumeFixture> => {
  const baseResult = unwrap(
    await input.runtime.commandBus.execute<CreateBaseCommand, CreateBaseResult>(
      input.context,
      unwrap(
        CreateBaseCommand.create({ name: `Core volume ${input.label}` }),
        'coreVolume.base.create.invalid'
      )
    ),
    'coreVolume.base.create.failed'
  );
  const baseId = baseResult.base.id().toString();
  registerBenchBase(input.runtime, baseId);

  try {
    const tableResult = unwrap(
      await input.runtime.commandBus.execute<CreateTableCommand, CreateTableResult>(
        input.context,
        unwrap(
          CreateTableCommand.create({
            baseId,
            name: 'Deterministic Volume',
            fields: [
              { name: 'Name', type: 'singleLineText', isPrimary: true },
              { name: 'Segment', type: 'singleLineText' },
              { name: 'Status', type: 'singleLineText' },
              { name: 'Amount', type: 'number' },
              { name: 'Guard', type: 'singleLineText' },
            ],
            views: [{ type: 'grid', name: 'Grid' }],
          }),
          'coreVolume.table.create.invalid'
        )
      ),
      'coreVolume.table.create.failed'
    );
    const table = tableResult.table;
    return {
      runtime: input.runtime,
      baseId,
      tableId: table.id().toString(),
      fields: {
        name: tableField(table, 'Name').id().toString(),
        segment: tableField(table, 'Segment').id().toString(),
        status: tableField(table, 'Status').id().toString(),
        amount: tableField(table, 'Amount').id().toString(),
        guard: tableField(table, 'Guard').id().toString(),
      },
    };
  } catch (setupError) {
    try {
      await cleanupBenchBase(input.runtime, baseId);
    } catch (cleanupError) {
      throw new Error(
        `Core volume fixture setup failed (${errorMessage(setupError)}) and cleanup failed for ${baseId}: ${errorMessage(cleanupError)}`
      );
    }
    throw setupError;
  }
};

function* volumeRecords(
  rowCount: number,
  fields: VolumeFields
): Generator<{ fields: Record<string, unknown> }, void, undefined> {
  for (let index = 0; index < rowCount; index += 1) {
    const row = deterministicVolumeRow(index);
    yield {
      fields: {
        [fields.name]: row.name,
        [fields.segment]: row.segment,
        [fields.status]: row.status,
        [fields.amount]: row.amount,
        [fields.guard]: row.guard,
      },
    };
  }
}

const fieldsOf = (record: Record<string, unknown>, label: string): Record<string, unknown> => {
  const fields = record.fields;
  assert(
    fields && typeof fields === 'object' && !Array.isArray(fields),
    `${label}: missing fields`
  );
  return fields as Record<string, unknown>;
};

const parseRowIndex = (value: unknown, label: string): number => {
  assert(typeof value === 'string' && /^row-\d{8,}$/.test(value), `${label}: invalid row name`);
  const index = Number(value.slice(4));
  assert(Number.isSafeInteger(index), `${label}: invalid row index`);
  return index;
};

/** Exhaustive untimed oracle for exact distributions and untouched field preservation. */
const validateState = async (input: {
  readonly fixture: VolumeFixture;
  readonly profile: ResolvedCoreVolumeProfile;
  readonly stage: VolumeStage;
}): Promise<ValidatedState> => {
  const { fixture, profile, stage } = input;
  const counts = expectedVolumeCounts(profile.rowCount);
  const records = await listAllRecords({
    runtime: fixture.runtime,
    actorId: ACTOR_ID,
    tableId: fixture.tableId,
    projection: Object.values(fixture.fields),
  });
  assertEqual(
    records.length,
    stage === 'deleted' ? counts.remaining : profile.rowCount,
    `${stage} persisted row count`
  );

  const seen = new Set<number>();
  const updateRecordIds: string[] = [];
  const deleteRecordIds: string[] = [];
  const distribution = { update: 0, delete: 0, control: 0 };

  for (const [position, record] of records.entries()) {
    const label = `${stage} record ${position}`;
    const fields = fieldsOf(record, label);
    const index = parseRowIndex(fields[fixture.fields.name], label);
    assert(index >= 0 && index < profile.rowCount, `${label}: row index is outside the profile`);
    assert(!seen.has(index), `${label}: duplicate deterministic row index ${index}`);
    seen.add(index);

    const expected = deterministicVolumeRow(index);
    if (stage === 'deleted') {
      assert(expected.segment !== 'delete', `${label}: deleted segment row remains`);
    }
    distribution[expected.segment] += 1;
    assertEqual(fields[fixture.fields.name], expected.name, `${label} name`);
    assertEqual(fields[fixture.fields.segment], expected.segment, `${label} segment`);
    assertEqual(fields[fixture.fields.amount], expected.amount, `${label} amount`);
    assertEqual(fields[fixture.fields.guard], expected.guard, `${label} guard`);
    assertEqual(
      fields[fixture.fields.status],
      expected.segment === 'update' && stage !== 'seeded' ? UPDATED_STATUS : expected.status,
      `${label} status`
    );

    const recordId = String(record.id);
    assert(recordId.length > 0, `${label}: missing record id`);
    if (expected.segment === 'update') updateRecordIds.push(recordId);
    if (expected.segment === 'delete') deleteRecordIds.push(recordId);
  }

  assertEqual(distribution.update, counts.update, `${stage} update distribution`);
  assertEqual(
    distribution.delete,
    stage === 'deleted' ? 0 : counts.delete,
    `${stage} delete distribution`
  );
  assertEqual(distribution.control, counts.control, `${stage} control distribution`);
  return { updateRecordIds, deleteRecordIds };
};

const selectiveFilter = (fixture: VolumeFixture) => ({
  fieldId: fixture.fields.segment,
  operator: 'is' as const,
  value: 'update',
});

const runOperations = async (input: {
  readonly fixture: VolumeFixture;
  readonly profile: ResolvedCoreVolumeProfile;
  readonly measured: boolean;
  readonly measurements: Map<CoreVolumeBenchCaseKey, MutableMeasurement<CoreVolumeBenchCaseKey>>;
  readonly errors: string[];
}): Promise<void> => {
  const measure = <T>(
    key: CoreVolumeBenchCaseKey,
    action: () => Promise<OperationResult<T>>
  ): Promise<T> =>
    executeMeasured({
      key,
      action,
      measured: input.measured,
      measurements: input.measurements,
      errors: input.errors,
    });
  const { fixture, profile } = input;
  const counts = expectedVolumeCounts(profile.rowCount);

  await measure('core:CreateRecordsStreamCommand/volume-generator', async () => {
    const command = unwrap(
      CreateRecordsStreamCommand.createFromIterable({
        tableId: fixture.tableId,
        records: volumeRecords(profile.rowCount, fixture.fields),
        batchSize: profile.batchSize,
      }),
      'coreVolume.records.stream.invalid'
    );
    const response = await timedResult(
      () =>
        fixture.runtime.commandBus.execute<CreateRecordsStreamCommand, CreateRecordsStreamResult>(
          createContext(),
          command
        ),
      'coreVolume.records.stream.failed'
    );
    assertEqual(response.data.totalCreated, profile.rowCount, 'stream-created row count');
    return { ...response, rowsWritten: response.data.totalCreated };
  });

  const seededState = await validateState({ fixture, profile, stage: 'seeded' });
  assertEqual(seededState.updateRecordIds.length, counts.update, 'seeded update id count');
  assertEqual(seededState.deleteRecordIds.length, counts.delete, 'seeded delete id count');

  await measure('core:ListTableRecordsQuery/selective-segment', async () => {
    const limit = Math.min(profile.queryPageSize, counts.update);
    const query = unwrap(
      ListTableRecordsQuery.create({
        tableId: fixture.tableId,
        fieldKeyType: 'id',
        filter: selectiveFilter(fixture),
        projection: Object.values(fixture.fields),
        includeTotal: true,
        limit,
        offset: 0,
        sort: [{ fieldId: fixture.fields.name, order: 'asc' }],
      }),
      'coreVolume.records.selective_list.invalid'
    );
    const response = await timedResult(
      () =>
        fixture.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
          createContext(),
          query
        ),
      'coreVolume.records.selective_list.failed'
    );
    assertEqual(response.data.total, counts.update, 'selective query total');
    assertEqual(response.data.records.length, limit, 'selective query page size');
    const expectedPage: DeterministicVolumeRow[] = [];
    for (let index = 0; expectedPage.length < limit && index < profile.rowCount; index += 1) {
      const row = deterministicVolumeRow(index);
      if (row.segment === 'update') expectedPage.push(row);
    }
    assertEqual(expectedPage.length, limit, 'selective query expected-page coverage');
    const actualPage = response.data.records.map((record, position) => {
      const fields = fieldsOf(record as Record<string, unknown>, `selective record ${position}`);
      return {
        name: fields[fixture.fields.name],
        segment: fields[fixture.fields.segment],
        status: fields[fixture.fields.status],
        amount: fields[fixture.fields.amount],
        guard: fields[fixture.fields.guard],
      };
    });
    assertEqual(
      new Set(response.data.records.map((record) => record.id)).size,
      limit,
      'selective query distinct record ids'
    );
    assertEqual(
      new Set(actualPage.map(({ name }) => name)).size,
      limit,
      'selective query distinct deterministic rows'
    );
    assertEqual(
      JSON.stringify(actualPage),
      JSON.stringify(expectedPage),
      'selective query deterministic page'
    );
    return {
      ...response,
      rowsRead: response.data.records.length,
      rowsReturned: response.data.records.length,
      observation: {
        recordIds: response.data.records.slice(0, 100).map((record) => record.id),
        recordRelation: 'returned',
        fieldNames: Object.values(fixture.fields),
        truncated: response.data.records.length > 100,
      },
    };
  });

  await measure('core:CountTableRecordsQuery/selective-segment', async () => {
    const query = unwrap(
      CountTableRecordsQuery.create({
        tableId: fixture.tableId,
        fieldKeyType: 'id',
        filter: selectiveFilter(fixture),
      }),
      'coreVolume.records.selective_count.invalid'
    );
    const response = await timedResult(
      () =>
        fixture.runtime.queryBus.execute<CountTableRecordsQuery, CountTableRecordsResult>(
          createContext(),
          query
        ),
      'coreVolume.records.selective_count.failed'
    );
    assertEqual(response.data.count, counts.update, 'selective count');
    return { ...response, rowsReturned: 1 };
  });

  await measure('core:UpdateRecordsCommand/filter-bulk', async () => {
    const command = unwrap(
      UpdateRecordsCommand.create({
        tableId: fixture.tableId,
        fieldKeyType: 'id',
        filter: selectiveFilter(fixture),
        fields: { [fixture.fields.status]: UPDATED_STATUS },
        typecast: false,
      }),
      'coreVolume.records.bulk_update.invalid'
    );
    const response = await timedResult(
      () =>
        fixture.runtime.commandBus.execute<UpdateRecordsCommand, UpdateRecordsResult>(
          createContext(),
          command
        ),
      'coreVolume.records.bulk_update.failed'
    );
    assertEqual(response.data.updatedCount, counts.update, 'bulk-updated row count');
    return {
      ...response,
      rowsWritten: response.data.updatedCount,
      observation: {
        recordIds: seededState.updateRecordIds.slice(0, 100),
        recordRelation: 'command-target',
        fieldNames: [fixture.fields.status],
        truncated: seededState.updateRecordIds.length > 100,
      },
    };
  });

  await validateState({ fixture, profile, stage: 'updated' });

  await measure('core:DeleteRecordsCommand/id-bulk', async () => {
    const command = unwrap(
      DeleteRecordsCommand.create({
        tableId: fixture.tableId,
        recordIds: seededState.deleteRecordIds,
      }),
      'coreVolume.records.bulk_delete.invalid'
    );
    const response = await timedResult(
      () =>
        fixture.runtime.commandBus.execute<DeleteRecordsCommand, DeleteRecordsResult>(
          createContext(),
          command
        ),
      'coreVolume.records.bulk_delete.failed'
    );
    assertEqual(response.data.deletedRecordIds.length, counts.delete, 'bulk-deleted row count');
    assertEqual(
      new Set(response.data.deletedRecordIds).size,
      counts.delete,
      'distinct bulk-deleted row count'
    );
    const deletedIds = new Set(response.data.deletedRecordIds);
    for (const recordId of seededState.deleteRecordIds) {
      assert(deletedIds.has(recordId), `bulk delete response omitted ${recordId}`);
    }
    return {
      ...response,
      rowsWritten: response.data.deletedRecordIds.length,
      observation: {
        recordIds: response.data.deletedRecordIds.slice(0, 100),
        recordRelation: 'command-target',
        fieldNames: [],
        truncated: response.data.deletedRecordIds.length > 100,
      },
    };
  });

  const deletedState = await validateState({ fixture, profile, stage: 'deleted' });
  assertEqual(deletedState.deleteRecordIds.length, 0, 'deleted target preservation check');
  assertEqual(
    deletedState.updateRecordIds.length,
    counts.update,
    'updated rows preserved after delete'
  );
};

const runIsolatedRound = async (input: {
  readonly runtime: IHeadlessRuntime;
  readonly context: ExecutionContext;
  readonly round: number;
  readonly measured: boolean;
  readonly profile: ResolvedCoreVolumeProfile;
  readonly measurements: Map<CoreVolumeBenchCaseKey, MutableMeasurement<CoreVolumeBenchCaseKey>>;
  readonly errors: string[];
}): Promise<void> => {
  let fixture: VolumeFixture | undefined;
  let roundError: unknown;
  try {
    fixture = await createFixture({
      runtime: input.runtime,
      context: input.context,
      label: `${input.measured ? 'sample' : 'warmup'}-${input.round}`,
    });
    await runOperations({
      fixture,
      profile: input.profile,
      measured: input.measured,
      measurements: input.measurements,
      errors: input.errors,
    });
  } catch (error) {
    roundError = error;
  } finally {
    if (fixture) {
      try {
        await cleanupBenchBase(input.runtime, fixture.baseId);
      } catch (error) {
        const message = `Core volume cleanup failed for ${fixture.baseId}: ${errorMessage(error)}`;
        input.errors.push(message);
        if (!roundError) roundError = new Error(message);
      }
    }
  }
  if (roundError) throw roundError;
};

const validateInput = (input: RunCoreVolumeCasesBenchInput): void => {
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
 * Runs volume-sensitive public Core operations. Schema setup, exhaustive
 * correctness readback, selector-ID preparation, and cleanup are deliberately
 * outside the operation timers; command/query execution is the timed boundary.
 */
export async function runCoreVolumeCasesBench(
  input: RunCoreVolumeCasesBenchInput
): Promise<CoreVolumeCasesBenchRun> {
  validateInput(input);
  const profile = resolveCoreVolumeProfile(input.profile);
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const measurements = makeMeasurements(CORE_VOLUME_CASES);
  const context = createContext();
  const caseId = coreVolumeCaseId(profile);
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
        context,
        round: round++,
        measured: false,
        profile,
        measurements,
        errors,
      });
    }
    for (let index = 0; index < input.samples; index += 1) {
      await runIsolatedRound({
        runtime,
        context,
        round: round++,
        measured: true,
        profile,
        measurements,
        errors,
      });
    }
  } catch (error) {
    if (!(error instanceof RecordedOperationFailure)) {
      errors.push(`Core volume benchmark execution failed: ${errorMessage(error)}`);
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

  const counts = expectedVolumeCounts(profile.rowCount);
  return {
    caseId,
    operations: CORE_VOLUME_CASES.map(({ key }) => finalizeMeasurement(measurements.get(key)!)),
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
      profile: profile.profile,
      rowCount: profile.rowCount,
      batchSize: profile.batchSize,
      queryPageSize: profile.queryPageSize,
      selectedUpdateRows: counts.update,
      selectedDeleteRows: counts.delete,
      controlRows: counts.control,
      finalRows: counts.remaining,
      caseIdentityVersion: CORE_VOLUME_CASE_ID_VERSION,
      volumeIdentity: caseId,
      deterministicRecipe: 'indexed-volume-segments-v1',
      creationInput: 'lazy-generator-iterable',
      runtimeProvenance: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        runtimePackage: '@teable/v2-headless-runtime',
        backend: input.backend,
        backendMode: input.backend === 'pglite' ? 'memory://' : 'caller-provided-test-database',
      },
      setupTiming: 'excluded',
      setupOperations: ['CreateBaseCommand', 'CreateTableCommand'],
      measuredTiming: 'public command/query bus execute call only',
      timedOperations: CORE_VOLUME_CASES.map(({ identity }) => identity),
      correctnessTiming: 'excluded',
      correctnessValidation:
        'exhaustive paged readback of every deterministic field, exact segment distributions, and deleted-id set equality',
      samplePreparationTiming: 'excluded',
      samplePreparation:
        'exhaustive seeded-state readback collects actual record ids for supported id-based bulk deletion',
      cleanupTiming: 'excluded',
      cleanupOperation:
        'cleanupBenchBase after every isolated round; closeBenchRuntime after the run',
      sampleInvariant:
        'fresh owned base and populated deterministic table for every warmup and measured sample',
      operationIdentities: CORE_VOLUME_CASES.map(({ key, identity }) => ({ key, identity })),
      excludedCapabilities: ['undo', 'redo', 'realtime'],
      isolation:
        input.backend === 'pglite'
          ? 'fresh-memory-runtime-with-owned-base-cleanup-per-round'
          : 'caller-provided-test-database-with-owned-base-cleanup-per-round',
    },
  };
}
