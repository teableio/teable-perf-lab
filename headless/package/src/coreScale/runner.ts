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
  ListTableRecordsQuery,
  type ListTableRecordsResult,
  UpdateRecordCommand,
  type UpdateRecordResult,
} from '@teable/v2-core';
import { type IComputedFlushReport, type IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';

import { createRuntimeForBackend } from '../case/loadSteps';
import { closeBenchRuntime, registerBenchBase } from '../case/runtimeLifecycle';
import type { HttpBenchRun } from '../httpBench/runner';
import { normalizeValue } from '../oracle/normalize';
import { listAllRecords, tableRowCount } from '../oracle/paging';
import type { BenchOperationMeasurement } from '../runner/BenchRunner';
import {
  executeMeasured as executeOperation,
  finalizeMeasurement,
  makeMeasurements,
  RecordedOperationFailure,
  type MutableMeasurement,
} from '../runner/operationMeasurements';
import { resolveBenchCommit } from '../runner/provenance';
import {
  coreScaleCaseId,
  CORE_SCALE_CASE_ID_VERSION,
  CORE_SCALE_BASELINE_AMOUNT,
  CORE_SCALE_TARGET_AMOUNT,
  deterministicFanoutRow,
  deterministicSourceRow,
  resolveCoreScale,
  type CoreScaleSelection,
} from './scenarios';

export type RunCoreScaleBenchInput = {
  readonly backend: 'pglite' | 'postgres';
  readonly connectionString?: string;
  readonly samples: number;
  readonly warmup: number;
  readonly scale?: CoreScaleSelection;
};

export const CORE_SCALE_OPERATIONS = [
  { key: 'core:UpdateRecordCommand/source-amount', kind: 'write-update' },
  { key: 'core:IHeadlessRuntime.flushComputed/source-fanout', kind: 'flush-computed' },
  { key: 'core:ListTableRecordsQuery/fanout-page', kind: 'query-core' },
] as const satisfies ReadonlyArray<{
  key: string;
  kind: BenchOperationMeasurement['kind'];
}>;

type CoreScaleOperationKey = (typeof CORE_SCALE_OPERATIONS)[number]['key'];

type ScaleFixture = {
  readonly runtime: IHeadlessRuntime;
  readonly sourceRecordId: string;
  readonly fanoutRecordIds: ReadonlyArray<string>;
  readonly sourceTableId: string;
  readonly fanoutTableId: string;
  readonly summaryTableId: string;
};

const ACTOR_ID = 'usr_core_scale_bench';
const MAX_QUERY_PAGE = 1_000;

const IDS = {
  sourceTable: 'tblcorescalesource0',
  sourcePrimary: 'fldsourceprimary000',
  sourceAmount: 'fldsourceamount0000',
  sourceFormula: 'fldsourceformula000',
  fanoutTable: 'tblcorescalefanout0',
  fanoutPrimary: 'fldfanoutprimary000',
  fanoutBucket: 'fldfanoutbucket0000',
  fanoutSummaryKey: 'fldfanoutsumkey0000',
  fanoutLink: 'fldfanoutlink000000',
  fanoutLookup: 'fldfanoutlookup0000',
  fanoutFormula: 'fldfanoutformula000',
  fanoutConditional: 'fldfanoutcondlook00',
  summaryTable: 'tblcorescalesumry00',
  summaryPrimary: 'fldsummaryprimary00',
  summaryLink: 'fldsummarylink00000',
  summaryRollup: 'fldsummaryrollup000',
  summaryFormula: 'fldsummaryformula00',
  summaryConditionalLookup: 'fldsummarycondlook0',
  summaryConditionalRollup: 'fldsummarycondroll0',
} as const;

const context = () => ({ actorId: unwrap(ActorId.create(ACTOR_ID), 'actor id') });

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
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
};

const validateInput = (input: RunCoreScaleBenchInput): void => {
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

const createBase = async (runtime: IHeadlessRuntime): Promise<string> => {
  const result = unwrap(
    await runtime.commandBus.execute<CreateBaseCommand, CreateBaseResult>(
      context(),
      unwrap(CreateBaseCommand.create({ name: 'Core Scale Benchmark' }), 'create base command')
    ),
    'create base'
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
      unwrap(CreateTableCommand.create(input), 'create table command')
    ),
    'create table'
  );
  return result.table.id().toString();
};

const createSchema = async (runtime: IHeadlessRuntime, baseId: string): Promise<void> => {
  const sourceTableId = await createTable(runtime, {
    baseId,
    tableId: IDS.sourceTable,
    name: 'Scale Sources',
    fields: [
      {
        id: IDS.sourcePrimary,
        name: 'Source',
        type: 'singleLineText',
        isPrimary: true,
      },
      { id: IDS.sourceAmount, name: 'Amount', type: 'number' },
      {
        id: IDS.sourceFormula,
        name: 'Doubled',
        type: 'formula',
        options: { expression: `{${IDS.sourceAmount}} * 2` },
      },
    ],
    views: [{ type: 'grid', name: 'Grid' }],
  });
  assertEqual(sourceTableId, IDS.sourceTable, 'source table id');

  const fanoutTableId = await createTable(runtime, {
    baseId,
    tableId: IDS.fanoutTable,
    name: 'Scale Fanout',
    fields: [
      {
        id: IDS.fanoutPrimary,
        name: 'Fanout',
        type: 'singleLineText',
        isPrimary: true,
      },
      { id: IDS.fanoutBucket, name: 'Bucket', type: 'singleLineText' },
      { id: IDS.fanoutSummaryKey, name: 'Summary Key', type: 'singleLineText' },
      {
        id: IDS.fanoutLink,
        name: 'Source Link',
        type: 'link',
        options: {
          relationship: 'manyOne',
          foreignTableId: IDS.sourceTable,
          lookupFieldId: IDS.sourcePrimary,
          isOneWay: true,
        },
      },
      {
        id: IDS.fanoutLookup,
        name: 'Source Doubled',
        type: 'lookup',
        options: {
          linkFieldId: IDS.fanoutLink,
          foreignTableId: IDS.sourceTable,
          lookupFieldId: IDS.sourceFormula,
        },
      },
      {
        id: IDS.fanoutFormula,
        name: 'Amplified',
        type: 'formula',
        options: {
          expression: `IF(COUNTA({${IDS.fanoutLookup}})>0,SUM({${IDS.fanoutLookup}}),0) * 3`,
        },
      },
    ],
    views: [{ type: 'grid', name: 'Grid' }],
  });
  assertEqual(fanoutTableId, IDS.fanoutTable, 'fanout table id');

  const includedFilter = {
    filter: {
      conjunction: 'and' as const,
      filterSet: [
        {
          fieldId: IDS.fanoutBucket,
          operator: 'is' as const,
          value: 'included',
        },
      ],
    },
  };
  const summaryTableId = await createTable(runtime, {
    baseId,
    tableId: IDS.summaryTable,
    name: 'Scale Summary',
    fields: [
      {
        id: IDS.summaryPrimary,
        name: 'Summary',
        type: 'singleLineText',
        isPrimary: true,
      },
      {
        id: IDS.summaryLink,
        name: 'Fanout Links',
        type: 'link',
        options: {
          relationship: 'oneMany',
          foreignTableId: IDS.fanoutTable,
          lookupFieldId: IDS.fanoutPrimary,
          isOneWay: true,
        },
      },
      {
        id: IDS.summaryRollup,
        name: 'Linked Amplified Sum',
        type: 'rollup',
        options: { expression: 'sum({values})' },
        config: {
          linkFieldId: IDS.summaryLink,
          foreignTableId: IDS.fanoutTable,
          lookupFieldId: IDS.fanoutFormula,
        },
      },
      {
        id: IDS.summaryFormula,
        name: 'Linked Sum Doubled',
        type: 'formula',
        options: { expression: `{${IDS.summaryRollup}} * 2` },
      },
      {
        id: IDS.summaryConditionalLookup,
        name: 'Included Amplified Values',
        type: 'conditionalLookup',
        options: {
          foreignTableId: IDS.fanoutTable,
          lookupFieldId: IDS.fanoutFormula,
          condition: includedFilter,
        },
      },
      {
        id: IDS.summaryConditionalRollup,
        name: 'Included Amplified Sum',
        type: 'conditionalRollup',
        options: { expression: 'sum({values})' },
        config: {
          foreignTableId: IDS.fanoutTable,
          lookupFieldId: IDS.fanoutFormula,
          condition: includedFilter,
        },
      },
    ],
    views: [{ type: 'grid', name: 'Grid' }],
  });
  assertEqual(summaryTableId, IDS.summaryTable, 'summary table id');

  const conditionalFanout = unwrap(
    CreateFieldCommand.create({
      baseId,
      tableId: IDS.fanoutTable,
      field: {
        id: IDS.fanoutConditional,
        name: 'Summary Formula Lookup',
        type: 'conditionalLookup',
        options: {
          foreignTableId: IDS.summaryTable,
          lookupFieldId: IDS.summaryFormula,
          condition: {
            filter: {
              conjunction: 'and',
              filterSet: [
                {
                  fieldId: IDS.summaryPrimary,
                  operator: 'is',
                  value: IDS.fanoutSummaryKey,
                  isSymbol: true,
                },
              ],
            },
          },
        },
      },
    }),
    'create conditional fanout field command'
  );
  unwrap(
    await runtime.commandBus.execute<CreateFieldCommand, CreateFieldResult>(
      context(),
      conditionalFanout
    ),
    'create conditional fanout field'
  );
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
        'create records command'
      )
    ),
    'create records'
  );
  assertEqual(result.records.length, records.length, `created record count for ${tableId}`);
  return result.records.map((record) => record.id().toString());
};

const seedFixture = async (input: {
  readonly runtime: IHeadlessRuntime;
  readonly baseRows: number;
  readonly fanoutRows: number;
  readonly batchSize: number;
}): Promise<ScaleFixture> => {
  const baseId = await createBase(input.runtime);
  await createSchema(input.runtime, baseId);

  let sourceRecordId: string | undefined;
  for (let offset = 0; offset < input.baseRows; offset += input.batchSize) {
    const count = Math.min(input.batchSize, input.baseRows - offset);
    const ids = await createRecords(
      input.runtime,
      IDS.sourceTable,
      Array.from({ length: count }, (_, batchIndex) => {
        const row = deterministicSourceRow(offset + batchIndex);
        return {
          fields: {
            [IDS.sourcePrimary]: row.title,
            [IDS.sourceAmount]: row.amount,
          },
        };
      })
    );
    sourceRecordId ??= ids[0];
  }
  assert(sourceRecordId, 'Source seed did not create a target record');

  const fanoutRecordIds: string[] = [];
  for (let offset = 0; offset < input.fanoutRows; offset += input.batchSize) {
    const count = Math.min(input.batchSize, input.fanoutRows - offset);
    const ids = await createRecords(
      input.runtime,
      IDS.fanoutTable,
      Array.from({ length: count }, (_, batchIndex) => {
        const row = deterministicFanoutRow(offset + batchIndex);
        return {
          fields: {
            [IDS.fanoutPrimary]: row.title,
            [IDS.fanoutBucket]: row.bucket,
            [IDS.fanoutSummaryKey]: 'all-fanout',
            [IDS.fanoutLink]: [{ id: sourceRecordId }],
          },
        };
      })
    );
    fanoutRecordIds.push(...ids);
  }

  await createRecords(input.runtime, IDS.summaryTable, [
    {
      fields: {
        [IDS.summaryPrimary]: 'all-fanout',
        [IDS.summaryLink]: fanoutRecordIds.map((id) => ({ id })),
      },
    },
  ]);

  const setupFlush = await input.runtime.flushComputed();
  assertFullyDrained(setupFlush, 'setup computed queue');
  return {
    runtime: input.runtime,
    sourceRecordId,
    fanoutRecordIds,
    sourceTableId: IDS.sourceTable,
    fanoutTableId: IDS.fanoutTable,
    summaryTableId: IDS.summaryTable,
  };
};

const updateSource = async (fixture: ScaleFixture, amount: number): Promise<void> => {
  unwrap(
    await fixture.runtime.commandBus.execute<UpdateRecordCommand, UpdateRecordResult>(
      context(),
      unwrap(
        UpdateRecordCommand.create({
          tableId: fixture.sourceTableId,
          recordId: fixture.sourceRecordId,
          fieldKeyType: 'id',
          typecast: false,
          fields: { [IDS.sourceAmount]: amount },
        }),
        'update source command'
      )
    ),
    'update source'
  );
};

const queryFanoutPage = async (
  fixture: ScaleFixture,
  limit: number
): Promise<ListTableRecordsResult> =>
  unwrap(
    await fixture.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
      context(),
      unwrap(
        ListTableRecordsQuery.create({
          tableId: fixture.fanoutTableId,
          fieldKeyType: 'id',
          limit,
          offset: 0,
          includeTotal: true,
          projection: [
            IDS.fanoutLink,
            IDS.fanoutLookup,
            IDS.fanoutFormula,
            IDS.fanoutBucket,
            IDS.fanoutSummaryKey,
            IDS.fanoutConditional,
          ],
        }),
        'list fanout query'
      )
    ),
    'list fanout'
  );

const numericValue = (value: unknown, label: string): number => {
  const normalized = normalizeValue(value);
  assert(typeof normalized === 'number', `${label}: expected numeric value`);
  return normalized;
};

const numericValues = (value: unknown, label: string): ReadonlyArray<number> => {
  const normalized = normalizeValue(value);
  const entries = Array.isArray(normalized) ? normalized : [normalized];
  return entries.map((entry, index) => numericValue(entry, `${label}[${index}]`));
};

const linkedRecordIds = (value: unknown): ReadonlyArray<string> => {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];
  return entries.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (entry && typeof entry === 'object' && 'id' in entry && typeof entry.id === 'string') {
      return [entry.id];
    }
    return [];
  });
};

const fieldsOf = (record: Record<string, unknown>, label: string): Record<string, unknown> => {
  const fields = record.fields;
  assert(
    fields && typeof fields === 'object' && !Array.isArray(fields),
    `${label}: missing fields`
  );
  return fields as Record<string, unknown>;
};

const assertFanoutRecord = (
  record: Record<string, unknown>,
  sourceRecordId: string,
  expectedLookup: number,
  expectedFormula: number,
  expectedConditional: number,
  label: string
): void => {
  const fields = fieldsOf(record, label);
  assert(
    linkedRecordIds(fields[IDS.fanoutLink]).includes(sourceRecordId),
    `${label}: source link does not reference the target source record`
  );
  const lookup = numericValues(fields[IDS.fanoutLookup], `${label} lookup`);
  assertEqual(lookup.length, 1, `${label} lookup count`);
  assertEqual(lookup[0], expectedLookup, `${label} lookup value`);
  assertEqual(
    numericValue(fields[IDS.fanoutFormula], `${label} formula`),
    expectedFormula,
    `${label} formula value`
  );
  const conditional = numericValues(fields[IDS.fanoutConditional], `${label} conditional lookup`);
  assertEqual(conditional.length, 1, `${label} conditional lookup count`);
  assertEqual(conditional[0], expectedConditional, `${label} conditional lookup value`);
  assertEqual(fields[IDS.fanoutBucket], 'included', `${label} conditional bucket`);
  assertEqual(fields[IDS.fanoutSummaryKey], 'all-fanout', `${label} summary key`);
};

const assertFinalState = async (input: {
  readonly fixture: ScaleFixture;
  readonly baseRows: number;
  readonly fanoutRows: number;
  readonly expectedAmount: number;
}): Promise<void> => {
  const { fixture, baseRows, fanoutRows, expectedAmount } = input;
  assertEqual(
    await tableRowCount({ runtime: fixture.runtime, actorId: ACTOR_ID, tableId: IDS.sourceTable }),
    baseRows,
    'source row count'
  );
  assertEqual(
    await tableRowCount({ runtime: fixture.runtime, actorId: ACTOR_ID, tableId: IDS.fanoutTable }),
    fanoutRows,
    'fanout row count'
  );

  const expectedLookup = expectedAmount * 2;
  const expectedFormula = expectedLookup * 3;
  const expectedConditional = expectedFormula * fanoutRows * 2;
  const fanoutRecords = await listAllRecords({
    runtime: fixture.runtime,
    actorId: ACTOR_ID,
    tableId: IDS.fanoutTable,
    projection: [
      IDS.fanoutLink,
      IDS.fanoutLookup,
      IDS.fanoutFormula,
      IDS.fanoutBucket,
      IDS.fanoutSummaryKey,
      IDS.fanoutConditional,
    ],
  });
  assertEqual(fanoutRecords.length, fanoutRows, 'fanout readback count');
  const actualFanoutIds = new Set(fanoutRecords.map((record) => String(record.id)));
  assertEqual(actualFanoutIds.size, fanoutRows, 'distinct fanout record count');
  assertEqual(new Set(fixture.fanoutRecordIds).size, fanoutRows, 'distinct seeded fanout count');
  for (const recordId of fixture.fanoutRecordIds) {
    assert(actualFanoutIds.has(recordId), `seeded fanout record ${recordId} missing from readback`);
  }
  for (const [index, record] of fanoutRecords.entries()) {
    assertFanoutRecord(
      record,
      fixture.sourceRecordId,
      expectedLookup,
      expectedFormula,
      expectedConditional,
      `fanout record ${index}`
    );
  }

  const summaryRecords = await listAllRecords({
    runtime: fixture.runtime,
    actorId: ACTOR_ID,
    tableId: IDS.summaryTable,
    projection: [
      IDS.summaryLink,
      IDS.summaryRollup,
      IDS.summaryFormula,
      IDS.summaryConditionalLookup,
      IDS.summaryConditionalRollup,
    ],
  });
  assertEqual(summaryRecords.length, 1, 'summary row count');
  const summary = fieldsOf(summaryRecords[0]!, 'summary record');
  const summaryLinkIds = linkedRecordIds(summary[IDS.summaryLink]);
  assertEqual(summaryLinkIds.length, fanoutRows, 'summary linked count');
  const distinctSummaryLinkIds = new Set(summaryLinkIds);
  assertEqual(distinctSummaryLinkIds.size, fanoutRows, 'distinct summary linked count');
  for (const recordId of fixture.fanoutRecordIds) {
    assert(distinctSummaryLinkIds.has(recordId), `summary link missing fanout record ${recordId}`);
  }
  const expectedSum = expectedFormula * fanoutRows;
  assertEqual(
    numericValue(summary[IDS.summaryRollup], 'summary rollup'),
    expectedSum,
    'summary linked rollup'
  );
  assertEqual(
    numericValue(summary[IDS.summaryFormula], 'summary formula'),
    expectedSum * 2,
    'summary rollup formula'
  );
  const conditionalValues = numericValues(
    summary[IDS.summaryConditionalLookup],
    'summary conditional lookup'
  );
  assertEqual(conditionalValues.length, fanoutRows, 'summary conditional lookup count');
  for (const [index, value] of conditionalValues.entries()) {
    assertEqual(value, expectedFormula, `summary conditional lookup value ${index}`);
  }
  assertEqual(
    numericValue(summary[IDS.summaryConditionalRollup], 'summary conditional rollup'),
    expectedSum,
    'summary conditional rollup value'
  );
};

const restoreBaseline = async (input: {
  readonly fixture: ScaleFixture;
  readonly baseRows: number;
  readonly fanoutRows: number;
}): Promise<void> => {
  await updateSource(input.fixture, CORE_SCALE_BASELINE_AMOUNT);
  const resetFlush = await input.fixture.runtime.flushComputed();
  assertFullyDrained(resetFlush, 'untimed baseline reset queue');
  await assertFinalState({
    fixture: input.fixture,
    baseRows: input.baseRows,
    fanoutRows: input.fanoutRows,
    expectedAmount: CORE_SCALE_BASELINE_AMOUNT,
  });
};

const runRound = async (input: {
  readonly fixture: ScaleFixture;
  readonly measured: boolean;
  readonly fanoutRows: number;
  readonly measurements: Map<CoreScaleOperationKey, MutableMeasurement<CoreScaleOperationKey>>;
  readonly errors: string[];
}): Promise<void> => {
  await executeOperation({
    key: 'core:UpdateRecordCommand/source-amount',
    measured: input.measured,
    measurements: input.measurements,
    errors: input.errors,
    action: async () => {
      const started = performance.now();
      await updateSource(input.fixture, CORE_SCALE_TARGET_AMOUNT);
      const latencyMs = performance.now() - started;
      return {
        data: undefined,
        latencyMs,
        rowsWritten: 1,
        observation: {
          recordIds: [input.fixture.sourceRecordId],
          recordRelation: 'command-target',
          fieldNames: [IDS.sourceAmount],
          truncated: false,
        },
      };
    },
  });

  await executeOperation({
    key: 'core:IHeadlessRuntime.flushComputed/source-fanout',
    measured: input.measured,
    measurements: input.measurements,
    errors: input.errors,
    action: async () => {
      const started = performance.now();
      const report = await input.fixture.runtime.flushComputed();
      const latencyMs = performance.now() - started;
      assertFullyDrained(report, 'measured computed queue');
      return { data: report, latencyMs, processed: report.processed };
    },
  });

  await executeOperation({
    key: 'core:ListTableRecordsQuery/fanout-page',
    measured: input.measured,
    measurements: input.measurements,
    errors: input.errors,
    action: async () => {
      const requestedLimit = Math.min(MAX_QUERY_PAGE, input.fanoutRows);
      const started = performance.now();
      const result = await queryFanoutPage(input.fixture, requestedLimit);
      const latencyMs = performance.now() - started;
      assertEqual(result.total, input.fanoutRows, 'measured fanout query total');
      assertEqual(result.records.length, requestedLimit, 'measured fanout query page size');
      assertEqual(
        new Set(result.records.map((record) => String(record.id))).size,
        requestedLimit,
        'measured fanout query distinct record count'
      );
      const expectedLookup = CORE_SCALE_TARGET_AMOUNT * 2;
      const expectedFormula = expectedLookup * 3;
      const expectedConditional = expectedFormula * input.fanoutRows * 2;
      for (const [index, record] of result.records.entries()) {
        assertFanoutRecord(
          { id: record.id, fields: record.fields as Record<string, unknown> },
          input.fixture.sourceRecordId,
          expectedLookup,
          expectedFormula,
          expectedConditional,
          `measured fanout record ${index}`
        );
      }
      return {
        data: result,
        latencyMs,
        rowsRead: result.records.length,
        rowsReturned: result.records.length,
        observation: {
          recordIds: result.records.slice(0, 100).map((record) => String(record.id)),
          recordRelation: 'returned',
          fieldNames: [
            IDS.fanoutLink,
            IDS.fanoutLookup,
            IDS.fanoutFormula,
            IDS.fanoutBucket,
            IDS.fanoutSummaryKey,
            IDS.fanoutConditional,
          ],
          truncated: result.records.length > 100,
        },
      };
    },
  });
};

export async function runCoreScaleBench(input: RunCoreScaleBenchInput): Promise<HttpBenchRun> {
  validateInput(input);
  const scale = resolveCoreScale(input.scale);
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const measurements = makeMeasurements(CORE_SCALE_OPERATIONS);
  let runtime: IHeadlessRuntime | undefined;
  const caseId = coreScaleCaseId(scale);

  try {
    runtime = await createRuntimeForBackend({
      backend: input.backend,
      ...(input.connectionString ? { connectionString: input.connectionString } : {}),
    });
    const fixture = await seedFixture({ runtime, ...scale });
    for (let index = 0; index < input.warmup; index += 1) {
      await restoreBaseline({
        fixture,
        baseRows: scale.baseRows,
        fanoutRows: scale.fanoutRows,
      });
      await runRound({
        fixture,
        measured: false,
        fanoutRows: scale.fanoutRows,
        measurements,
        errors,
      });
    }
    for (let index = 0; index < input.samples; index += 1) {
      await restoreBaseline({
        fixture,
        baseRows: scale.baseRows,
        fanoutRows: scale.fanoutRows,
      });
      await runRound({
        fixture,
        measured: true,
        fanoutRows: scale.fanoutRows,
        measurements,
        errors,
      });
    }
    await assertFinalState({
      fixture,
      baseRows: scale.baseRows,
      fanoutRows: scale.fanoutRows,
      expectedAmount: CORE_SCALE_TARGET_AMOUNT,
    });
  } catch (error) {
    if (!(error instanceof RecordedOperationFailure)) {
      errors.push(`Core scale benchmark execution failed: ${errorMessage(error)}`);
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
    operations: CORE_SCALE_OPERATIONS.map(({ key }) => finalizeMeasurement(measurements.get(key)!)),
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
      baseRows: scale.baseRows,
      fanoutRows: scale.fanoutRows,
      seededRows: scale.baseRows + scale.fanoutRows + 1,
      batchSize: scale.batchSize,
      caseIdentityVersion: CORE_SCALE_CASE_ID_VERSION,
      scaleIdentity: caseId,
      measuredQueryRows: Math.min(MAX_QUERY_PAGE, scale.fanoutRows),
      deterministicRecipe: 'indexed-source-and-fanout-v1',
      setupTiming: 'excluded',
      samplePreparationTiming: 'excluded',
      measuredTiming:
        'target UpdateRecordCommand, target flushComputed, and target ListTableRecordsQuery only',
      correctnessValidation: 'untimed-core-readback-and-flush-report',
      sampleInvariant: {
        baselineAmount: CORE_SCALE_BASELINE_AMOUNT,
        targetAmount: CORE_SCALE_TARGET_AMOUNT,
        resetBeforeEveryRound:
          'untimed UpdateRecordCommand + flushComputed + exhaustive core readback',
        measuredTransition: 'constant baseline-to-target update on one reused seeded graph',
        runtimeReuse: 'one runtime and one seeded graph across warmup and measured samples',
      },
      propagationPath: [
        'Scale Sources.Amount',
        'Scale Sources.Doubled (formula)',
        'Scale Fanout.Source Doubled (lookup)',
        'Scale Fanout.Amplified (formula)',
        'Scale Summary.Linked Amplified Sum (rollup)',
        'Scale Summary.Linked Sum Doubled (formula)',
        'Scale Fanout.Summary Formula Lookup (conditional lookup)',
        'Scale Summary.Included Amplified Values (conditional lookup)',
        'Scale Summary.Included Amplified Sum (conditional rollup)',
      ],
      operationIdentities: CORE_SCALE_OPERATIONS.map(({ key }) => key),
      excludedCapabilities: ['undo', 'redo', 'realtime'],
      isolation:
        input.backend === 'pglite'
          ? 'fresh-memory-runtime-with-owned-base-cleanup'
          : 'caller-provided-test-database-with-owned-base-cleanup',
    },
  };
}
