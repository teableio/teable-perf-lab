import { FieldKeyType, FieldType } from "@teable/core";
import {
  createRecords,
  deleteRecords,
  updateTableDescription,
} from "@teable/openapi";
import {
  createTable,
  getFields,
  getTable,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
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
  PerfCase,
  PerfRunContext,
  RecordCreateCaseConfig,
} from "../types";
import type { PerfRunResult } from "../types";
import {
  runRecordMutationLifecycle,
  seedRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

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
  verifiedRows?: Awaited<ReturnType<typeof assertCreatedRowCount>>;
  verifyRowCountMs?: number;
};

const RECORD_CREATE_FIXTURE_VERSION = "record-create-v2";
const RECORD_CREATE_METADATA_PREFIX = "perf-lab-record-create:";

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
  fixture: Omit<RecordCreateFixture, "records">,
  config: RecordCreateCaseConfig,
  cachedPayload?: CachedCreatePayload,
) => {
  const fieldIds = fixture.fields.map((field) => field.id);
  if (
    cachedPayload?.fixtureVersion === RECORD_CREATE_FIXTURE_VERSION &&
    cachedPayload.rowCount === config.rowCount &&
    JSON.stringify(cachedPayload.fieldIds) === JSON.stringify(fieldIds)
  ) {
    return {
      records: cachedPayload.records,
      payloadCacheHit: true,
    };
  }

  const records = buildCreateRecordsPayload(fixture.fields, config);
  await persistCachedCreatePayload(baseId, fixture.tableId, {
    fixtureVersion: RECORD_CREATE_FIXTURE_VERSION,
    rowCount: config.rowCount,
    fieldIds,
    records,
  });

  return {
    records,
    payloadCacheHit: false,
  };
};

const getRecordCreateSeedConfig = (config: RecordCreateCaseConfig) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  fields: config.fields,
  generator: config.generator,
  fixtureVersion: RECORD_CREATE_FIXTURE_VERSION,
});

const prepareRecordCreateFixture = async (
  baseId: string,
  tableName: string,
  config: RecordCreateCaseConfig,
  perfCase: PerfCase,
): Promise<RecordCreateFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "record-create",
    fixtureVersion: RECORD_CREATE_FIXTURE_VERSION,
    seedConfig: getRecordCreateSeedConfig(config),
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
        records: payload.records,
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
      records: payload.records,
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
) => {
  const verifyMeasurement = await measureAsync("verifyRowCount", () =>
    assertCreatedRowCount(baseId, fixture, config),
  );

  return {
    verifiedRows: verifyMeasurement.result,
    verifyRowCountMs: verifyMeasurement.durationMs,
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
            bulkCreate1kMs: primaryMeasurement.durationMs,
            createRequestMs: primaryMeasurement.durationMs,
            ...(primaryResult?.verifyRowCountMs != null
              ? { verifyRowCountMs: primaryResult.verifyRowCountMs }
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
      fieldCount: config.fields.length,
      payloadRecords: fixture?.records.length,
      payloadCells: fixture
        ? fixture.records.length * fixture.fields.length
        : 0,
      fields: fixture?.fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
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
            fieldKeyType: "name",
            typecast: false,
            responseHeaders: primaryResult.responseHeaders,
            routing: primaryResult.routing,
          }
        : undefined,
      routing: primaryResult?.routing,
      verification: primaryResult
        ? primaryResult.verifiedRows
          ? {
              method: "sql-count",
              sqlRowCount: primaryResult.verifiedRows.sqlRowCount,
              durationMs: primaryResult.verifyRowCountMs,
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
  const verification = await verifyCreatedRecords(baseId, fixture, config);
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
// non-reusable case just drops the table. Isolated CI execute DBs are discarded
// after the job, so no cleanup is needed there.
const cleanupRecordCreateFixture = async ({
  baseId,
  fixture,
  primaryMeasurement,
}: {
  baseId: string;
  fixture: RecordCreateFixture | undefined;
  primaryMeasurement?: Measurement<RecordCreatePrimaryResult>;
}) => {
  if (fixture?.tableId && fixture.reusableSeed && !isExecuteDbIsolated()) {
    try {
      const createdRecordIds =
        primaryMeasurement?.result.createdRecordIds ?? [];
      if (createdRecordIds.length > 0) {
        await deleteRecords(fixture.tableId, createdRecordIds);
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
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, recordCreateLifecycleSpec);

export const seedRecordCreateCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(perfCase, context, recordCreateLifecycleSpec);
