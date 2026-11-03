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
  type IFieldUpdateInput,
  ListFieldsQuery,
  type ListFieldsResult,
  ListTableRecordsQuery,
  type ListTableRecordsResult,
  UpdateFieldCommand,
  type UpdateFieldResult,
} from '@teable/v2-core';
import type { IComputedFlushReport, IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';

import { createRuntimeForBackend } from '../case/loadSteps';
import { cleanupBenchBase, closeBenchRuntime, registerBenchBase } from '../case/runtimeLifecycle';
import type { RunCoreOpsBenchInput } from '../coreOps/runner';
import type { HttpBenchRun } from '../httpBench/runner';
import {
  finalizeMeasurementReplacingWarnings as finalize,
  makeMeasurements,
  RecordedBenchFailure,
  recordMeasuredResult,
  recordOperationFailure,
  type MutableMeasurement,
  type OperationResult as MeasuredOperationResult,
} from '../runner/operationMeasurements';
import { resolveBenchCommit } from '../runner/provenance';
import { CORE_FIELD_TRANSITIONS_CASES, type CoreFieldTransitionsBenchCaseKey } from './cases';

export type RunCoreFieldTransitionsBenchInput = RunCoreOpsBenchInput;
export type CoreFieldTransitionsBenchRun = HttpBenchRun;

type FixtureRow = {
  readonly title: string;
  readonly raw: string | null;
  readonly number: number | null;
  readonly formatted: string | null;
  readonly guard: number;
};
type Fixture = {
  readonly runtime: IHeadlessRuntime;
  readonly tableId: string;
  readonly fields: Readonly<
    Record<'title' | 'source' | 'original' | 'guard' | 'presence' | 'chain', string>
  >;
  readonly recordIdsByTitle: ReadonlyMap<string, string>;
};
type State = {
  readonly source: 'raw' | 'number' | 'formatted';
  readonly multiplier: 1 | 2;
};
type OperationResult = Omit<MeasuredOperationResult<void>, 'data'>;

const CASE_ID = 'headless-core-field-transitions-mixed-64-v1';
const ROW_COUNT = 64;
const ACTOR_ID = 'usr_core_field_transitions';
// Explicit expected values, not the production converter or a parsing approximation.
const INPUT_VALUES = [
  { raw: '100', number: 100, formatted: '100.00' },
  { raw: '-25', number: -25, formatted: '-25.00' },
  { raw: '3.5', number: 3.5, formatted: '3.50' },
  { raw: '0', number: 0, formatted: '0.00' },
  { raw: null, number: null, formatted: null },
  { raw: 'abc', number: null, formatted: null },
  { raw: '12abc', number: null, formatted: null },
  { raw: '42', number: 42, formatted: '42.00' },
] as const;
const ROWS: ReadonlyArray<FixtureRow> = Array.from({ length: ROW_COUNT }, (_, index) => ({
  title: `transition-${String(index + 1).padStart(2, '0')}`,
  ...INPUT_VALUES[index % INPUT_VALUES.length]!,
  guard: index + 101,
}));

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error) ?? String(error);
};
const unwrap = <T, E>(result: Result<T, E>, label: string): T => {
  if (result.isErr()) throw new Error(`${label}: ${errorMessage(result.error)}`);
  return result.value;
};
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const equal = (actual: unknown, expected: unknown, label: string): void => {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    );
  }
};
const context = () => ({ actorId: unwrap(ActorId.create(ACTOR_ID), 'fieldTransitions.actor') });
const expression = (sourceId: string, multiplier: number): string =>
  `COUNTA({${sourceId}}) * ${multiplier}`;
const chainExpression = (presenceId: string, guardId: string): string =>
  `{${presenceId}} + {${guardId}}`;

const listFields = async (
  fixture: Pick<Fixture, 'runtime' | 'tableId'>
): Promise<ListFieldsResult> =>
  unwrap(
    await fixture.runtime.queryBus.execute<ListFieldsQuery, ListFieldsResult>(
      context(),
      unwrap(ListFieldsQuery.create({ tableId: fixture.tableId }), 'fieldTransitions.fields.input')
    ),
    'fieldTransitions.fields.query'
  );
const listRecords = async (
  fixture: Pick<Fixture, 'runtime' | 'tableId'>
): Promise<ListTableRecordsResult> =>
  unwrap(
    await fixture.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
      context(),
      unwrap(
        ListTableRecordsQuery.create({
          tableId: fixture.tableId,
          fieldKeyType: 'id',
          limit: 100,
          offset: 0,
          includeTotal: true,
          ignoreViewQuery: true,
        }),
        'fieldTransitions.records.input'
      )
    ),
    'fieldTransitions.records.query'
  );

const assertDrained = (report: IComputedFlushReport): void => {
  equal(report.drained, true, 'computed drained');
  equal(report.state, 'no_claimable_work', 'computed queue state');
  for (const key of ['pending', 'scheduled', 'processing', 'paused', 'deadLetter'] as const) {
    equal(report[key], 0, `computed ${key}`);
  }
};

const assertSchema = async (fixture: Fixture, state: State): Promise<void> => {
  const fields = (await listFields(fixture)).fields;
  equal(fields.length, 6, 'persisted field count');
  const expected = [
    [fixture.fields.title, 'Title', 'singleLineText'],
    [fixture.fields.source, 'Convertible', state.source === 'number' ? 'number' : 'singleLineText'],
    [fixture.fields.original, 'Original', 'singleLineText'],
    [fixture.fields.guard, 'Guard', 'number'],
    [fixture.fields.presence, 'Presence', 'formula'],
    [fixture.fields.chain, 'Chain', 'formula'],
  ] as const;
  for (const [id, name, type] of expected) {
    const field = fields.find((candidate) => candidate.id().toString() === id);
    assert(field, `Missing persisted field ${id}`);
    equal(field.name().toString(), name, `field ${id} name`);
    equal(field.type().toString(), type, `field ${id} type`);
  }
  const presence = fields.find((field) => field.id().toString() === fixture.fields.presence);
  const chain = fields.find((field) => field.id().toString() === fixture.fields.chain);
  assert(presence instanceof FormulaField && chain instanceof FormulaField, 'Formula schema types');
  equal(
    presence.expression().toString(),
    expression(fixture.fields.source, state.multiplier),
    'presence expression'
  );
  equal(
    chain.expression().toString(),
    chainExpression(fixture.fields.presence, fixture.fields.guard),
    'chain expression'
  );
};

const assertRecords = async (fixture: Fixture, state: State, computed: boolean): Promise<void> => {
  const result = await listRecords(fixture);
  equal(result.total, ROW_COUNT, 'persisted total');
  equal(result.records.length, ROW_COUNT, 'persisted page count');
  const seen = new Set<string>();
  for (const record of result.records) {
    const title = record.fields[fixture.fields.title];
    const row = ROWS.find((candidate) => candidate.title === title);
    assert(row, `Unexpected persisted title ${String(title)}`);
    equal(record.id, fixture.recordIdsByTitle.get(row.title), `record identity ${row.title}`);
    assert(!seen.has(record.id), `Duplicate record ${record.id}`);
    seen.add(record.id);
    const source =
      state.source === 'raw' ? row.raw : state.source === 'number' ? row.number : row.formatted;
    equal(record.fields[fixture.fields.source] ?? null, source, `converted value ${row.title}`);
    equal(
      record.fields[fixture.fields.original] ?? null,
      row.raw,
      `untouched original ${row.title}`
    );
    equal(record.fields[fixture.fields.guard], row.guard, `untouched guard ${row.title}`);
    if (computed) {
      const presence = (source == null ? 0 : 1) * state.multiplier;
      equal(record.fields[fixture.fields.presence], presence, `presence ${row.title}`);
      equal(record.fields[fixture.fields.chain], row.guard + presence, `chain ${row.title}`);
    }
  }
  equal(seen.size, fixture.recordIdsByTitle.size, 'exact persisted identity set');
};
const assertState = async (fixture: Fixture, state: State, computed = true): Promise<void> => {
  await assertSchema(fixture, state);
  await assertRecords(fixture, state, computed);
};

const createFixture = async (runtime: IHeadlessRuntime, baseId: string): Promise<Fixture> => {
  const created = unwrap(
    await runtime.commandBus.execute<CreateTableCommand, CreateTableResult>(
      context(),
      unwrap(
        CreateTableCommand.create({
          baseId,
          name: 'Mixed Field Transitions',
          fields: [
            { name: 'Title', type: 'singleLineText', isPrimary: true },
            { name: 'Convertible', type: 'singleLineText' },
            { name: 'Original', type: 'singleLineText' },
            { name: 'Guard', type: 'number' },
          ],
        }),
        'fieldTransitions.table.input'
      )
    ),
    'fieldTransitions.table.create'
  );
  const tableId = created.table.id().toString();
  const fieldId = (name: string): string => {
    const field = created.table
      .getFields()
      .find((candidate) => candidate.name().toString() === name);
    assert(field, `Missing created field ${name}`);
    return field.id().toString();
  };
  const initial = {
    title: fieldId('Title'),
    source: fieldId('Convertible'),
    original: fieldId('Original'),
    guard: fieldId('Guard'),
  };
  const inserted = unwrap(
    await runtime.commandBus.execute<CreateRecordsCommand, CreateRecordsResult>(
      context(),
      unwrap(
        CreateRecordsCommand.create({
          tableId,
          fieldKeyType: 'id',
          typecast: false,
          records: ROWS.map((row) => ({
            fields: {
              [initial.title]: row.title,
              [initial.source]: row.raw,
              [initial.original]: row.raw,
              [initial.guard]: row.guard,
            },
          })),
        }),
        'fieldTransitions.records.create.input'
      )
    ),
    'fieldTransitions.records.create'
  );
  equal(inserted.records.length, ROW_COUNT, 'created row count');
  const recordIdsByTitle = new Map<string, string>();
  for (const record of (await listRecords({ runtime, tableId })).records) {
    const title = record.fields[initial.title];
    assert(typeof title === 'string', 'Seeded title must be a string');
    assert(!recordIdsByTitle.has(title), `Duplicate seeded title ${title}`);
    recordIdsByTitle.set(title, record.id);
  }
  equal(recordIdsByTitle.size, ROW_COUNT, 'seeded identity count');
  const addFormula = async (name: string, formula: string): Promise<string> => {
    const result = unwrap(
      await runtime.commandBus.execute<CreateFieldCommand, CreateFieldResult>(
        context(),
        unwrap(
          CreateFieldCommand.create({
            baseId,
            tableId,
            field: {
              name,
              type: 'formula',
              options: { expression: formula },
            },
          }),
          'fieldTransitions.formula.input'
        )
      ),
      'fieldTransitions.formula.create'
    );
    const field = result.table
      .getFields()
      .find((candidate) => candidate.name().toString() === name);
    assert(field instanceof FormulaField, `Missing created formula ${name}`);
    return field.id().toString();
  };
  const presence = await addFormula('Presence', expression(initial.source, 1));
  const chain = await addFormula('Chain', chainExpression(presence, initial.guard));
  const fixture: Fixture = {
    runtime,
    tableId,
    fields: { ...initial, presence, chain },
    recordIdsByTitle,
  };
  assertDrained(await runtime.flushComputed());
  await assertState(fixture, { source: 'raw', multiplier: 1 });
  return fixture;
};

const updateField = async (
  fixture: Fixture,
  fieldId: string,
  field: IFieldUpdateInput
): Promise<OperationResult> => {
  const command = unwrap(
    UpdateFieldCommand.create({ tableId: fixture.tableId, fieldId, field }),
    'fieldTransitions.update.input'
  );
  const started = performance.now();
  const result = await fixture.runtime.commandBus.execute<UpdateFieldCommand, UpdateFieldResult>(
    context(),
    command
  );
  const latencyMs = performance.now() - started;
  const updated = unwrap(result, 'fieldTransitions.update.execute');
  equal(updated.table.id().toString(), fixture.tableId, 'updated table identity');
  const target = updated.table
    .getFields()
    .find((candidate) => candidate.id().toString() === fieldId);
  assert(target, 'updated field identity');
  if (field.type != null) equal(target.type().toString(), field.type, 'updated field type');
  if (typeof field.options?.expression === 'string') {
    assert(target instanceof FormulaField, 'updated formula type');
    equal(target.expression().toString(), field.options.expression, 'updated formula expression');
  }
  return { latencyMs, rowsWritten: ROW_COUNT };
};
const flush = async (fixture: Fixture, state: State): Promise<OperationResult> => {
  const started = performance.now();
  const report = await fixture.runtime.flushComputed();
  const latencyMs = performance.now() - started;
  assertDrained(report);
  await assertState(fixture, state);
  return { latencyMs, processed: report.processed };
};
const rejectNonStringFormula = async (fixture: Fixture): Promise<OperationResult> => {
  const command = unwrap(
    UpdateFieldCommand.create({
      tableId: fixture.tableId,
      fieldId: fixture.fields.presence,
      field: { options: { expression: 42 } },
    }),
    'fieldTransitions.rejected.input'
  );
  const started = performance.now();
  const result = await fixture.runtime.commandBus.execute<UpdateFieldCommand, UpdateFieldResult>(
    context(),
    command
  );
  const latencyMs = performance.now() - started;
  assert(result.isErr(), 'Non-string formula expression unexpectedly succeeded');
  equal(result.error.code, 'validation.invalid', 'non-string formula error code');
  equal(result.error.message, 'Invalid FormulaExpression', 'non-string formula error message');
  equal(
    JSON.stringify(result.error.tags),
    JSON.stringify(['validation']),
    'non-string formula error tags'
  );
  await assertState(fixture, { source: 'formatted', multiplier: 2 });
  // Failed admission must not leave pending or dead-letter work, either.
  const report = await fixture.runtime.flushComputed();
  assertDrained(report);
  equal(report.processed, 0, 'rejected formula scheduled no computed work');
  await assertState(fixture, { source: 'formatted', multiplier: 2 });
  return { latencyMs, rowsWritten: 0 };
};

const runTransitions = async (input: {
  fixture: Fixture;
  measured: boolean;
  measurements: Map<
    CoreFieldTransitionsBenchCaseKey,
    MutableMeasurement<CoreFieldTransitionsBenchCaseKey>
  >;
  errors: string[];
}): Promise<void> => {
  const execute = async (
    key: CoreFieldTransitionsBenchCaseKey,
    action: () => Promise<OperationResult>
  ): Promise<void> => {
    const measurement = input.measurements.get(key)!;
    try {
      const result = await action();
      recordMeasuredResult(measurement, input.measured, result);
    } catch (error) {
      throw recordOperationFailure(measurement, input.errors, key, error);
    }
  };
  const fixture = input.fixture;
  const numeric: State = { source: 'number', multiplier: 1 };
  const formatted: State = { source: 'formatted', multiplier: 1 };
  const doubled: State = { source: 'formatted', multiplier: 2 };
  await execute('core:UpdateFieldCommand/text-to-number-mixed-64', async () => {
    const response = await updateField(fixture, fixture.fields.source, {
      type: 'number',
      options: { formatting: { type: 'decimal', precision: 2 } },
    });
    await assertState(fixture, numeric, false);
    return response;
  });
  await execute('core:IHeadlessRuntime.flushComputed/text-to-number-mixed-64', () =>
    flush(fixture, numeric)
  );
  await execute('core:UpdateFieldCommand/number-to-text-formatted-64', async () => {
    const response = await updateField(fixture, fixture.fields.source, { type: 'singleLineText' });
    await assertState(fixture, formatted, false);
    return response;
  });
  await execute('core:IHeadlessRuntime.flushComputed/number-to-text-formatted-64', () =>
    flush(fixture, formatted)
  );
  await execute('core:UpdateFieldCommand/dependent-formula-expression-64', async () => {
    const response = await updateField(fixture, fixture.fields.presence, {
      options: { expression: expression(fixture.fields.source, 2) },
    });
    await assertState(fixture, doubled, false);
    return response;
  });
  await execute('core:IHeadlessRuntime.flushComputed/dependent-formula-expression-64', () =>
    flush(fixture, doubled)
  );
  await execute('core:UpdateFieldCommand/reject-nonstring-formula-expression', () =>
    rejectNonStringFormula(fixture)
  );
};

const runRound = async (input: {
  runtime: IHeadlessRuntime;
  round: number;
  measured: boolean;
  measurements: Map<
    CoreFieldTransitionsBenchCaseKey,
    MutableMeasurement<CoreFieldTransitionsBenchCaseKey>
  >;
  errors: string[];
}): Promise<void> => {
  const created = unwrap(
    await input.runtime.commandBus.execute<CreateBaseCommand, CreateBaseResult>(
      context(),
      unwrap(
        CreateBaseCommand.create({ name: `Core Field Transitions ${input.round}` }),
        'fieldTransitions.base.input'
      )
    ),
    'fieldTransitions.base.create'
  );
  const baseId = created.base.id().toString();
  registerBenchBase(input.runtime, baseId);
  let roundError: unknown;
  try {
    await runTransitions({ ...input, fixture: await createFixture(input.runtime, baseId) });
  } catch (error) {
    roundError = error;
  } finally {
    try {
      await cleanupBenchBase(input.runtime, baseId);
    } catch (error) {
      const failure = new RecordedBenchFailure(
        `Field transition cleanup failed: ${errorMessage(error)}`
      );
      input.errors.push(failure.message);
      if (!roundError) roundError = failure;
    }
  }
  if (roundError) throw roundError;
};
const validate = (input: RunCoreFieldTransitionsBenchInput): void => {
  if (!Number.isInteger(input.samples) || input.samples < 1)
    throw new Error('samples must be a positive integer');
  if (!Number.isInteger(input.warmup) || input.warmup < 0)
    throw new Error('warmup must be a non-negative integer');
  if (input.backend === 'postgres' && !input.connectionString)
    throw new Error('connectionString is required for the postgres backend');
};

/** Direct Core conversion and dependent-formula workload; setup/readback are untimed. */
export async function runCoreFieldTransitionsBench(
  input: RunCoreFieldTransitionsBenchInput
): Promise<CoreFieldTransitionsBenchRun> {
  validate(input);
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const measurements = makeMeasurements(CORE_FIELD_TRANSITIONS_CASES);
  let runtime: IHeadlessRuntime | undefined;
  try {
    runtime = await createRuntimeForBackend({
      backend: input.backend,
      ...(input.connectionString ? { connectionString: input.connectionString } : {}),
    });
    for (let round = 0; round < input.warmup + input.samples; round += 1) {
      await runRound({ runtime, round, measured: round >= input.warmup, measurements, errors });
    }
  } catch (error) {
    if (!(error instanceof RecordedBenchFailure))
      errors.push(`Field transition execution failed: ${errorMessage(error)}`);
  } finally {
    if (runtime) {
      try {
        await closeBenchRuntime(runtime);
      } catch (error) {
        errors.push(`Field transition runtime cleanup failed: ${errorMessage(error)}`);
      }
    }
  }
  return {
    caseId: CASE_ID,
    operations: CORE_FIELD_TRANSITIONS_CASES.map(({ key }) => finalize(measurements.get(key)!)),
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
      caseIdentityVersion: 1,
      populatedRows: ROW_COUNT,
      fixtureValueCounts: { validNumericStrings: 40, nulls: 8, invalidStrings: 16 },
      conversionSemantics: {
        textToNumber: 'valid strings convert exactly; invalid strings become null; null stays null',
        numberToText: 'source decimal formatting with precision 2; null stays null',
        intentionalLoss:
          '16 invalid Convertible cells become null; untouched Original preserves every source string',
      },
      dependentFormulas: ['COUNTA(Convertible) * multiplier', 'Presence + Guard'],
      formulaMultipliers: [1, 2],
      expectedRejectedOperation: {
        key: 'core:UpdateFieldCommand/reject-nonstring-formula-expression',
        code: 'validation.invalid',
        message: 'Invalid FormulaExpression',
        tags: ['validation'],
      },
      expectedRejectionAccounting:
        'successful expected-error assertion is a measured sample, not a benchmark error',
      setupTiming: 'excluded',
      computedDrainTiming: 'measured-separately-from-triggering-command',
      persistedReadbackTiming: 'excluded',
      correctnessValidation:
        'exact field identities, types, expressions, record identities and all six cell values; computed cells checked after drains',
      sampleIsolation: {
        fixturePerRound:
          'fresh registered base and generated table/field/record identities with deterministic 64-row content',
        cleanup: 'cleanupBenchBase removes only the round-owned registered base',
        runtimeReuse: 'one runtime across rounds; no fixture state is reused',
      },
      operationIdentities: Object.fromEntries(
        CORE_FIELD_TRANSITIONS_CASES.map(({ key, identity }) => [key, identity])
      ),
      excludedCapabilities: ['undo', 'redo', 'realtime'],
      scope:
        'singleLineText→number→singleLineText plus two-level dependent formula recomputation; not an exhaustive field-type conversion matrix',
      isolation:
        input.backend === 'pglite'
          ? 'fresh-memory-runtime-with-owned-base-per-round-cleanup'
          : 'caller-provided-test-database-with-owned-base-per-round-cleanup',
    },
  };
}
