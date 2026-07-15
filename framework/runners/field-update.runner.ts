import { context as otelContext, trace } from "@opentelemetry/api";
import { FieldKeyType, FieldType } from "@teable/core";
import { ClsService } from "nestjs-cls";
import {
  createField,
  createRecords,
  createTable,
  getFields,
  getRecord,
  getRecords,
  permanentDeleteTable,
  runWithTestUser,
} from "../../../utils/init-app";
import { executeUpdateFieldEndpoint } from "@teable/v2-contract-http-implementation/handlers";
import { chunk } from "../chunk";
import { v2CoreTokens, type ICommandBus } from "@teable/v2-core";
import { V2ContainerService } from "../../../../src/features/v2/v2-container.service";
import { V2ExecutionContextFactory } from "../../../../src/features/v2/v2-execution-context.factory";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, roundMetric, type Measurement } from "../metrics";
import { pollUntilReady } from "../readiness";
import { forEachRecordPage } from "../record-page-scan";
import {
  collectSampleRecords,
  type SeededSampleRecord,
} from "../sample-records";
import {
  buildSeedCacheInfo,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import {
  recordPerfTraceRefFromHeaders,
  withPerfTraceStep,
} from "../trace-collector";
import type {
  PerfCaseFor,
  FieldUpdateCaseConfig,
  FieldUpdateComputedExpectedKind,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  runRecordMutationLifecycle,
  seedRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

const FIELD_UPDATE_FIXTURE_VERSION = "field-update-v1";

export const FIELD_UPDATE_SKIPPED_REASON =
  "legacy updateField cannot express select option rename; v2 contract only";

// Mirrors the nested IF expression in the case config. The runner derives
// expected values locally from the row number plus rename state, so this map
// and the case expression text must stay in sync (FormulaExpectedKind pattern).
const STATUS_SCORE_BY_NAME: Record<string, number> = {
  Todo: 10,
  Doing: 40,
  Done: 70,
  Closed: 90,
  Blocked: 0,
};

const getStatusScore = (statusName: string) => {
  const score = STATUS_SCORE_BY_NAME[statusName];
  if (score === undefined) {
    throw new Error(
      `field-update has no status score for option ${statusName}`,
    );
  }
  return score;
};

const getStatusBucket = (score: number) => {
  if (score >= 80) {
    return "archived";
  }
  return score >= 40 ? "active" : "idle";
};

type SelectChoice = { id: string; name: string; color?: string };

type NamedField = {
  id: string;
  name: string;
  type?: string;
  options?: { choices?: SelectChoice[] };
};

type ComputedField = {
  id: string;
  name: string;
  expected: FieldUpdateComputedExpectedKind;
};

type FieldUpdateFixture = {
  tableId: string;
  tableName: string;
  titleField: NamedField;
  statusField: NamedField;
  computedFields: ComputedField[];
  sampleRecords: SeededSampleRecord[];
  batchDurations: number[];
  createTableMeasurement: Measurement<unknown>;
  seedMeasurement: Measurement<unknown>;
  computedFieldsMeasurement: Measurement<unknown>;
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
};

type UpdatePrimaryResult = {
  updateFieldRequestMs: number;
  computedSamplesReadyMs: number;
  computedFullScanReadyMs: number;
  updatedField: { id: string; name: string; type: string };
  renamedOption: { id: string; previousName: string; nextName: string };
  endpoint: {
    invocation: "in-process";
    handler: "executeUpdateFieldEndpoint";
    contract: "v2-updateField";
    contractPath: "/tables/updateField";
    // The nestjs backend does not mount this v2 oRPC contract route over
    // HTTP; the runner invokes the contract handler in-process instead.
    httpMounted: false;
    requestedEngine: string;
  };
  primaryTrace?: { traceId: string; traceparent: string };
  updateEvents: unknown[];
  verifiedSamples: Array<{
    rowOffset: number;
    rowNumber: number;
    recordId: string;
    status: unknown;
    computed: Record<string, unknown>;
  }>;
  fullScan: {
    scannedRecords: number;
    pageSize: number;
    pageCount: number;
  };
};

// Row N gets option (N - 1) % optionNames.length; after the measured rename,
// rows that held rename.previous hold rename.next instead. Everything is
// derivable from the row number and the rename state.
const getStatusName = (
  config: FieldUpdateCaseConfig,
  rowNumber: number,
  renamed: boolean,
) => {
  const optionNames = config.select.optionNames;
  const seeded = optionNames[(rowNumber - 1) % optionNames.length];
  if (renamed && seeded === config.select.rename.previous) {
    return config.select.rename.next;
  }
  return seeded;
};

const getExpectedComputedValue = (
  expected: FieldUpdateComputedExpectedKind,
  statusName: string,
): string | number => {
  switch (expected) {
    case "statusTextMark":
      return `${statusName}-mark`;
    case "statusScore":
      return getStatusScore(statusName);
    case "statusScoreBucket":
      return getStatusBucket(getStatusScore(statusName));
    default:
      throw new Error(
        `Unsupported field-update expected kind: ${String(expected)}`,
      );
  }
};

const buildTitleValue = (titlePrefix: string, rowNumber: number) =>
  `${titlePrefix} ${rowNumber}`;

const parseTitleRowNumber = (value: unknown, titlePrefix: string) => {
  if (typeof value !== "string") {
    throw new Error(`Expected Title to be a string, got ${String(value)}`);
  }

  const prefix = `${titlePrefix} `;
  const rowNumber = Number(value.slice(prefix.length));
  if (!value.startsWith(prefix) || !Number.isInteger(rowNumber)) {
    throw new Error(`Expected ${value} to match "${prefix}<rowNumber>"`);
  }

  return rowNumber;
};

const resolveNamedField = (fields: NamedField[], fieldName: string) => {
  const field = fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw new Error(
      `Missing field ${fieldName}; available fields: ${fields
        .map(({ name }) => name)
        .join(", ")}`,
    );
  }
  return field;
};

const compileExpression = (expression: string, fields: NamedField[]) => {
  const fieldIdByName = new Map(fields.map((field) => [field.name, field.id]));
  return expression.replace(/\{([^}]+)\}/g, (match, fieldName: string) => {
    const fieldId = fieldIdByName.get(fieldName);
    return fieldId ? `{${fieldId}}` : match;
  });
};

const getStatusChoices = (
  statusField: NamedField,
  config: FieldUpdateCaseConfig,
) => {
  const choices = statusField.options?.choices;
  if (!choices || choices.length !== config.select.optionNames.length) {
    throw new Error(
      `Status field ${statusField.name} has ${choices?.length ?? 0} options, expected ${config.select.optionNames.length}`,
    );
  }
  return choices;
};

const assertSeedStatusChoices = (
  statusField: NamedField,
  config: FieldUpdateCaseConfig,
) => {
  const choices = getStatusChoices(statusField, config);
  const actualNames = [...choices.map((choice) => choice.name)].sort();
  const expectedNames = [...config.select.optionNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `Status options mismatch (leftover renamed option?): expected ${expectedNames.join(
        ", ",
      )}, got ${actualNames.join(", ")}`,
    );
  }
  return choices;
};

const resolveFixtureFields = (
  tableFields: NamedField[],
  config: FieldUpdateCaseConfig,
) => {
  const titleField = resolveNamedField(tableFields, "Title");
  const statusField = resolveNamedField(tableFields, config.select.fieldName);
  if (statusField.type !== FieldType.SingleSelect) {
    throw new Error(
      `Field ${config.select.fieldName} has type ${statusField.type}, expected ${FieldType.SingleSelect}`,
    );
  }
  const computedFields = config.computedFields.map((computed) => {
    const field = resolveNamedField(tableFields, computed.name);
    return { id: field.id, name: field.name, expected: computed.expected };
  });
  return { titleField, statusField, computedFields };
};

const getFieldUpdateSeedConfig = (config: FieldUpdateCaseConfig) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  select: config.select,
  computedFields: config.computedFields,
  generator: config.generator,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: FIELD_UPDATE_FIXTURE_VERSION,
});

const getCachedSampleRecords = async (
  tableId: string,
  titleField: NamedField,
  config: FieldUpdateCaseConfig,
): Promise<SeededSampleRecord[]> => {
  const sampleRecords: SeededSampleRecord[] = [];
  for (const rowOffset of config.verify.sampleRows) {
    const expectedRowNumber = rowOffset + 1;
    const result = await getRecords(tableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [titleField.id],
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(
        `Missing cached seed sample at row offset ${rowOffset}; rowCount=${config.rowCount}`,
      );
    }
    const rowNumber = parseTitleRowNumber(
      record.fields[titleField.id],
      config.generator.titlePrefix,
    );
    if (rowNumber !== expectedRowNumber) {
      throw new Error(
        `Cached seed sample row mismatch: expected row ${expectedRowNumber}, got ${rowNumber}`,
      );
    }
    sampleRecords.push({ rowOffset, rowNumber, recordId: record.id });
  }
  return sampleRecords;
};

const assertRowState = (
  fixture: Pick<
    FieldUpdateFixture,
    "titleField" | "statusField" | "computedFields"
  >,
  config: FieldUpdateCaseConfig,
  rowNumber: number,
  fields: Record<string, unknown>,
  renamed: boolean,
) => {
  const statusName = getStatusName(config, rowNumber, renamed);
  const actualStatus = fields[fixture.statusField.id];
  if (actualStatus !== statusName) {
    throw new Error(
      `Status mismatch at row ${rowNumber}: expected ${statusName}, actual ${String(
        actualStatus,
      )}`,
    );
  }

  const computed: Record<string, unknown> = {};
  for (const computedField of fixture.computedFields) {
    const expected = getExpectedComputedValue(
      computedField.expected,
      statusName,
    );
    const actual = fields[computedField.id];
    if (actual !== expected) {
      throw new Error(
        `Computed ${computedField.name} mismatch at row ${rowNumber}: expected ${String(
          expected,
        )}, actual ${String(actual)}`,
      );
    }
    computed[computedField.name] = actual;
  }

  return { status: actualStatus, computed };
};

const assertSamples = async (
  fixture: Pick<
    FieldUpdateFixture,
    "tableId" | "titleField" | "statusField" | "computedFields"
  > & { sampleRecords: SeededSampleRecord[] },
  config: FieldUpdateCaseConfig,
  renamed: boolean,
) => {
  const verifiedSamples = [];

  for (const sampleRecord of fixture.sampleRecords) {
    const record = await getRecord(fixture.tableId, sampleRecord.recordId);
    if (!record) {
      throw new Error(
        `Missing sample record ${sampleRecord.recordId} at row ${sampleRecord.rowNumber}`,
      );
    }

    const expectedTitle = buildTitleValue(
      config.generator.titlePrefix,
      sampleRecord.rowNumber,
    );
    const actualTitle = record.fields[fixture.titleField.id];
    if (actualTitle !== expectedTitle) {
      throw new Error(
        `Sample Title mismatch at row ${sampleRecord.rowNumber}: expected ${expectedTitle}, actual ${String(
          actualTitle,
        )}`,
      );
    }

    const rowState = assertRowState(
      fixture,
      config,
      sampleRecord.rowNumber,
      record.fields,
      renamed,
    );

    verifiedSamples.push({
      rowOffset: sampleRecord.rowOffset,
      rowNumber: sampleRecord.rowNumber,
      recordId: sampleRecord.recordId,
      status: rowState.status,
      computed: rowState.computed,
    });
  }

  return verifiedSamples;
};

const assertRowBoundaries = async (
  fixture: Pick<FieldUpdateFixture, "tableId" | "titleField">,
  config: FieldUpdateCaseConfig,
) => {
  const lastPage = await getRecords(fixture.tableId, {
    fieldKeyType: FieldKeyType.Id,
    projection: [fixture.titleField.id],
    skip: config.rowCount - 1,
    take: 1,
  });
  const lastRecord = lastPage.records[0];
  if (!lastRecord) {
    throw new Error(`Missing final seed row at offset ${config.rowCount - 1}`);
  }
  const lastRowNumber = parseTitleRowNumber(
    lastRecord.fields[fixture.titleField.id],
    config.generator.titlePrefix,
  );
  if (lastRowNumber !== config.rowCount) {
    throw new Error(
      `Final seed row mismatch: expected row ${config.rowCount}, got ${lastRowNumber}`,
    );
  }

  const beyondLastPage = await getRecords(fixture.tableId, {
    fieldKeyType: FieldKeyType.Id,
    projection: [fixture.titleField.id],
    skip: config.rowCount,
    take: 1,
  });
  if (beyondLastPage.records.length !== 0) {
    throw new Error(
      `Seed table has extra rows after expected rowCount=${config.rowCount}`,
    );
  }
};

const assertSeedSamples = async (
  fixture: FieldUpdateFixture,
  config: FieldUpdateCaseConfig,
) => {
  const verifiedSamples = await assertSamples(fixture, config, false);
  await assertRowBoundaries(fixture, config);
  return verifiedSamples;
};

const assertFullScan = async (
  fixture: Pick<
    FieldUpdateFixture,
    "tableId" | "titleField" | "statusField" | "computedFields"
  >,
  config: FieldUpdateCaseConfig,
  renamed: boolean,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const projection = [
    fixture.titleField.id,
    fixture.statusField.id,
    ...fixture.computedFields.map((field) => field.id),
  ];
  const seenRowNumbers = new Set<number>();

  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.rowCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          fieldKeyType: FieldKeyType.Id,
          projection,
          skip,
          take,
        }),
    },
    (record) => {
      const rowNumber = parseTitleRowNumber(
        record.fields[fixture.titleField.id],
        config.generator.titlePrefix,
      );
      if (seenRowNumbers.has(rowNumber)) {
        throw new Error(`Duplicate row number in full scan: ${rowNumber}`);
      }
      seenRowNumbers.add(rowNumber);
      assertRowState(fixture, config, rowNumber, record.fields, renamed);
    },
  );

  if (scannedRecords !== config.rowCount) {
    throw new Error(
      `Full scan record count mismatch: expected ${config.rowCount}, scanned ${scannedRecords}`,
    );
  }

  return { scannedRecords, pageSize, pageCount };
};

const waitFor = <T>(
  config: FieldUpdateCaseConfig,
  description: string,
  assertFn: () => Promise<T>,
): Promise<T> =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 60_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 200,
      description,
    },
    assertFn,
  );

const createEmptyMeasurement = <T>(
  name: string,
  result: T,
): Measurement<T> => ({
  name,
  durationMs: 0,
  result,
});

// The measured rename rewrites the Status column values and recomputes every
// dependent computed column, so a mutated cached seed cannot be restored
// cheaply. Same contract as field-convert: CI execute jobs run on a
// disposable restored database copy, and local runs delete the mutated table
// so the next run reseeds it.
const prepareFieldUpdateFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  tableName: string,
  config: FieldUpdateCaseConfig,
): Promise<FieldUpdateFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "field-update",
    fixtureVersion: FIELD_UPDATE_FIXTURE_VERSION,
    seedConfig: getFieldUpdateSeedConfig(config) as never,
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
  const cachedTable =
    seedCacheInfo.enabled &&
    (await findSeedTable(baseId, seedCacheInfo.seedTableName));

  if (cachedTable) {
    try {
      const tableFields = (await getFields(cachedTable.id)) as NamedField[];
      const { titleField, statusField, computedFields } = resolveFixtureFields(
        tableFields,
        config,
      );
      assertSeedStatusChoices(statusField, config);
      const fixture: FieldUpdateFixture = {
        tableId: cachedTable.id,
        tableName: cachedTable.name,
        titleField,
        statusField,
        computedFields,
        sampleRecords: await getCachedSampleRecords(
          cachedTable.id,
          titleField,
          config,
        ),
        batchDurations: [0],
        createTableMeasurement: createEmptyMeasurement("seedRestore", {
          id: cachedTable.id,
        }),
        seedMeasurement: createEmptyMeasurement("seedBuildSkipped", undefined),
        computedFieldsMeasurement: createEmptyMeasurement(
          "computedFieldsRestored",
          undefined,
        ),
        seedCacheInfo,
        seedCacheHit: true,
        reusableSeed: true,
      };
      await assertSeedSamples(fixture, config);
      return fixture;
    } catch (error) {
      console.warn(
        `Invalid cached field update seed ${seedCacheInfo.seedTableName}; rebuilding`,
        error,
      );
      await permanentDeleteTable(baseId, cachedTable.id);
    }
  }

  const actualTableName = seedCacheInfo.enabled
    ? seedCacheInfo.seedTableName
    : tableName;
  let createdTableId = "";

  try {
    const createTableMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      seedCacheInfo.enabled ? "seedBuild:createTable" : "createTable",
      () =>
        measureAsync(seedCacheInfo.enabled ? "seedBuild" : "createTable", () =>
          createTable(baseId, {
            name: actualTableName,
            fields: [
              { name: "Title", type: FieldType.SingleLineText },
              {
                name: config.select.fieldName,
                type: FieldType.SingleSelect,
                options: {
                  choices: config.select.optionNames.map((name) => ({ name })),
                },
              },
            ],
            records: [],
          }),
        ),
    );
    createdTableId = createTableMeasurement.result.id;
    const baseFields = (await getFields(createdTableId)) as NamedField[];
    const titleField = resolveNamedField(baseFields, "Title");
    const statusField = resolveNamedField(baseFields, config.select.fieldName);
    assertSeedStatusChoices(statusField, config);

    const records = Array.from({ length: config.rowCount }, (_, index) => {
      const rowNumber = index + 1;
      return {
        rowOffset: index,
        rowNumber,
        record: {
          fields: {
            Title: buildTitleValue(config.generator.titlePrefix, rowNumber),
            [config.select.fieldName]: getStatusName(config, rowNumber, false),
          },
        },
      };
    });
    const batches = chunk(records, config.batchSize);
    const batchDurations: number[] = [];
    const wantedSampleOffsets = new Set(config.verify.sampleRows);
    const sampleRecordByOffset = new Map<number, SeededSampleRecord>();

    const seedMeasurement = await measureAsync("seedRecords", async () => {
      for (const [batchIndex, batch] of batches.entries()) {
        const batchMeasurement = await measureAsync(
          `seedBatch:${batchIndex + 1}`,
          () =>
            withPerfTraceStep(
              context,
              perfCase,
              `seedBatch:${batchIndex + 1}`,
              () =>
                createRecords(createdTableId, {
                  fieldKeyType: FieldKeyType.Name,
                  typecast: true,
                  records: batch.map((item) => item.record),
                }),
            ),
        );
        batchDurations.push(batchMeasurement.durationMs);
        expect(batchMeasurement.result.records).toHaveLength(batch.length);
        collectSampleRecords(
          sampleRecordByOffset,
          wantedSampleOffsets,
          batch,
          batchMeasurement.result.records,
        );
      }
    });

    const sampleRecords = config.verify.sampleRows.map((rowOffset) => {
      const sampleRecord = sampleRecordByOffset.get(rowOffset);
      if (!sampleRecord) {
        throw new Error(
          `Missing seeded sample record for row offset ${rowOffset}; rowCount=${config.rowCount}`,
        );
      }
      return sampleRecord;
    });

    // Create the computed chain in list order so later expressions can
    // reference earlier computed fields, then wait until every computed value
    // is correct across all rows: the seed dump must not capture a partially
    // backfilled formula column, because the restored execute database has no
    // background process left to finish it.
    const knownFields = [...baseFields];
    const computedFields: ComputedField[] = [];
    const computedFieldsMeasurement = await measureAsync(
      "computedFieldsReady",
      async () => {
        for (const computed of config.computedFields) {
          const created = await withPerfTraceStep(
            context,
            perfCase,
            `seedComputedField:${computed.name}`,
            () =>
              createField(createdTableId, {
                type: FieldType.Formula,
                name: computed.name,
                options: {
                  expression: compileExpression(
                    computed.expression,
                    knownFields,
                  ),
                },
              }),
          );
          const createdField = {
            id: created.id,
            name: computed.name,
          } as NamedField;
          knownFields.push(createdField);
          computedFields.push({
            id: created.id,
            name: computed.name,
            expected: computed.expected,
          });
        }

        const fixtureFields = {
          tableId: createdTableId,
          titleField,
          statusField,
          computedFields,
          sampleRecords,
        };
        await waitFor(config, "seed computed samples", () =>
          assertSamples(fixtureFields, config, false),
        );
        await waitFor(config, "seed computed full scan", () =>
          assertFullScan(fixtureFields, config, false),
        );
      },
    );

    return {
      tableId: createdTableId,
      tableName: actualTableName,
      titleField,
      statusField,
      computedFields,
      sampleRecords,
      batchDurations,
      createTableMeasurement,
      seedMeasurement,
      computedFieldsMeasurement,
      seedCacheInfo,
      seedCacheHit: false,
      reusableSeed: seedCacheInfo.enabled,
    };
  } catch (error) {
    if (createdTableId) {
      try {
        await permanentDeleteTable(baseId, createdTableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup incomplete field update seed ${createdTableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const buildRenamedChoices = (
  fixture: FieldUpdateFixture,
  config: FieldUpdateCaseConfig,
) => {
  const choices = getStatusChoices(fixture.statusField, config);
  const previousChoice = choices.find(
    (choice) => choice.name === config.select.rename.previous,
  );
  if (!previousChoice) {
    throw new Error(
      `Status option ${config.select.rename.previous} not found; options: ${choices
        .map(({ name }) => name)
        .join(", ")}`,
    );
  }

  const nextChoices = choices.map((choice) =>
    choice.id === previousChoice.id
      ? { ...choice, name: config.select.rename.next }
      : { ...choice },
  );

  return { previousChoice, nextChoices };
};

const executeV2UpdateField = async ({
  perfCase,
  context,
  fixture,
  config,
  nextChoices,
}: {
  perfCase: PerfCase;
  context: PerfRunContext;
  fixture: FieldUpdateFixture;
  config: FieldUpdateCaseConfig;
  nextChoices: SelectChoice[];
}) => {
  const clsService = context.app.get(ClsService);
  const v2ContainerService = context.app.get(V2ContainerService);
  const v2ContextFactory = context.app.get(V2ExecutionContextFactory);
  const container = await v2ContainerService.getContainerForTable(
    fixture.tableId,
  );
  const commandBus = container.resolve<ICommandBus>(v2CoreTokens.commandBus);

  // No HTTP request exists for this step, so wrap the in-process contract
  // call in a perf-lab OTel span: the v2 tracer parents its command-bus
  // spans on otelContext.active(), which puts them in this span's trace and
  // gives the primary step a real trace ref in the artifact manifest.
  const span = trace
    .getTracer("teable-perf-lab")
    .startSpan(`perf.${config.threshold.metric}`);
  const spanContext = span.spanContext();
  const traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-${
    (spanContext.traceFlags & 1) === 1 ? "01" : "00"
  }`;

  let result: Awaited<ReturnType<typeof executeUpdateFieldEndpoint>>;
  try {
    result = await otelContext.with(
      trace.setSpan(otelContext.active(), span),
      () =>
        runWithTestUser(clsService, async () => {
          const executionContext =
            await v2ContextFactory.createContext(container);
          return executeUpdateFieldEndpoint(
            executionContext,
            {
              tableId: fixture.tableId,
              fieldId: fixture.statusField.id,
              field: {
                type: FieldType.SingleSelect,
                name: fixture.statusField.name,
                options: {
                  choices: nextChoices,
                },
                replaceOptions: true,
              },
            },
            commandBus,
          );
        }),
    );
  } finally {
    span.end();
  }

  const traceRef = recordPerfTraceRefFromHeaders({
    context,
    perfCase,
    stepId: config.threshold.metric,
    headers: { traceparent },
    url: "in-process://v2-contract/tables/updateField",
    status: result.status,
  });

  if (result.status !== 200 || result.body.ok === false) {
    throw new Error(
      `V2 updateField contract failed: ${result.status} ${JSON.stringify(
        result.body.ok === false ? result.body.error : result.body,
      )}`,
    );
  }

  const updatedField = result.body.data.table.fields?.find(
    (field) => field.id === fixture.statusField.id,
  );
  if (!updatedField) {
    throw new Error(
      `V2 updateField response did not include updated field ${fixture.statusField.id}`,
    );
  }

  return {
    updatedField,
    events: result.body.data.events,
    primaryTrace: traceRef
      ? { traceId: traceRef.traceId, traceparent: traceRef.traceparent }
      : undefined,
  };
};

const runFieldUpdatePrimary = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: FieldUpdateFixture,
  config: FieldUpdateCaseConfig,
): Promise<UpdatePrimaryResult> => {
  const { previousChoice, nextChoices } = buildRenamedChoices(fixture, config);

  const updateMeasurement = await measureAsync("updateFieldRequest", () =>
    withPerfTraceStep(context, perfCase, config.threshold.metric, () =>
      executeV2UpdateField({
        perfCase,
        context,
        fixture,
        config,
        nextChoices,
      }),
    ),
  );
  const { updatedField, events, primaryTrace } = updateMeasurement.result;
  const updatedChoices =
    (updatedField.options as { choices?: SelectChoice[] } | undefined)
      ?.choices ?? [];
  const renamedChoice = updatedChoices.find(
    (choice) => choice.id === previousChoice.id,
  );
  if (!renamedChoice || renamedChoice.name !== config.select.rename.next) {
    throw new Error(
      `Renamed option not found in response: expected option ${previousChoice.id} named ${config.select.rename.next}, got ${JSON.stringify(
        updatedChoices,
      )}`,
    );
  }
  if (
    updatedChoices.some(
      (choice) => choice.name === config.select.rename.previous,
    )
  ) {
    throw new Error(
      `Previous option name ${config.select.rename.previous} still present after rename`,
    );
  }

  const samplesMeasurement = await measureAsync("computedSamplesReady", () =>
    waitFor(config, "renamed computed samples", () =>
      assertSamples(fixture, config, true),
    ),
  );
  const fullScanMeasurement = await measureAsync("computedFullScanReady", () =>
    waitFor(config, "renamed computed full scan", () =>
      assertFullScan(fixture, config, true),
    ),
  );

  return {
    updateFieldRequestMs: updateMeasurement.durationMs,
    computedSamplesReadyMs: samplesMeasurement.durationMs,
    computedFullScanReadyMs: fullScanMeasurement.durationMs,
    updatedField: {
      id: updatedField.id,
      name: updatedField.name,
      type: updatedField.type,
    },
    renamedOption: {
      id: previousChoice.id,
      previousName: config.select.rename.previous,
      nextName: config.select.rename.next,
    },
    endpoint: {
      invocation: "in-process",
      handler: "executeUpdateFieldEndpoint",
      contract: "v2-updateField",
      contractPath: "/tables/updateField",
      httpMounted: false,
      requestedEngine: context.engine,
    },
    primaryTrace,
    updateEvents: events,
    verifiedSamples: samplesMeasurement.result,
    fullScan: fullScanMeasurement.result,
  };
};

const buildFieldUpdateResult = ({
  config,
  fixture,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  config: FieldUpdateCaseConfig;
  fixture?: FieldUpdateFixture;
  seedReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertSeedSamples>>
  >;
  primaryMeasurement?: Measurement<UpdatePrimaryResult>;
  error?: unknown;
}): PerfRunResult => {
  const primaryResult = primaryMeasurement?.result;

  return {
    metrics: {
      ...(fixture
        ? {
            createTableMs: fixture.createTableMeasurement.durationMs,
            seedRecordsMs: fixture.seedMeasurement.durationMs,
            maxSeedBatchMs: roundMetric(Math.max(...fixture.batchDurations)),
            seedComputedFieldsReadyMs:
              fixture.computedFieldsMeasurement.durationMs,
            seedCacheHit: fixture.seedCacheHit ? 1 : 0,
            seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
            ...(fixture.seedCacheHit
              ? { seedRestoreMs: fixture.createTableMeasurement.durationMs }
              : fixture.seedCacheInfo.enabled
                ? {
                    seedBuildMs: roundMetric(
                      fixture.createTableMeasurement.durationMs +
                        fixture.seedMeasurement.durationMs +
                        fixture.computedFieldsMeasurement.durationMs,
                    ),
                  }
                : {}),
          }
        : {}),
      ...(seedReadyMeasurement
        ? { seedReadyMs: seedReadyMeasurement.durationMs }
        : {}),
      ...(primaryMeasurement
        ? {
            [config.threshold.metric]: primaryMeasurement.durationMs,
            updateFieldRequestMs:
              primaryMeasurement.result.updateFieldRequestMs,
            computedSamplesReadyMs:
              primaryMeasurement.result.computedSamplesReadyMs,
            computedFullScanReadyMs:
              primaryMeasurement.result.computedFullScanReadyMs,
          }
        : {}),
    },
    thresholds: primaryMeasurement
      ? [
          {
            metric: config.threshold.metric,
            max: getPrimaryThresholdMs(config.threshold.maxMs),
            unit: "ms",
          },
        ]
      : [],
    phases: [
      ...(fixture
        ? [
            {
              name: fixture.createTableMeasurement.name,
              durationMs: fixture.createTableMeasurement.durationMs,
            },
            {
              name: fixture.seedMeasurement.name,
              durationMs: fixture.seedMeasurement.durationMs,
            },
            {
              name: fixture.computedFieldsMeasurement.name,
              durationMs: fixture.computedFieldsMeasurement.durationMs,
            },
          ]
        : []),
      ...(seedReadyMeasurement
        ? [
            {
              name: seedReadyMeasurement.name,
              durationMs: seedReadyMeasurement.durationMs,
            },
          ]
        : []),
      ...(primaryMeasurement
        ? [
            {
              name: primaryMeasurement.name,
              durationMs: primaryMeasurement.durationMs,
            },
          ]
        : []),
    ],
    details: {
      operation: "field-update",
      tableId: fixture?.tableId,
      tableName: fixture?.tableName,
      rowCount: config.rowCount,
      batchSize: config.batchSize,
      select: {
        fieldName: config.select.fieldName,
        fieldId: fixture?.statusField.id,
        optionNames: config.select.optionNames,
        rename: config.select.rename,
      },
      updatedField: primaryResult?.updatedField,
      renamedOption: primaryResult?.renamedOption,
      updateEvents: primaryResult?.updateEvents,
      endpoint: primaryResult?.endpoint,
      primaryTrace: primaryResult?.primaryTrace,
      computedFields: fixture?.computedFields,
      seed: fixture
        ? {
            seededRecords: config.rowCount,
            batchCount: fixture.batchDurations.length,
            ready: seedReadyMeasurement?.result,
            cache: {
              enabled: fixture.seedCacheInfo.enabled,
              cacheHit: fixture.seedCacheHit,
              reusable: fixture.reusableSeed,
              seedHash: fixture.seedCacheInfo.seedHash,
              seedHashShort: fixture.seedCacheInfo.seedHashShort,
              seedTableName: fixture.seedCacheInfo.seedTableName,
              schemaSignature: fixture.seedCacheInfo.schemaSignature,
            },
          }
        : undefined,
      verifiedSamples: primaryResult?.verifiedSamples,
      fullScan: primaryResult?.fullScan,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
            }
          : undefined,
    },
  };
};

// The single measured window: the in-process v2 updateField (rename) request
// followed by the computed-cascade readiness waits, bundled into one primary
// measurement whose name and duration are the primary metric. No record window
// is involved.
const runFieldUpdateMeasuredOperation = (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: FieldUpdateCaseConfig,
  fixture: FieldUpdateFixture,
): Promise<Measurement<UpdatePrimaryResult>> =>
  measureAsync(config.threshold.metric, () =>
    runFieldUpdatePrimary(perfCase, context, fixture, config),
  );

// The measured rename rewrites the Status column and recomputes dependent
// computed columns in place, so a mutated reusable seed cannot be cheaply
// restored: delete it unless the execute DB is the throwaway isolated copy, or
// the rename never started on an otherwise-reusable seed. `primaryMeasurement`
// is defined once the measured rename was attempted (the driver supplies it on
// both the success and diagnostic paths), mirroring the legacy `renameAttempted`
// flag.
const cleanupFieldUpdateFixture = async ({
  baseId,
  fixture,
  primaryMeasurement,
}: {
  baseId: string;
  fixture: FieldUpdateFixture | undefined;
  primaryMeasurement?: Measurement<UpdatePrimaryResult>;
}) => {
  const renameAttempted = primaryMeasurement != null;
  const keepFixture =
    isExecuteDbIsolated() ||
    (Boolean(fixture?.reusableSeed) && !renameAttempted);
  if (fixture?.tableId && !keepFixture) {
    try {
      await permanentDeleteTable(baseId, fixture.tableId);
    } catch (error) {
      console.warn(
        `Failed to cleanup perf field update table ${fixture.tableId}`,
        error,
      );
    }
  }
};

const fieldUpdateLifecycleSpec: RecordMutationLifecycleSpec<
  FieldUpdateCaseConfig,
  FieldUpdateFixture,
  Awaited<ReturnType<typeof assertSeedSamples>>,
  UpdatePrimaryResult
> = {
  // field-update parks its createTable/seedRecords/computedFieldsReady
  // sub-measurements on the fixture, so buildFieldUpdateResult emits those
  // phases instead of the driver's "prepare" measurement. It asserts the seed
  // (un-renamed) state as the seedReady phase, then runs the rename +
  // computed-cascade wait as the primary; no record window is involved.
  prepareFixture: ({ baseId, tableName, config, perfCase, context }) =>
    prepareFieldUpdateFixture(perfCase, context, baseId, tableName, config),
  assertSeedReady: ({ fixture, config }) => assertSeedSamples(fixture, config),
  runMeasuredOperation: ({ perfCase, context, config, fixture }) =>
    runFieldUpdateMeasuredOperation(perfCase, context, config, fixture),
  buildResult: ({
    config,
    fixture,
    seedReadyMeasurement,
    primaryMeasurement,
    error,
  }) =>
    buildFieldUpdateResult({
      config,
      fixture,
      seedReadyMeasurement,
      primaryMeasurement,
      error,
    }),
  cleanup: cleanupFieldUpdateFixture,
};

export const seedFieldUpdateCase = async (
  perfCase: PerfCaseFor<"field-update">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(perfCase, context, fieldUpdateLifecycleSpec);

export const runFieldUpdateCase = async (
  perfCase: PerfCaseFor<"field-update">,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config;

  // V2-only diagnostic: the legacy PATCH updateField schema cannot express
  // select options, so there is no equivalent V1 workload to compare against.
  // The skip short-circuits before the lifecycle driver so the skipped artifact
  // stays byte-identical to the legacy runner.
  if (context.engine !== "v2") {
    return {
      result: "skipped",
      metrics: {},
      thresholds: [],
      details: {
        operation: "field-update",
        skipped: true,
        skippedReason: FIELD_UPDATE_SKIPPED_REASON,
        requestedEngine: context.engine,
        select: {
          fieldName: config.select.fieldName,
          rename: config.select.rename,
        },
      },
    };
  }

  return runRecordMutationLifecycle(
    perfCase,
    context,
    fieldUpdateLifecycleSpec,
  );
};
