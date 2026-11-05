import { performance } from 'node:perf_hooks';

import {
  ActorId,
  CreateBaseCommand,
  type CreateBaseResult,
  type ICreateFieldCommandInput,
  CreateFieldCommand,
  type CreateFieldResult,
  CreateRecordsCommand,
  type CreateRecordsResult,
  CreateTableCommand,
  type CreateTableResult,
  DeleteRecordsCommand,
  type DeleteRecordsResult,
  type Field,
  FieldOptionsDtoVisitor,
  ListFieldsQuery,
  type ListFieldsResult,
  ListTableRecordsQuery,
  type ListTableRecordsResult,
  LookupField,
  RollupField,
  UpdateRecordCommand,
  type UpdateRecordResult,
  UpdateRecordsCommand,
  type UpdateRecordsResult,
} from '@teable/v2-core';
import { type IComputedFlushReport, type IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';

import { createRuntimeForBackend } from '../case/loadSteps';
import { cleanupBenchBase, closeBenchRuntime, registerBenchBase } from '../case/runtimeLifecycle';
import type { RunCoreOpsBenchInput } from '../coreOps/runner';
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
import { CORE_RELATION_CASES, type CoreRelationCasesBenchCaseKey } from './cases';

export { CORE_RELATION_CASES, type CoreRelationCasesBenchCase } from './cases';

export type RunCoreRelationCasesBenchInput = RunCoreOpsBenchInput;
export type CoreRelationCasesBenchRun = HttpBenchRun;

type ExecutionContext = { readonly actorId: ActorId };
type NamedRecord = { readonly id: string; readonly title: string };
type ParentRecord = NamedRecord & { readonly score: number };
type ChildRecord = NamedRecord & { readonly amount: number };
type FixtureSeed = {
  readonly runtime: IHeadlessRuntime;
  readonly baseId: string;
  readonly profiles: readonly [NamedRecord, NamedRecord, NamedRecord];
  readonly user: NamedRecord;
  readonly parents: readonly [ParentRecord, ParentRecord, ParentRecord];
  readonly children: ReadonlyArray<ChildRecord>;
};
type RelationFixture = FixtureSeed & {
  readonly profileUsersFieldId: string;
  readonly parentChildrenFieldId: string;
};
type ExpectedState = {
  readonly oneOneProfileId?: string;
  readonly childParents: ReadonlyMap<string, string>;
  readonly existingParentIds: ReadonlySet<string>;
};

const CASE_ID = 'headless-core-relation-cases-v1';
const CASE_IDENTITY_VERSION = 1;
const ACTOR_ID = 'usr_core_relation_cases_bench';
const CHILD_ROWS = 48;
const REASSIGN_ROWS = 16;
const CLEAR_ROWS = 8;

const IDS = {
  profileTable: 'tblpppppppppppppppp',
  profilePrimary: 'fldpppppppppppppppp',
  userTable: 'tbluuuuuuuuuuuuuuuu',
  userPrimary: 'flduuuuuuuuuuuuuuuu',
  userProfile: 'fldoooooooooooooooo',
  parentTable: 'tblaaaaaaaaaaaaaaaa',
  parentPrimary: 'fldaaaaaaaaaaaaaaaa',
  parentScore: 'fldbbbbbbbbbbbbbbbb',
  parentChildLookup: 'fldcccccccccccccccc',
  parentChildRollup: 'flddddddddddddddddd',
  childTable: 'tbleeeeeeeeeeeeeeee',
  childPrimary: 'fldeeeeeeeeeeeeeeee',
  childAmount: 'fldffffffffffffffff',
  childParent: 'fldgggggggggggggggg',
  childParentLookup: 'fldhhhhhhhhhhhhhhhh',
  childParentRollup: 'fldiiiiiiiiiiiiiiii',
} as const;

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

const assertMembers = <T extends string | number>(
  actual: ReadonlyArray<T>,
  expected: ReadonlyArray<T>,
  label: string
): void => {
  const compare = (left: T, right: T): number =>
    typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right));
  const actualSorted = [...actual].sort(compare);
  const expectedSorted = [...expected].sort(compare);
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

const observation = (
  recordIds: ReadonlyArray<string>,
  fieldNames: ReadonlyArray<string>
): BenchOperationObservation => ({
  recordIds: recordIds.slice(0, 100),
  recordRelation: 'command-target',
  fieldNames: [...fieldNames],
  truncated: recordIds.length > 100,
});

const context = (): ExecutionContext => ({
  actorId: unwrap(ActorId.create(ACTOR_ID), 'coreRelationCases.actor.invalid'),
});

const validateInput = (input: RunCoreRelationCasesBenchInput): void => {
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
        CreateBaseCommand.create({ name: `Core Relation Cases Benchmark ${round}` }),
        'coreRelationCases.base.create.invalid'
      )
    ),
    'coreRelationCases.base.create.failed'
  );
  const baseId = result.base.id().toString();
  registerBenchBase(runtime, baseId);
  return baseId;
};

const createTable = async (
  runtime: IHeadlessRuntime,
  input: Parameters<typeof CreateTableCommand.create>[0]
): Promise<void> => {
  unwrap(
    await runtime.commandBus.execute<CreateTableCommand, CreateTableResult>(
      context(),
      unwrap(CreateTableCommand.create(input), 'coreRelationCases.table.create.invalid')
    ),
    'coreRelationCases.table.create.failed'
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
        'coreRelationCases.records.create.invalid'
      )
    ),
    'coreRelationCases.records.create.failed'
  );
  assertEqual(result.records.length, records.length, `created record count for ${tableId}`);
  return result.records.map((record) => record.id().toString());
};

const createFixtureSeed = async (
  runtime: IHeadlessRuntime,
  baseId: string
): Promise<FixtureSeed> => {
  await createTable(runtime, {
    baseId,
    tableId: IDS.profileTable,
    name: 'Relation Profiles',
    fields: [{ id: IDS.profilePrimary, name: 'Profile', type: 'singleLineText', isPrimary: true }],
    views: [{ type: 'grid', name: 'Grid' }],
  });
  await createTable(runtime, {
    baseId,
    tableId: IDS.userTable,
    name: 'Relation Users',
    fields: [{ id: IDS.userPrimary, name: 'User', type: 'singleLineText', isPrimary: true }],
    views: [{ type: 'grid', name: 'Grid' }],
  });
  await createTable(runtime, {
    baseId,
    tableId: IDS.parentTable,
    name: 'Relation Parents',
    fields: [
      { id: IDS.parentPrimary, name: 'Parent', type: 'singleLineText', isPrimary: true },
      { id: IDS.parentScore, name: 'Score', type: 'number' },
    ],
    views: [{ type: 'grid', name: 'Grid' }],
  });
  await createTable(runtime, {
    baseId,
    tableId: IDS.childTable,
    name: 'Relation Children',
    fields: [
      { id: IDS.childPrimary, name: 'Child', type: 'singleLineText', isPrimary: true },
      { id: IDS.childAmount, name: 'Amount', type: 'number' },
    ],
    views: [{ type: 'grid', name: 'Grid' }],
  });

  const profileIds = await createRecords(
    runtime,
    IDS.profileTable,
    ['profile-a', 'profile-b', 'profile-c'].map((title) => ({
      fields: { [IDS.profilePrimary]: title },
    }))
  );
  const [userId] = await createRecords(runtime, IDS.userTable, [
    { fields: { [IDS.userPrimary]: 'relation-user' } },
  ]);
  const parentSeeds = [
    { title: 'parent-a', score: 101 },
    { title: 'parent-b', score: 202 },
    { title: 'parent-c', score: 303 },
  ] as const;
  const parentIds = await createRecords(
    runtime,
    IDS.parentTable,
    parentSeeds.map(({ title, score }) => ({
      fields: { [IDS.parentPrimary]: title, [IDS.parentScore]: score },
    }))
  );
  const childIds = await createRecords(
    runtime,
    IDS.childTable,
    Array.from({ length: CHILD_ROWS }, (_, index) => ({
      fields: {
        [IDS.childPrimary]: `child-${index.toString().padStart(3, '0')}`,
        [IDS.childAmount]: index + 1,
      },
    }))
  );

  assert(profileIds[0] && profileIds[1] && profileIds[2], 'Profile records were not created');
  assert(userId, 'User record was not created');
  assert(parentIds[0] && parentIds[1] && parentIds[2], 'Parent records were not created');
  assertEqual(childIds.length, CHILD_ROWS, 'Child fixture size');

  return {
    runtime,
    baseId,
    profiles: [
      { id: profileIds[0], title: 'profile-a' },
      { id: profileIds[1], title: 'profile-b' },
      { id: profileIds[2], title: 'profile-c' },
    ],
    user: { id: userId, title: 'relation-user' },
    parents: [
      { id: parentIds[0], ...parentSeeds[0] },
      { id: parentIds[1], ...parentSeeds[1] },
      { id: parentIds[2], ...parentSeeds[2] },
    ],
    children: childIds.map((id, index) => ({
      id,
      title: `child-${index.toString().padStart(3, '0')}`,
      amount: index + 1,
    })),
  };
};

const listFields = async (runtime: IHeadlessRuntime, tableId: string): Promise<ListFieldsResult> =>
  unwrap(
    await runtime.queryBus.execute<ListFieldsQuery, ListFieldsResult>(
      context(),
      unwrap(
        ListFieldsQuery.create({ tableId }),
        `coreRelationCases.fields.list.invalid:${tableId}`
      )
    ),
    `coreRelationCases.fields.list.failed:${tableId}`
  );

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
        `coreRelationCases.records.list.invalid:${tableId}`
      )
    ),
    `coreRelationCases.records.list.failed:${tableId}`
  );

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

const numericValues = (value: unknown, label: string): ReadonlyArray<number> => {
  const normalized = normalizeValue(value);
  if (normalized == null) return [];
  const entries = Array.isArray(normalized) ? normalized : [normalized];
  return entries.map((entry, index) => {
    assert(typeof entry === 'number', `${label}[${index}]: expected numeric value`);
    return entry;
  });
};

const numericValue = (value: unknown, label: string): number => {
  const normalized = normalizeValue(value);
  assert(typeof normalized === 'number', `${label}: expected numeric value`);
  return normalized;
};

const fieldById = (result: ListFieldsResult, fieldId: string, label: string) => {
  const field = result.fields.find((candidate) => candidate.id().toString() === fieldId);
  assert(field, `${label}: missing field ${fieldId}`);
  return field;
};

const linkOptionsDto = (field: Field, label: string): Readonly<Record<string, unknown>> => {
  assertEqual(field.type().toString(), 'link', `${label} field type`);
  const options = unwrap(
    field.accept(new FieldOptionsDtoVisitor()),
    `coreRelationCases.${label}.options.failed`
  );
  assert(
    options != null && typeof options === 'object' && !Array.isArray(options),
    `${label}: link options DTO is not an object`
  );
  return options as Readonly<Record<string, unknown>>;
};

const assertLinkSchema = (input: {
  readonly field: Field;
  readonly relationship: 'oneOne' | 'manyOne' | 'oneMany';
  readonly foreignTableId: string;
  readonly lookupFieldId: string;
  readonly symmetricFieldId: string;
  readonly label: string;
}): void => {
  const options = linkOptionsDto(input.field, input.label);
  assertEqual(options.relationship, input.relationship, `${input.label} relationship`);
  assertEqual(options.foreignTableId, input.foreignTableId, `${input.label} foreign table`);
  assertEqual(options.lookupFieldId, input.lookupFieldId, `${input.label} lookup field`);
  assertEqual(options.symmetricFieldId, input.symmetricFieldId, `${input.label} symmetric field`);
  assertEqual(options.isOneWay, false, `${input.label} bidirectional`);
};

const assertPersistedSchema = async (fixture: RelationFixture): Promise<void> => {
  const users = await listFields(fixture.runtime, IDS.userTable);
  const profiles = await listFields(fixture.runtime, IDS.profileTable);
  const children = await listFields(fixture.runtime, IDS.childTable);
  const parents = await listFields(fixture.runtime, IDS.parentTable);
  const userProfile = fieldById(users, IDS.userProfile, 'user profile');
  const profileUsers = fieldById(profiles, fixture.profileUsersFieldId, 'profile users');
  const childParent = fieldById(children, IDS.childParent, 'child parent');
  const parentChildren = fieldById(parents, fixture.parentChildrenFieldId, 'parent children');

  assertLinkSchema({
    field: userProfile,
    relationship: 'oneOne',
    foreignTableId: IDS.profileTable,
    lookupFieldId: IDS.profilePrimary,
    symmetricFieldId: fixture.profileUsersFieldId,
    label: 'user profile',
  });
  assertLinkSchema({
    field: profileUsers,
    relationship: 'oneOne',
    foreignTableId: IDS.userTable,
    lookupFieldId: IDS.userPrimary,
    symmetricFieldId: IDS.userProfile,
    label: 'profile users',
  });
  assertLinkSchema({
    field: childParent,
    relationship: 'manyOne',
    foreignTableId: IDS.parentTable,
    lookupFieldId: IDS.parentPrimary,
    symmetricFieldId: fixture.parentChildrenFieldId,
    label: 'child parent',
  });
  assertLinkSchema({
    field: parentChildren,
    relationship: 'oneMany',
    foreignTableId: IDS.childTable,
    lookupFieldId: IDS.childPrimary,
    symmetricFieldId: IDS.childParent,
    label: 'parent children',
  });

  const childLookup = fieldById(children, IDS.childParentLookup, 'child parent lookup');
  const childRollup = fieldById(children, IDS.childParentRollup, 'child parent rollup');
  const parentLookup = fieldById(parents, IDS.parentChildLookup, 'parent children lookup');
  const parentRollup = fieldById(parents, IDS.parentChildRollup, 'parent children rollup');
  assert(childLookup instanceof LookupField, 'Child parent lookup is not a LookupField');
  assert(childRollup instanceof RollupField, 'Child parent rollup is not a RollupField');
  assert(parentLookup instanceof LookupField, 'Parent children lookup is not a LookupField');
  assert(parentRollup instanceof RollupField, 'Parent children rollup is not a RollupField');

  assertEqual(childLookup.linkFieldId().toString(), IDS.childParent, 'child lookup link field');
  assertEqual(childLookup.foreignTableId().toString(), IDS.parentTable, 'child lookup table');
  assertEqual(childLookup.lookupFieldId().toString(), IDS.parentScore, 'child lookup value field');
  assertEqual(childRollup.linkFieldId().toString(), IDS.childParent, 'child rollup link field');
  assertEqual(childRollup.foreignTableId().toString(), IDS.parentTable, 'child rollup table');
  assertEqual(childRollup.lookupFieldId().toString(), IDS.parentScore, 'child rollup value field');
  assertEqual(childRollup.expression().toString(), 'sum({values})', 'child rollup expression');
  assertEqual(
    parentLookup.linkFieldId().toString(),
    fixture.parentChildrenFieldId,
    'parent lookup link field'
  );
  assertEqual(parentLookup.foreignTableId().toString(), IDS.childTable, 'parent lookup table');
  assertEqual(
    parentLookup.lookupFieldId().toString(),
    IDS.childAmount,
    'parent lookup value field'
  );
  assertEqual(
    parentRollup.linkFieldId().toString(),
    fixture.parentChildrenFieldId,
    'parent rollup link field'
  );
  assertEqual(parentRollup.foreignTableId().toString(), IDS.childTable, 'parent rollup table');
  assertEqual(
    parentRollup.lookupFieldId().toString(),
    IDS.childAmount,
    'parent rollup value field'
  );
  assertEqual(parentRollup.expression().toString(), 'sum({values})', 'parent rollup expression');
};

const assertOneOneState = async (
  fixture: RelationFixture,
  expectedProfileId: string | undefined,
  label: string
): Promise<void> => {
  const users = await listRecords(fixture.runtime, IDS.userTable, [
    IDS.userPrimary,
    IDS.userProfile,
  ]);
  const profiles = await listRecords(fixture.runtime, IDS.profileTable, [
    IDS.profilePrimary,
    fixture.profileUsersFieldId,
  ]);
  assertEqual(users.total, 1, `${label} user total`);
  assertEqual(users.records.length, 1, `${label} user page size`);
  const user = users.records[0]!;
  assertEqual(user.id, fixture.user.id, `${label} user id`);
  assertEqual(user.fields[IDS.userPrimary], fixture.user.title, `${label} user title`);
  assertMembers(
    linkedRecordIds(user.fields[IDS.userProfile], `${label} user profile`),
    expectedProfileId ? [expectedProfileId] : [],
    `${label} user profile`
  );

  assertEqual(profiles.total, fixture.profiles.length, `${label} profile total`);
  assertEqual(profiles.records.length, fixture.profiles.length, `${label} profile page size`);
  for (const profile of profiles.records) {
    const expected = fixture.profiles.find(({ id }) => id === profile.id);
    assert(expected, `${label}: unexpected profile ${profile.id}`);
    assertEqual(profile.fields[IDS.profilePrimary], expected.title, `${label} profile title`);
    assertMembers(
      linkedRecordIds(profile.fields[fixture.profileUsersFieldId], `${label} profile reverse`),
      profile.id === expectedProfileId ? [fixture.user.id] : [],
      `${label} profile ${profile.id} reverse`
    );
  }
};

const assertManyOneState = async (
  fixture: RelationFixture,
  expected: ExpectedState,
  label: string
): Promise<void> => {
  const children = await listRecords(fixture.runtime, IDS.childTable, [
    IDS.childPrimary,
    IDS.childAmount,
    IDS.childParent,
    IDS.childParentLookup,
    IDS.childParentRollup,
  ]);
  const parents = await listRecords(fixture.runtime, IDS.parentTable, [
    IDS.parentPrimary,
    IDS.parentScore,
    fixture.parentChildrenFieldId,
    IDS.parentChildLookup,
    IDS.parentChildRollup,
  ]);
  assertEqual(children.total, CHILD_ROWS, `${label} child total`);
  assertEqual(children.records.length, CHILD_ROWS, `${label} child page size`);

  const expectedChildrenByParent = new Map<string, ChildRecord[]>();
  for (const parentId of expected.existingParentIds) expectedChildrenByParent.set(parentId, []);
  for (const child of fixture.children) {
    const parentId = expected.childParents.get(child.id);
    if (parentId) expectedChildrenByParent.get(parentId)?.push(child);
  }

  for (const child of children.records) {
    const expectedChild = fixture.children.find(({ id }) => id === child.id);
    assert(expectedChild, `${label}: unexpected child ${child.id}`);
    const parentId = expected.childParents.get(child.id);
    const parent = fixture.parents.find(({ id }) => id === parentId);
    assertEqual(child.fields[IDS.childPrimary], expectedChild.title, `${label} child title`);
    assertEqual(
      numericValue(child.fields[IDS.childAmount], `${label} child amount`),
      expectedChild.amount,
      `${label} child amount`
    );
    assertMembers(
      linkedRecordIds(child.fields[IDS.childParent], `${label} child parent`),
      parentId ? [parentId] : [],
      `${label} child ${child.id} parent`
    );
    assertMembers(
      numericValues(child.fields[IDS.childParentLookup], `${label} child lookup`),
      parent ? [parent.score] : [],
      `${label} child ${child.id} lookup`
    );
    assertEqual(
      numericValue(child.fields[IDS.childParentRollup], `${label} child rollup`),
      parent?.score ?? 0,
      `${label} child ${child.id} rollup`
    );
  }

  assertEqual(parents.total, expected.existingParentIds.size, `${label} parent total`);
  assertEqual(parents.records.length, expected.existingParentIds.size, `${label} parent page size`);
  assertMembers(
    parents.records.map(({ id }) => id),
    [...expected.existingParentIds],
    `${label} persisted parent ids`
  );
  for (const parent of parents.records) {
    const expectedParent = fixture.parents.find(({ id }) => id === parent.id);
    assert(expectedParent, `${label}: unexpected parent ${parent.id}`);
    const linkedChildren = expectedChildrenByParent.get(parent.id) ?? [];
    assertEqual(parent.fields[IDS.parentPrimary], expectedParent.title, `${label} parent title`);
    assertEqual(
      numericValue(parent.fields[IDS.parentScore], `${label} parent score`),
      expectedParent.score,
      `${label} parent score`
    );
    assertMembers(
      linkedRecordIds(parent.fields[fixture.parentChildrenFieldId], `${label} parent children`),
      linkedChildren.map(({ id }) => id),
      `${label} parent ${parent.id} reverse links`
    );
    assertMembers(
      numericValues(parent.fields[IDS.parentChildLookup], `${label} parent lookup`),
      linkedChildren.map(({ amount }) => amount),
      `${label} parent ${parent.id} lookup`
    );
    assertEqual(
      numericValue(parent.fields[IDS.parentChildRollup], `${label} parent rollup`),
      linkedChildren.reduce((sum, { amount }) => sum + amount, 0),
      `${label} parent ${parent.id} rollup`
    );
  }
};

const assertPersistedState = async (
  fixture: RelationFixture,
  expected: ExpectedState,
  label: string
): Promise<void> => {
  await assertOneOneState(fixture, expected.oneOneProfileId, label);
  await assertManyOneState(fixture, expected, label);
};

const createField = async (
  fixture: FixtureSeed,
  tableId: string,
  field: ICreateFieldCommandInput['field'],
  errorLabel: string
): Promise<TimedResult<CreateFieldResult>> => {
  const command = unwrap(
    CreateFieldCommand.create({ baseId: fixture.baseId, tableId, field }),
    `coreRelationCases.${errorLabel}.invalid`
  );
  return timedResult(
    () =>
      fixture.runtime.commandBus.execute<CreateFieldCommand, CreateFieldResult>(context(), command),
    `coreRelationCases.${errorLabel}.failed`
  );
};

const createLink = async (input: {
  readonly fixture: FixtureSeed;
  readonly tableId: string;
  readonly fieldId: string;
  readonly name: string;
  readonly relationship: 'oneOne' | 'manyOne';
  readonly foreignTableId: string;
  readonly lookupFieldId: string;
  readonly errorLabel: string;
}): Promise<OperationResult<string>> => {
  const result = await createField(
    input.fixture,
    input.tableId,
    {
      id: input.fieldId,
      name: input.name,
      type: 'link',
      options: {
        relationship: input.relationship,
        foreignTableId: input.foreignTableId,
        lookupFieldId: input.lookupFieldId,
        isOneWay: false,
      },
    },
    input.errorLabel
  );
  const field = result.data.table
    .getFields()
    .find((candidate) => candidate.id().toString() === input.fieldId);
  assert(field, `${input.errorLabel}: command result is missing the link field`);
  const symmetricFieldId = linkOptionsDto(field, input.errorLabel).symmetricFieldId;
  assert(
    typeof symmetricFieldId === 'string' && symmetricFieldId.length > 0,
    `${input.errorLabel}: symmetric field id was not generated`
  );
  return { ...result, data: symmetricFieldId };
};

const createComputedField = async (input: {
  readonly fixture: FixtureSeed;
  readonly tableId: string;
  readonly field: ICreateFieldCommandInput['field'];
  readonly errorLabel: string;
  readonly populatedRows: number;
}): Promise<OperationResult<void>> => {
  const result = await createField(input.fixture, input.tableId, input.field, input.errorLabel);
  const fieldId = input.field.id;
  assert(
    result.data.table.getFields().some((candidate) => candidate.id().toString() === fieldId),
    `${input.errorLabel}: field missing from command result`
  );
  return { data: undefined, latencyMs: result.latencyMs, rowsWritten: input.populatedRows };
};

const updateOneOne = async (
  fixture: RelationFixture,
  profileId: string | undefined,
  label: string
): Promise<OperationResult<UpdateRecordResult>> => {
  const command = unwrap(
    UpdateRecordCommand.create({
      tableId: IDS.userTable,
      recordId: fixture.user.id,
      fieldKeyType: 'id',
      typecast: false,
      fields: { [IDS.userProfile]: profileId ? [{ id: profileId }] : [] },
    }),
    `coreRelationCases.${label}.invalid`
  );
  const result = await timedResult(
    () =>
      fixture.runtime.commandBus.execute<UpdateRecordCommand, UpdateRecordResult>(
        context(),
        command
      ),
    `coreRelationCases.${label}.failed`
  );
  return {
    ...result,
    rowsWritten: 1,
    observation: observation([fixture.user.id], [IDS.userProfile]),
  };
};

const updateChildren = async (input: {
  readonly fixture: RelationFixture;
  readonly childIds: ReadonlyArray<string>;
  readonly parentId?: string;
  readonly label: string;
}): Promise<OperationResult<UpdateRecordsResult>> => {
  const command = unwrap(
    UpdateRecordsCommand.create({
      tableId: IDS.childTable,
      recordIds: input.childIds,
      fieldKeyType: 'id',
      typecast: false,
      fields: { [IDS.childParent]: input.parentId ? [{ id: input.parentId }] : [] },
    }),
    `coreRelationCases.${input.label}.invalid`
  );
  const result = await timedResult(
    () =>
      input.fixture.runtime.commandBus.execute<UpdateRecordsCommand, UpdateRecordsResult>(
        context(),
        command
      ),
    `coreRelationCases.${input.label}.failed`
  );
  assertEqual(result.data.updatedCount, input.childIds.length, `${input.label} updated count`);
  return {
    ...result,
    rowsWritten: input.childIds.length,
    observation: observation(input.childIds, [IDS.childParent]),
  };
};

const deleteParent = async (
  fixture: RelationFixture,
  parentId: string
): Promise<OperationResult<DeleteRecordsResult>> => {
  const command = unwrap(
    DeleteRecordsCommand.create({ tableId: IDS.parentTable, recordIds: [parentId] }),
    'coreRelationCases.parent.delete.invalid'
  );
  const result = await timedResult(
    () =>
      fixture.runtime.commandBus.execute<DeleteRecordsCommand, DeleteRecordsResult>(
        context(),
        command
      ),
    'coreRelationCases.parent.delete.failed'
  );
  assertMembers(result.data.deletedRecordIds, [parentId], 'deleted parent ids');
  return {
    ...result,
    rowsWritten: 1,
    observation: observation([parentId], []),
  };
};

const flushAndVerify = async (input: {
  readonly fixture: RelationFixture;
  readonly expected: ExpectedState;
  readonly label: string;
}): Promise<OperationResult<IComputedFlushReport>> => {
  const started = performance.now();
  const report = await input.fixture.runtime.flushComputed();
  const latencyMs = performance.now() - started;
  assertFullyDrained(report, `${input.label} computed queue`);
  await assertPersistedState(input.fixture, input.expected, input.label);
  return { data: report, latencyMs, processed: report.processed };
};

const emptyState = (fixture: FixtureSeed): ExpectedState => ({
  childParents: new Map(),
  existingParentIds: new Set(fixture.parents.map(({ id }) => id)),
});

const runRelationCases = async (input: {
  readonly seed: FixtureSeed;
  readonly measured: boolean;
  readonly measurements: Map<
    CoreRelationCasesBenchCaseKey,
    MutableMeasurement<CoreRelationCasesBenchCaseKey>
  >;
  readonly errors: string[];
}): Promise<void> => {
  const execute = <T>(
    key: CoreRelationCasesBenchCaseKey,
    action: () => Promise<OperationResult<T>>
  ): Promise<T> =>
    executeOperation({
      key,
      action,
      measured: input.measured,
      measurements: input.measurements,
      errors: input.errors,
    });

  const profileUsersFieldId = await execute('core:CreateFieldCommand/one-one-bidirectional', () =>
    createLink({
      fixture: input.seed,
      tableId: IDS.userTable,
      fieldId: IDS.userProfile,
      name: 'Profile',
      relationship: 'oneOne',
      foreignTableId: IDS.profileTable,
      lookupFieldId: IDS.profilePrimary,
      errorLabel: 'oneOne.create',
    })
  );
  const parentChildrenFieldId = await execute(
    'core:CreateFieldCommand/many-one-bidirectional',
    () =>
      createLink({
        fixture: input.seed,
        tableId: IDS.childTable,
        fieldId: IDS.childParent,
        name: 'Parent',
        relationship: 'manyOne',
        foreignTableId: IDS.parentTable,
        lookupFieldId: IDS.parentPrimary,
        errorLabel: 'manyOne.create',
      })
  );
  const fixture: RelationFixture = {
    ...input.seed,
    profileUsersFieldId,
    parentChildrenFieldId,
  };

  await execute('core:CreateFieldCommand/child-parent-lookup', () =>
    createComputedField({
      fixture,
      tableId: IDS.childTable,
      populatedRows: CHILD_ROWS,
      errorLabel: 'childLookup.create',
      field: {
        id: IDS.childParentLookup,
        name: 'Parent Score Lookup',
        type: 'lookup',
        options: {
          linkFieldId: IDS.childParent,
          foreignTableId: IDS.parentTable,
          lookupFieldId: IDS.parentScore,
        },
      },
    })
  );
  await execute('core:CreateFieldCommand/child-parent-rollup', () =>
    createComputedField({
      fixture,
      tableId: IDS.childTable,
      populatedRows: CHILD_ROWS,
      errorLabel: 'childRollup.create',
      field: {
        id: IDS.childParentRollup,
        name: 'Parent Score Rollup',
        type: 'rollup',
        options: { expression: 'sum({values})' },
        config: {
          linkFieldId: IDS.childParent,
          foreignTableId: IDS.parentTable,
          lookupFieldId: IDS.parentScore,
        },
      },
    })
  );
  await execute('core:CreateFieldCommand/parent-children-lookup', () =>
    createComputedField({
      fixture,
      tableId: IDS.parentTable,
      populatedRows: fixture.parents.length,
      errorLabel: 'parentLookup.create',
      field: {
        id: IDS.parentChildLookup,
        name: 'Child Amounts Lookup',
        type: 'lookup',
        options: {
          linkFieldId: parentChildrenFieldId,
          foreignTableId: IDS.childTable,
          lookupFieldId: IDS.childAmount,
        },
      },
    })
  );
  await execute('core:CreateFieldCommand/parent-children-rollup', () =>
    createComputedField({
      fixture,
      tableId: IDS.parentTable,
      populatedRows: fixture.parents.length,
      errorLabel: 'parentRollup.create',
      field: {
        id: IDS.parentChildRollup,
        name: 'Child Amount Total',
        type: 'rollup',
        options: { expression: 'sum({values})' },
        config: {
          linkFieldId: parentChildrenFieldId,
          foreignTableId: IDS.childTable,
          lookupFieldId: IDS.childAmount,
        },
      },
    })
  );

  await assertPersistedSchema(fixture);
  const initialState = emptyState(fixture);
  await execute('core:IHeadlessRuntime.flushComputed/relation-schema', () =>
    flushAndVerify({ fixture, expected: initialState, label: 'relation schema' })
  );

  await execute('core:UpdateRecordCommand/one-one-assign', () =>
    updateOneOne(fixture, fixture.profiles[0].id, 'oneOne.assign')
  );
  await execute('core:IHeadlessRuntime.flushComputed/one-one-assign', () =>
    flushAndVerify({
      fixture,
      expected: { ...initialState, oneOneProfileId: fixture.profiles[0].id },
      label: 'one-one assign',
    })
  );

  await execute('core:UpdateRecordCommand/one-one-reassign', () =>
    updateOneOne(fixture, fixture.profiles[1].id, 'oneOne.reassign')
  );
  await execute('core:IHeadlessRuntime.flushComputed/one-one-reassign', () =>
    flushAndVerify({
      fixture,
      expected: { ...initialState, oneOneProfileId: fixture.profiles[1].id },
      label: 'one-one reassign',
    })
  );

  await execute('core:UpdateRecordCommand/one-one-clear', () =>
    updateOneOne(fixture, undefined, 'oneOne.clear')
  );
  await execute('core:IHeadlessRuntime.flushComputed/one-one-clear', () =>
    flushAndVerify({ fixture, expected: initialState, label: 'one-one clear' })
  );

  const childParents = new Map<string, string>();
  const parentA = fixture.parents[0];
  const parentB = fixture.parents[1];
  const allChildIds = fixture.children.map(({ id }) => id);
  await execute('core:UpdateRecordsCommand/many-one-fanout-assign', () =>
    updateChildren({
      fixture,
      childIds: allChildIds,
      parentId: parentA.id,
      label: 'manyOne.assign',
    })
  );
  for (const childId of allChildIds) childParents.set(childId, parentA.id);
  await execute('core:IHeadlessRuntime.flushComputed/many-one-fanout-assign', () =>
    flushAndVerify({
      fixture,
      expected: { ...initialState, childParents },
      label: 'many-one fanout assign',
    })
  );

  const reassignedChildIds = allChildIds.slice(0, REASSIGN_ROWS);
  await execute('core:UpdateRecordsCommand/many-one-reassign', () =>
    updateChildren({
      fixture,
      childIds: reassignedChildIds,
      parentId: parentB.id,
      label: 'manyOne.reassign',
    })
  );
  for (const childId of reassignedChildIds) childParents.set(childId, parentB.id);
  await execute('core:IHeadlessRuntime.flushComputed/many-one-reassign', () =>
    flushAndVerify({
      fixture,
      expected: { ...initialState, childParents },
      label: 'many-one reassign',
    })
  );

  const clearedChildIds = allChildIds.slice(0, CLEAR_ROWS);
  await execute('core:UpdateRecordsCommand/many-one-clear', () =>
    updateChildren({ fixture, childIds: clearedChildIds, label: 'manyOne.clear' })
  );
  for (const childId of clearedChildIds) childParents.delete(childId);
  await execute('core:IHeadlessRuntime.flushComputed/many-one-clear', () =>
    flushAndVerify({
      fixture,
      expected: { ...initialState, childParents },
      label: 'many-one clear',
    })
  );

  await execute('core:DeleteRecordsCommand/linked-parent-target', () =>
    deleteParent(fixture, parentA.id)
  );
  for (const [childId, parentId] of childParents) {
    if (parentId === parentA.id) childParents.delete(childId);
  }
  const existingParentIds = new Set(
    fixture.parents.filter(({ id }) => id !== parentA.id).map(({ id }) => id)
  );
  await execute('core:IHeadlessRuntime.flushComputed/linked-parent-target-delete', () =>
    flushAndVerify({
      fixture,
      expected: { oneOneProfileId: undefined, childParents, existingParentIds },
      label: 'linked parent target delete',
    })
  );
};

const runIsolatedRound = async (input: {
  readonly runtime: IHeadlessRuntime;
  readonly round: number;
  readonly measured: boolean;
  readonly measurements: Map<
    CoreRelationCasesBenchCaseKey,
    MutableMeasurement<CoreRelationCasesBenchCaseKey>
  >;
  readonly errors: string[];
}): Promise<void> => {
  const baseId = await createBase(input.runtime, input.round);
  let roundError: unknown;
  try {
    const seed = await createFixtureSeed(input.runtime, baseId);
    await runRelationCases({
      seed,
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
      const message = `Core relation cases cleanup failed for ${baseId}: ${errorMessage(error)}`;
      input.errors.push(message);
      if (!roundError) roundError = new RecordedBenchFailure(message);
    }
  }
  if (roundError) throw roundError;
};

/**
 * Benchmarks public Core relation commands with exact, untimed persisted
 * readback. Bidirectional schema, forward/reverse cells, lookup/rollup values,
 * and computed queue settlement are independently asserted after each change.
 */
export async function runCoreRelationCasesBench(
  input: RunCoreRelationCasesBenchInput
): Promise<HttpBenchRun> {
  validateInput(input);
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const measurements = makeMeasurements(CORE_RELATION_CASES);
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
      errors.push(`Core relation cases benchmark execution failed: ${errorMessage(error)}`);
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
    operations: CORE_RELATION_CASES.map(({ key }) => finalizeMeasurement(measurements.get(key)!)),
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
      profileRows: 3,
      userRows: 1,
      parentRows: 3,
      childRows: CHILD_ROWS,
      initialFanoutRows: CHILD_ROWS,
      reassignedRows: REASSIGN_ROWS,
      clearedRows: CLEAR_ROWS,
      setupTiming: 'base-table-and-record-fixture-excluded',
      computedDrainTiming: 'measured-separately-from-triggering-command',
      persistedReadbackTiming: 'excluded',
      correctnessValidation:
        'untimed exact ListFieldsQuery and ListTableRecordsQuery readback of forward links, reverse links, lookups, and rollups',
      sampleIsolation: {
        fixturePerRound:
          'fresh registered base with populated profile/user and parent/child table branches',
        cleanup: 'cleanupBenchBase removes only the round-owned registered base',
        runtimeReuse:
          'one runtime across rounds; bases, tables, fields, and records are never reused',
      },
      relationCoverage: [
        'bidirectional one-to-one creation with generated reverse one-to-one schema',
        'bidirectional many-to-one creation with generated reverse one-to-many schema',
        'one-to-one assignment, reassignment, and clearing with exact reverse cells',
        'many-to-one fanout assignment, reassignment, and clearing with exact reverse membership',
        'linked parent deletion clears surviving child links and dependent computed values',
        'forward and reverse lookup and rollup persisted values after every computed drain',
      ],
      operationIdentities: Object.fromEntries(
        CORE_RELATION_CASES.map(({ key, identity }) => [key, identity])
      ),
      excludedCapabilities: ['undo', 'redo', 'realtime'],
      isolation:
        input.backend === 'pglite'
          ? 'fresh-memory-runtime-with-owned-base-per-round-cleanup'
          : 'caller-provided-test-database-with-owned-base-per-round-cleanup',
    },
  };
}
