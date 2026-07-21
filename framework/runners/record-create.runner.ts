import { FieldKeyType, FieldType } from "@teable/core";
import {
  createRecords,
  deleteRecords,
  updateTableDescription,
} from "@teable/openapi";
import {
  createTable,
  getFields,
  getRecords,
  getTable,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { chunk } from "../chunk";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, type Measurement } from "../metrics";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import {
  buildSeedCacheInfo,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { queryPerfDb } from "../sql";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  PerfCase,
  PerfRunContext,
  RecordCreateCaseConfig,
} from "../types";
import type { PerfRunResult } from "../types";
import {
  runRecordMutationLifecycle,
  seedRecordMutationLifecycle,
  shouldRestoreSharedMutableSeed,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";
import {
  getRecordCreateExpectedValue,
  getRecordCreateSeedConfig,
  getRecordCreateSeedIdentityCase,
  projectRecordCreatePayloads,
  RECORD_CREATE_FIXTURE_VERSION,
  selectRecordCreatePayloadFields,
} from "./record-create-model";

type NamedField = {
  id: string;
  name: string;
  options?: unknown;
};

type CreateField = RecordCreateCaseConfig["fields"][number] & {
  id: string;
  name: string;
};

type ExpectedCellValue = string | number | boolean | string[] | null;

type CreateRecordPayload = {
  fields: Record<string, ExpectedCellValue>;
};

type SelectChoice = {
  id?: string;
  name: string;
};

type RecordCreateFixture = {
  tableId: string;
  tableName: string;
  dbTableName: string;
  viewId: string;
  fields: CreateField[];
  payloadFields: CreateField[];
  expectedRecords: CreateRecordPayload[];
  records: CreateRecordPayload[];
  seedCacheInfo?: SeedCacheInfo;
  seedCacheHit?: boolean;
  payloadCacheHit?: boolean;
  reusableSeed?: boolean;
};

type RecordCreatePrimaryResult = {
  createRequestMs: number;
  createStatus: number;
  createdRecordIds: string[];
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
  verification?: Awaited<ReturnType<typeof assertCreatedRecords>>;
  verifyCreatedMs?: number;
};

const RECORD_CREATE_METADATA_PREFIX = "perf-lab-record-create:";
const RECORD_CREATE_CLEANUP_BATCH_SIZE = 100;

type CachedCreatePayload = {
  fixtureVersion: string;
  rowCount: number;
  fieldIds: string[];
  records: CreateRecordPayload[];
};

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const fieldNameKey = (fieldName: string) => fieldName.replace(/\s+/g, "-");

const dateOnlyForRow = (rowNumber: number, offsetDays = 0) => {
  const date = new Date(
    Date.UTC(2026, 0, 1 + offsetDays + ((rowNumber - 1) % 365)),
  );
  return date.toISOString().slice(0, 10);
};

const dateIsoForRow = (rowNumber: number, offsetDays = 0) =>
  `${dateOnlyForRow(rowNumber, offsetDays)}T00:00:00.000Z`;

const selectChoices = (field: RecordCreateCaseConfig["fields"][number]) =>
  (
    field.options as
      | {
          choices?: SelectChoice[];
        }
      | undefined
  )?.choices ?? [];

const ratingMax = (field: RecordCreateCaseConfig["fields"][number]) =>
  (
    field.options as
      | {
          max?: number;
        }
      | undefined
  )?.max ?? 5;

const getSelectChoice = (
  field: RecordCreateCaseConfig["fields"][number],
  rowNumber: number,
) => {
  const choices = selectChoices(field);
  if (choices.length === 0) {
    throw new Error(`Select field ${field.name} has no choices`);
  }
  return choices[(rowNumber - 1) % choices.length].name;
};

const getMultiSelectChoices = (
  field: RecordCreateCaseConfig["fields"][number],
  rowNumber: number,
) => {
  const choices = selectChoices(field);
  if (choices.length === 0) {
    throw new Error(`Multiple select field ${field.name} has no choices`);
  }
  const first = choices[(rowNumber - 1) % choices.length].name;
  const second = choices[rowNumber % choices.length].name;
  return first === second ? [first] : [first, second];
};

const getExpectedValue = (
  field: RecordCreateCaseConfig["fields"][number],
  rowNumber: number,
  config: RecordCreateCaseConfig,
): ExpectedCellValue => {
  const padded = padRowNumber(rowNumber);

  switch (field.name) {
    case "Title":
      return `${config.generator.titlePrefix} ${padded}`;
    case "Description":
    case "Notes":
    case "Comment":
      return `${config.generator.payloadPrefix}-${padded}-${fieldNameKey(
        field.name,
      )}-payload`;
    case "Owner Text":
    case "External ID":
    case "Source":
      return `${config.generator.valuePrefix}-${padded}-${fieldNameKey(
        field.name,
      )}`;
  }

  switch (field.type) {
    case FieldType.SingleSelect:
      return getSelectChoice(field, rowNumber);
    case FieldType.MultipleSelect:
      return getMultiSelectChoices(field, rowNumber);
    case FieldType.Number:
      if (field.name === "Amount") {
        return Number((rowNumber * 7 + 0.25).toFixed(2));
      }
      if (field.name === "Quantity") {
        return rowNumber * 3;
      }
      if (field.name === "Percent") {
        return Number(((rowNumber % 100) / 100).toFixed(2));
      }
      return rowNumber;
    case FieldType.Date:
      return dateIsoForRow(
        rowNumber,
        field.name.toLowerCase().includes("due") ? 7 : 0,
      );
    case FieldType.Checkbox:
      return rowNumber % 2 === 1 ? true : null;
    case FieldType.Rating:
      return ((rowNumber - 1) % ratingMax(field)) + 1;
    default:
      return `${config.generator.valuePrefix}-${padded}-${fieldNameKey(
        field.name,
      )}`;
  }
};

const buildCreateRecordsPayload = (
  fields: CreateField[],
  config: RecordCreateCaseConfig,
): CreateRecordPayload[] =>
  Array.from({ length: config.rowCount }, (_, index) => {
    const rowNumber = index + 1;
    return {
      fields: Object.fromEntries(
        fields.map((field) => [
          field.name,
          getExpectedValue(field, rowNumber, config),
        ]),
      ),
    };
  });

const quoteSqlIdentifier = (identifier: string) =>
  `"${identifier.replace(/"/g, '""')}"`;

const getSqlTableRef = (baseId: string, dbTableName: string) => {
  const [schemaName, tableName, ...rest] = dbTableName.split(".");
  if (tableName && rest.length === 0) {
    return `${quoteSqlIdentifier(schemaName)}.${quoteSqlIdentifier(tableName)}`;
  }
  return `${quoteSqlIdentifier(baseId)}.${quoteSqlIdentifier(dbTableName)}`;
};

const assertSqlRowCount = async (
  baseId: string,
  dbTableName: string,
  expectedRowCount: number,
) => {
  const rows = await queryPerfDb<{ count: string }>(
    `SELECT CAST(COUNT(*) AS text) AS "count" FROM ${getSqlTableRef(
      baseId,
      dbTableName,
    )}`,
  );
  const rowCount = Number(rows[0]?.count);
  if (rowCount !== expectedRowCount) {
    throw new Error(
      `Expected ${expectedRowCount} created records by SQL count, got ${rowCount}`,
    );
  }
  return rowCount;
};

const resolveCreateFields = (
  fields: NamedField[],
  config: RecordCreateCaseConfig,
): CreateField[] => {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  return config.fields.map((field) => {
    const resolvedField = fieldByName.get(field.name);
    if (!resolvedField) {
      throw new Error(
        `Missing record create field ${field.name}; available fields: ${fields
          .map(({ name }) => name)
          .join(", ")}`,
      );
    }
    return {
      ...field,
      options: resolvedField.options ?? field.options,
      id: resolvedField.id,
      name: resolvedField.name,
    };
  });
};

const buildBaseRecordCreateFixture = async (
  baseId: string,
  tableId: string,
  tableName: string,
  config: RecordCreateCaseConfig,
) => {
  const tableMeta = await getTable(baseId, tableId);
  const tableFields = await getFields(tableId);
  const views = await getViews(tableId);
  const viewId = views[0]?.id;
  if (!viewId) {
    throw new Error(`No grid view found for record create table ${tableId}`);
  }

  const fields = resolveCreateFields(tableFields, config);
  selectRecordCreatePayloadFields(fields, config.createFieldNames);

  return {
    tableId,
    tableName,
    dbTableName: tableMeta.dbTableName,
    viewId,
    fields,
  };
};

const parseCachedCreatePayload = (
  description: string | null | undefined,
): CachedCreatePayload | undefined => {
  if (!description?.startsWith(RECORD_CREATE_METADATA_PREFIX)) {
    return;
  }
  try {
    return JSON.parse(
      description.slice(RECORD_CREATE_METADATA_PREFIX.length),
    ) as CachedCreatePayload;
  } catch {
    return;
  }
};

const persistCachedCreatePayload = async (
  baseId: string,
  tableId: string,
  metadata: CachedCreatePayload,
) => {
  await updateTableDescription(baseId, tableId, {
    description: `${RECORD_CREATE_METADATA_PREFIX}${JSON.stringify(metadata)}`,
  });
};

const resolveCreatePayload = async (
  baseId: string,
  fixture: Pick<RecordCreateFixture, "tableId" | "fields">,
  config: RecordCreateCaseConfig,
  cachedPayload?: CachedCreatePayload,
) => {
  const fieldIds = fixture.fields.map((field) => field.id);
  const payloadFields = selectRecordCreatePayloadFields(
    fixture.fields,
    config.createFieldNames,
  );
  if (
    cachedPayload?.fixtureVersion === RECORD_CREATE_FIXTURE_VERSION &&
    cachedPayload.rowCount === config.rowCount &&
    JSON.stringify(cachedPayload.fieldIds) === JSON.stringify(fieldIds)
  ) {
    return {
      expectedRecords: cachedPayload.records,
      records: projectRecordCreatePayloads(
        cachedPayload.records,
        payloadFields,
      ),
      payloadFields,
      payloadCacheHit: true,
    };
  }

  const expectedRecords = buildCreateRecordsPayload(fixture.fields, config);
  await persistCachedCreatePayload(baseId, fixture.tableId, {
    fixtureVersion: RECORD_CREATE_FIXTURE_VERSION,
    rowCount: config.rowCount,
    fieldIds,
    records: expectedRecords,
  });

  return {
    expectedRecords,
    records: projectRecordCreatePayloads(expectedRecords, payloadFields),
    payloadFields,
    payloadCacheHit: false,
  };
};

const prepareRecordCreateFixture = async (
  baseId: string,
  tableName: string,
  config: RecordCreateCaseConfig,
  perfCase: PerfCase,
): Promise<RecordCreateFixture> => {
  const seedIdentityCase = getRecordCreateSeedIdentityCase(
    perfCase,
    config.seedIdentity,
  );
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase: seedIdentityCase,
    runner: "record-create",
    fixtureVersion: RECORD_CREATE_FIXTURE_VERSION,
    seedConfig: getRecordCreateSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("./record-create-model.ts", import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
  const cachedTable =
    seedCacheInfo.enabled &&
    (await findSeedTable(baseId, seedCacheInfo.seedTableName));

  if (cachedTable) {
    try {
      const tableMeta = await getTable(baseId, cachedTable.id);
      const fixture = await buildBaseRecordCreateFixture(
        baseId,
        cachedTable.id,
        cachedTable.name,
        config,
      );
      await assertSqlRowCount(baseId, fixture.dbTableName, 0);
      const payload = await resolveCreatePayload(
        baseId,
        fixture,
        config,
        parseCachedCreatePayload(tableMeta.description),
      );
      return {
        ...fixture,
        expectedRecords: payload.expectedRecords,
        records: payload.records,
        payloadFields: payload.payloadFields,
        seedCacheInfo,
        seedCacheHit: true,
        payloadCacheHit: payload.payloadCacheHit,
        reusableSeed: true,
      };
    } catch (error) {
      console.warn(
        `Invalid cached record create seed ${seedCacheInfo.seedTableName}; rebuilding`,
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
    const table = await createTable(baseId, {
      name: actualTableName,
      fields: config.fields,
      records: [],
    });
    createdTableId = table.id;
    const fixture = await buildBaseRecordCreateFixture(
      baseId,
      table.id,
      actualTableName,
      config,
    );
    await assertSqlRowCount(baseId, fixture.dbTableName, 0);
    const payload = await resolveCreatePayload(baseId, fixture, config);
    return {
      ...fixture,
      expectedRecords: payload.expectedRecords,
      records: payload.records,
      payloadFields: payload.payloadFields,
      seedCacheInfo,
      seedCacheHit: false,
      payloadCacheHit: payload.payloadCacheHit,
      reusableSeed: seedCacheInfo.enabled,
    };
  } catch (error) {
    if (createdTableId) {
      try {
        await permanentDeleteTable(baseId, createdTableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup incomplete record create seed ${createdTableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const assertCreatedRowCount = async (
  baseId: string,
  fixture: RecordCreateFixture,
  config: RecordCreateCaseConfig,
) => {
  const sqlRowCount = await assertSqlRowCount(
    baseId,
    fixture.dbTableName,
    config.rowCount,
  );

  return {
    sqlRowCount,
  };
};

const valuesMatch = (
  expectedValue: ExpectedCellValue,
  actualValue: unknown,
) => {
  if (expectedValue == null) {
    return actualValue == null;
  }
  if (Array.isArray(expectedValue)) {
    return JSON.stringify(actualValue) === JSON.stringify(expectedValue);
  }
  if (typeof expectedValue === "boolean" && actualValue == null) {
    return expectedValue === false;
  }
  if (typeof expectedValue === "number") {
    return Number(actualValue) === expectedValue;
  }
  if (
    typeof expectedValue === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(expectedValue) &&
    typeof actualValue === "string"
  ) {
    return (
      new Date(actualValue).toISOString().slice(0, 10) ===
      expectedValue.slice(0, 10)
    );
  }
  return actualValue === expectedValue;
};

const assertCreatedRecordSamples = async (
  fixture: RecordCreateFixture,
  config: RecordCreateCaseConfig,
  createdRecordIds: string[],
) => {
  const verifiedSamples: Array<{
    rowOffset: number;
    rowNumber: number;
    recordId: string;
    actual: Record<string, unknown>;
    expected: Record<string, ExpectedCellValue>;
  }> = [];

  for (const rowOffset of config.verify.sampleRows) {
    const rowNumber = rowOffset + 1;
    const expectedRecord = fixture.expectedRecords[rowOffset];
    const expectedRecordId = createdRecordIds[rowOffset];
    if (!expectedRecord || !expectedRecordId) {
      throw new Error(
        `Missing record create sample metadata at row offset ${rowOffset}`,
      );
    }

    const result = await getRecords(fixture.tableId, {
      viewId: fixture.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: fixture.fields.map((field) => field.id),
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(
        `Expected created sample at row offset ${rowOffset}, got ${result.records.length}`,
      );
    }
    if (record.id !== expectedRecordId) {
      throw new Error(
        `Created row ${rowNumber} record id mismatch: expected ${expectedRecordId}, got ${record.id}`,
      );
    }

    const actual: Record<string, unknown> = {};
    const expected: Record<string, ExpectedCellValue> = {};
    for (const field of fixture.fields) {
      const expectedValue = getRecordCreateExpectedValue(
        field.name,
        expectedRecord.fields[field.name] ?? null,
        config.createFieldNames,
      );
      const actualValue = record.fields[field.id];
      actual[field.name] = actualValue;
      expected[field.name] = expectedValue;

      if (!valuesMatch(expectedValue, actualValue)) {
        throw new Error(
          `Created row ${rowNumber} ${field.name} mismatch: expected ${String(
            expectedValue,
          )}, actual ${String(actualValue)}`,
        );
      }
    }

    verifiedSamples.push({
      rowOffset,
      rowNumber,
      recordId: record.id,
      actual,
      expected,
    });
  }

  return {
    checkedRecords: verifiedSamples.length,
    verifiedSamples,
  };
};

const assertCreatedRecords = async (
  baseId: string,
  fixture: RecordCreateFixture,
  config: RecordCreateCaseConfig,
  createdRecordIds: string[],
) => ({
  ...(await assertCreatedRowCount(baseId, fixture, config)),
  ...(await assertCreatedRecordSamples(fixture, config, createdRecordIds)),
});

const assertSeedReady = async (
  baseId: string,
  fixture: RecordCreateFixture,
) => ({
  sqlRowCount: await assertSqlRowCount(baseId, fixture.dbTableName, 0),
});

const pickResponseHeaders = pickRoutingResponseHeaders;

const createRecordsForCase = async (
  fixture: RecordCreateFixture,
): Promise<Omit<RecordCreatePrimaryResult, "createRequestMs" | "routing">> => {
  const response = await createRecords(fixture.tableId, {
    fieldKeyType: FieldKeyType.Name,
    typecast: false,
    records: fixture.records,
  });
  expect(response.status).toBe(201);

  return {
    createStatus: response.status,
    createdRecordIds: response.data.records.map((record) => record.id),
    responseHeaders: pickResponseHeaders(response.headers),
  };
};

const verifyCreatedRecords = async (
  baseId: string,
  fixture: RecordCreateFixture,
  config: RecordCreateCaseConfig,
  createdRecordIds: string[],
) => {
  const verifyMeasurement = await measureAsync("verifyCreated", () =>
    assertCreatedRecords(baseId, fixture, config, createdRecordIds),
  );

  return {
    verification: verifyMeasurement.result,
    verifyCreatedMs: verifyMeasurement.durationMs,
  };
};

const buildRecordCreateCaseResult = ({
  config,
  prepareMeasurement,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  config: RecordCreateCaseConfig;
  prepareMeasurement?: Measurement<RecordCreateFixture>;
  seedReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertSeedReady>>
  >;
  primaryMeasurement?: Measurement<RecordCreatePrimaryResult>;
  error?: unknown;
}): PerfRunResult => {
  const fixture = prepareMeasurement?.result;
  const primaryResult = primaryMeasurement?.result;

  return {
    metrics: {
      ...(prepareMeasurement
        ? { recordCreatePrepareMs: prepareMeasurement.durationMs }
        : {}),
      ...(fixture?.seedCacheInfo
        ? {
            seedCacheHit: fixture.seedCacheHit ? 1 : 0,
            seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
            payloadCacheHit: fixture.payloadCacheHit ? 1 : 0,
            ...(fixture.seedCacheHit
              ? { seedRestoreMs: prepareMeasurement?.durationMs ?? 0 }
              : fixture.seedCacheInfo.enabled
                ? { seedBuildMs: prepareMeasurement?.durationMs ?? 0 }
                : {}),
            ...(seedReadyMeasurement
              ? { seedReadyMs: seedReadyMeasurement.durationMs }
              : {}),
          }
        : {}),
      ...(primaryMeasurement
        ? {
            [config.threshold.metric]: primaryMeasurement.durationMs,
            createRequestMs: primaryMeasurement.durationMs,
            ...(primaryResult?.verifyCreatedMs != null
              ? { verifyCreatedMs: primaryResult.verifyCreatedMs }
              : {}),
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
      ...(prepareMeasurement
        ? [
            {
              name: prepareMeasurement.name,
              durationMs: prepareMeasurement.durationMs,
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
      ...(seedReadyMeasurement
        ? [
            {
              name: seedReadyMeasurement.name,
              durationMs: seedReadyMeasurement.durationMs,
            },
          ]
        : []),
    ],
    details: {
      tableId: fixture?.tableId,
      tableName: fixture?.tableName,
      dbTableName: fixture?.dbTableName,
      viewId: fixture?.viewId,
      rowCount: config.rowCount,
      fieldCount: fixture?.payloadFields.length ?? config.fields.length,
      payloadFieldCount: fixture?.payloadFields.length ?? config.fields.length,
      tableFieldCount: config.fields.length,
      payloadRecords: fixture?.records.length,
      payloadCells: fixture
        ? fixture.records.length * fixture.payloadFields.length
        : 0,
      fields: fixture?.fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
        includedInCreate: fixture.payloadFields.some(
          (payloadField) => payloadField.name === field.name,
        ),
      })),
      prepare: fixture
        ? {
            durationMs: prepareMeasurement.durationMs,
            tableShape: `empty ${fixture.fields.length}-field table`,
            createdBeforeMetric: true,
            payloadBuiltBeforeMetric: true,
            seedReady: seedReadyMeasurement?.result,
            cache: fixture.seedCacheInfo
              ? {
                  enabled: fixture.seedCacheInfo.enabled,
                  cacheHit: Boolean(fixture.seedCacheHit),
                  payloadCacheHit: Boolean(fixture.payloadCacheHit),
                  reusable: Boolean(fixture.reusableSeed),
                  seedHash: fixture.seedCacheInfo.seedHash,
                  seedHashShort: fixture.seedCacheInfo.seedHashShort,
                  seedTableName: fixture.seedCacheInfo.seedTableName,
                  schemaSignature: fixture.seedCacheInfo.schemaSignature,
                }
              : undefined,
          }
        : undefined,
      create: primaryResult
        ? {
            status: primaryResult.createStatus,
            requestMs: primaryResult.createRequestMs,
            createdRecords: primaryResult.createdRecordIds.length,
            fieldCount: fixture?.payloadFields.length,
            tableFieldCount: fixture?.fields.length,
            fieldNames: fixture?.payloadFields.map((field) => field.name),
            fieldKeyType: "name",
            typecast: false,
            responseHeaders: primaryResult.responseHeaders,
            routing: primaryResult.routing,
          }
        : undefined,
      routing: primaryResult?.routing,
      verification: primaryResult
        ? primaryResult.verification
          ? {
              method: "sql-count-and-record-samples",
              sqlRowCount: primaryResult.verification.sqlRowCount,
              checkedRecords: primaryResult.verification.checkedRecords,
              verifiedSamples: primaryResult.verification.verifiedSamples,
              durationMs: primaryResult.verifyCreatedMs,
            }
          : undefined
        : undefined,
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

// The single measured operation: trace-wrapped bulk create -> routing
// assertion -> post-create row-count verification, all bundled into one primary
// measurement whose duration is the primary metric. record-create has no record
// window, so the driver invokes this directly (no withRecordWindowId).
const runRecordCreateMeasuredOperation = async (
  baseId: string,
  perfCase: PerfCase,
  context: PerfRunContext,
  config: RecordCreateCaseConfig,
  fixture: RecordCreateFixture,
): Promise<Measurement<RecordCreatePrimaryResult>> => {
  const createMeasurement = await withPerfTraceStep(
    context,
    perfCase,
    config.threshold.metric,
    () =>
      measureAsync(config.threshold.metric, () =>
        createRecordsForCase(fixture),
      ),
  );
  let primaryMeasurement: Measurement<RecordCreatePrimaryResult> = {
    ...createMeasurement,
    result: {
      ...createMeasurement.result,
      createRequestMs: createMeasurement.durationMs,
      routing: assertEngineRouting(
        context,
        createMeasurement.result.responseHeaders,
        {
          operation: "createRecords",
        },
      ),
    },
  };
  const verification = await verifyCreatedRecords(
    baseId,
    fixture,
    config,
    primaryMeasurement.result.createdRecordIds,
  );
  primaryMeasurement = {
    ...primaryMeasurement,
    result: {
      ...primaryMeasurement.result,
      createRequestMs: primaryMeasurement.durationMs,
      ...verification,
    },
  };
  return primaryMeasurement;
};

// The measured create inserts rows into the reusable empty seed table, so a
// shared (non-isolated) execute DB must be restored by deleting exactly the
// records the operation created — or the table dropped if restore fails. The
// non-reusable case just drops the table. Isolated CI execute DBs normally skip
// cleanup, but an explicit shared seed identity means sibling cases reuse the
// same mutable fixture in one process, so cleanup restores it between them.
const cleanupRecordCreateFixture = async ({
  baseId,
  fixture,
  config,
  primaryMeasurement,
}: {
  baseId: string;
  fixture: RecordCreateFixture | undefined;
  config: RecordCreateCaseConfig;
  primaryMeasurement?: Measurement<RecordCreatePrimaryResult>;
}) => {
  const restoreMutableSeed = shouldRestoreSharedMutableSeed({
    reusableSeed: Boolean(fixture?.reusableSeed),
    executeDbIsolated: isExecuteDbIsolated(),
    sharedSeedIdentity: Boolean(config.seedIdentity),
  });

  if (fixture?.tableId && restoreMutableSeed) {
    try {
      const createdRecordIds =
        primaryMeasurement?.result.createdRecordIds ?? [];
      for (const recordIds of chunk(
        createdRecordIds,
        RECORD_CREATE_CLEANUP_BATCH_SIZE,
      )) {
        await deleteRecords(fixture.tableId, recordIds);
      }
      await assertSeedReady(baseId, fixture);
    } catch (error) {
      console.warn(
        `Failed to restore cached record create seed ${fixture.tableId}; deleting it`,
        error,
      );
      try {
        await permanentDeleteTable(baseId, fixture.tableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup perf table ${fixture.tableId}`,
          cleanupError,
        );
      }
    }
  } else if (
    fixture?.tableId &&
    !fixture.reusableSeed &&
    !isExecuteDbIsolated()
  ) {
    try {
      await permanentDeleteTable(baseId, fixture.tableId);
    } catch (error) {
      console.warn(`Failed to cleanup perf table ${fixture.tableId}`, error);
    }
  }
};

const recordCreateLifecycleSpec: RecordMutationLifecycleSpec<
  RecordCreateCaseConfig,
  RecordCreateFixture,
  Awaited<ReturnType<typeof assertSeedReady>>,
  RecordCreatePrimaryResult
> = {
  prepareFixture: ({ baseId, tableName, config, perfCase }) =>
    prepareRecordCreateFixture(baseId, tableName, config, perfCase),
  assertSeedReady: ({ baseId, fixture }) => assertSeedReady(baseId, fixture),
  runMeasuredOperation: ({ baseId, perfCase, context, config, fixture }) =>
    runRecordCreateMeasuredOperation(
      baseId,
      perfCase,
      context,
      config,
      fixture,
    ),
  buildResult: buildRecordCreateCaseResult,
  cleanup: cleanupRecordCreateFixture,
};

export const runRecordCreateCase = async (
  perfCase: PerfCaseFor<"record-create">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, recordCreateLifecycleSpec);

export const seedRecordCreateCase = async (
  perfCase: PerfCaseFor<"record-create">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(perfCase, context, recordCreateLifecycleSpec);
