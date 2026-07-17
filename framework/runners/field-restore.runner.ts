import { FieldKeyType, FieldType } from "@teable/core";
import {
  axios,
  deleteFields as apiDeleteFields,
  getTrashItems,
  restoreTrash,
  TableTrashType,
  TrashType,
} from "@teable/openapi";
import {
  getFields,
  getRecords,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, type Measurement } from "../metrics";
import { forEachRecordPage } from "../record-page-scan";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import { perfStreamSse, type PerfSseEvent } from "../sse";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  FieldRestoreCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import { PerfRunDiagnosticError } from "../types";
import {
  assertRowsRestored,
  buildRecordWindowId,
  getExpectedCellValue,
  prepareRecordReplayFixture,
  withRecordWindowId,
  type RecordReplayFixture,
  type RecordReplayVerification,
} from "./record-replay.shared";

type NamedField = {
  id: string;
  name: string;
  type?: string;
};

type FieldTrashLookup = {
  trashId: string;
  resourceIds: string[];
  deletedTime?: string;
  scannedPages: number;
};

type RestoreFieldStreamProgressEvent = PerfSseEvent & {
  id: "progress";
  phase: "preparing" | "restoring";
  batchIndex: number;
  totalCount: number;
  processedCount: number;
  updatedCount: number;
};

type RestoreFieldStreamDoneEvent = PerfSseEvent & {
  id: "done";
  totalCount: number;
  updatedCount: number;
};

type RestoreFieldStreamErrorEvent = PerfSseEvent & {
  id: "error";
  phase: "preparing" | "restoring" | "finalizing";
  batchIndex: number;
  totalCount: number;
  processedCount: number;
  updatedCount: number;
  message: string;
  code?: string;
};

type RestoreFieldStreamEvent =
  | RestoreFieldStreamProgressEvent
  | RestoreFieldStreamDoneEvent
  | RestoreFieldStreamErrorEvent;

type RestoreFieldSetupResult = {
  deletedFieldId: string;
  deletedFieldName: string;
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
  trashLookup: FieldTrashLookup;
};

type RestoreFieldPrimaryResult = {
  mode: "direct" | "stream";
  status: number;
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
  stream?: {
    eventCount: number;
    progressEventCount: number;
    done: RestoreFieldStreamDoneEvent;
  };
};

type RestoreFieldVerification = RecordReplayVerification & {
  restoredFieldId: string;
  restoredFieldName: string;
  restoredFieldCount: number;
  verifiedSamples: Array<{
    rowOffset: number;
    rowNumber: number;
    recordId: string;
    actual: unknown;
    expected: unknown;
  }>;
};

const pickResponseHeaders = pickRoutingResponseHeaders;

const findConfiguredField = (
  fixture: RecordReplayFixture,
  config: FieldRestoreCaseConfig,
) => {
  const field = fixture.fields.find(
    (candidate) => candidate.name === config.restore.fieldName,
  );
  if (!field) {
    throw new Error(
      `Missing restore field ${config.restore.fieldName}; available fields: ${fixture.fields
        .map(({ name }) => name)
        .join(", ")}`,
    );
  }
  return field;
};

const assertFieldDeleted = async (tableId: string, fieldId: string) => {
  const fields = (await getFields(tableId)) as NamedField[];
  if (fields.some((field) => field.id === fieldId)) {
    throw new Error(`Field ${fieldId} is still listed after delete setup`);
  }
  return {
    remainingFieldCount: fields.length,
    remainingFieldNames: fields.map((field) => field.name),
  };
};

const findFieldTrashId = async (
  tableId: string,
  fieldId: string,
): Promise<FieldTrashLookup> => {
  let cursor: string | null | undefined;
  for (let page = 1; page <= 25; page += 1) {
    const response = await getTrashItems({
      resourceId: tableId,
      resourceType: TrashType.Table,
      cursor,
    });
    const items = response.data.trashItems as Array<{
      id: string;
      resourceType?: string;
      resourceIds?: string[];
      deletedTime?: string;
    }>;
    const match = items.find(
      (item) =>
        item.resourceType === TableTrashType.Field &&
        item.resourceIds?.includes(fieldId),
    );
    if (match) {
      return {
        trashId: match.id,
        resourceIds: match.resourceIds ?? [],
        deletedTime: match.deletedTime,
        scannedPages: page,
      };
    }
    cursor = (response.data as { nextCursor?: string | null }).nextCursor;
    if (!cursor || items.length === 0) {
      break;
    }
  }

  throw new Error(
    `Trash item for field ${fieldId} not found in table ${tableId}`,
  );
};

const deleteFieldForRestoreSetup = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: RecordReplayFixture,
  config: FieldRestoreCaseConfig,
): Promise<RestoreFieldSetupResult> => {
  const field = findConfiguredField(fixture, config);
  const deleteResponse = await withPerfTraceStep(
    context,
    perfCase,
    "deleteFieldSetup",
    () => apiDeleteFields(fixture.tableId, [field.id]),
  );
  expect(deleteResponse.status).toBe(200);

  await assertFieldDeleted(fixture.tableId, field.id);
  const trashLookup = await findFieldTrashId(fixture.tableId, field.id);
  const responseHeaders = pickResponseHeaders(
    deleteResponse.headers as Record<string, unknown>,
  );

  return {
    deletedFieldId: field.id,
    deletedFieldName: field.name,
    responseHeaders,
    routing: assertEngineRouting(context, responseHeaders, {
      operation: "Field restore setup delete",
      feature: "deleteField",
    }),
    trashLookup,
  };
};

const getStreamHeaders = (context: PerfRunContext) =>
  context.cookie ? { Cookie: context.cookie } : undefined;

const assertRestoreFieldStreamResult = (
  events: RestoreFieldStreamEvent[],
  expectedRestoredCellCount: number,
) => {
  const errors = events.filter(
    (event): event is RestoreFieldStreamErrorEvent => event.id === "error",
  );
  if (errors.length > 0) {
    throw new Error(
      `Restore field stream returned errors: ${errors
        .map((event) => event.message)
        .join("; ")}`,
    );
  }

  const done = events.find(
    (event): event is RestoreFieldStreamDoneEvent => event.id === "done",
  );
  if (!done) {
    throw new Error("Restore field stream finished without a done event");
  }
  if (done.totalCount !== expectedRestoredCellCount) {
    throw new Error(
      `Restore field stream announced ${done.totalCount} restorable cells; expected ${expectedRestoredCellCount}`,
    );
  }
  if (done.updatedCount !== expectedRestoredCellCount) {
    throw new Error(
      `Restore field stream updated ${done.updatedCount} cells; expected ${expectedRestoredCellCount}`,
    );
  }
  return done;
};

const getExpectedRestoredCellCount = (
  fixture: RecordReplayFixture,
  config: FieldRestoreCaseConfig,
) => {
  const field = findConfiguredField(fixture, config);
  let updatedCount = 0;
  for (let rowNumber = 1; rowNumber <= config.rowCount; rowNumber += 1) {
    const value = getExpectedCellValue(field, rowNumber, config);
    const hasStoredValue =
      value != null &&
      (field.type !== FieldType.Checkbox || value === true) &&
      (!Array.isArray(value) || value.length > 0);
    if (hasStoredValue) {
      updatedCount += 1;
    }
  }
  return updatedCount;
};

const restoreFieldViaStream = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: RecordReplayFixture,
  config: FieldRestoreCaseConfig,
  trashLookup: FieldTrashLookup,
): Promise<RestoreFieldPrimaryResult> => {
  const url = axios.getUri({
    baseURL: axios.defaults.baseURL || "/api",
    url: `/trash/restore-field/${trashLookup.trashId}/stream`,
    params: { tableId: fixture.tableId },
  });
  const streamResult = await perfStreamSse<RestoreFieldStreamEvent>({
    context,
    perfCase,
    stepId: config.threshold.metric,
    url,
    method: "POST",
    headers: getStreamHeaders(context),
    errorPrefix: "Restore field trash stream failed",
  });
  const done = assertRestoreFieldStreamResult(
    streamResult.events,
    getExpectedRestoredCellCount(fixture, config),
  );
  const responseHeaders = pickResponseHeaders(streamResult.headers);

  return {
    mode: "stream",
    status: streamResult.status,
    responseHeaders,
    routing: assertEngineRouting(context, responseHeaders, {
      operation: "Field restore stream",
      feature: "createField",
    }),
    stream: {
      eventCount: streamResult.events.length,
      progressEventCount: streamResult.events.filter(
        (event) => event.id === "progress",
      ).length,
      done,
    },
  };
};

const restoreFieldViaDirectRestore = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: FieldRestoreCaseConfig,
  fixture: RecordReplayFixture,
  trashLookup: FieldTrashLookup,
): Promise<RestoreFieldPrimaryResult> => {
  const response = await withPerfTraceStep(
    context,
    perfCase,
    config.threshold.metric,
    () => restoreTrash(trashLookup.trashId, fixture.tableId),
  );
  expect([200, 201]).toContain(response.status);
  const responseHeaders = pickResponseHeaders(
    response.headers as Record<string, unknown>,
  );

  return {
    mode: "direct",
    status: response.status,
    responseHeaders,
    routing: assertEngineRouting(context, responseHeaders, {
      operation: "Field restore direct",
    }),
  };
};

const runRestoreFieldPrimary = (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: RecordReplayFixture,
  config: FieldRestoreCaseConfig,
  trashLookup: FieldTrashLookup,
): Promise<RestoreFieldPrimaryResult> => {
  if (context.engine === "v2") {
    return restoreFieldViaStream(
      perfCase,
      context,
      fixture,
      config,
      trashLookup,
    );
  }
  return restoreFieldViaDirectRestore(
    perfCase,
    context,
    config,
    fixture,
    trashLookup,
  );
};

const normalizeRestoredCellValue = (
  field: RecordReplayFixture["fields"][number],
  value: unknown,
) => {
  if (field.type === FieldType.Checkbox && value == null) {
    return false;
  }
  if (field.type !== FieldType.Date || typeof value !== "string") {
    return value;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const timeZone = (
    field.options as { formatting?: { timeZone?: string } } | undefined
  )?.formatting?.timeZone;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: "year" | "month" | "day") =>
    parts.find((candidate) => candidate.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const verifyRestoredFieldValues = async (
  fixture: RecordReplayFixture,
  config: FieldRestoreCaseConfig,
): Promise<RestoreFieldVerification> => {
  const restoredFieldConfig = findConfiguredField(fixture, config);
  const fields = (await getFields(fixture.tableId)) as NamedField[];
  const restoredField = fields.find(
    (field) => field.id === restoredFieldConfig.id,
  );
  if (!restoredField) {
    throw new Error(
      `Restored field ${restoredFieldConfig.name} (${restoredFieldConfig.id}) was not listed after restore`,
    );
  }
  if (restoredField.type !== restoredFieldConfig.type) {
    throw new Error(
      `Restored field ${restoredFieldConfig.name} type mismatch: expected ${restoredFieldConfig.type}, actual ${String(restoredField.type)}`,
    );
  }

  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const verifiedSamples: RestoreFieldVerification["verifiedSamples"] = [];
  const sampleRows = new Set(config.verify.sampleRows);
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.rowCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          viewId: fixture.viewId,
          fieldKeyType: FieldKeyType.Id,
          projection: [restoredFieldConfig.id],
          skip,
          take,
        }),
    },
    (record, rowNumber) => {
      const expected = getExpectedCellValue(
        restoredFieldConfig,
        rowNumber,
        config,
      );
      const actual = record.fields[restoredFieldConfig.id];
      const comparableExpected = normalizeRestoredCellValue(
        restoredFieldConfig,
        expected,
      );
      const comparableActual = normalizeRestoredCellValue(
        restoredFieldConfig,
        actual,
      );
      if (
        JSON.stringify(comparableActual) !== JSON.stringify(comparableExpected)
      ) {
        throw new Error(
          `Restored field ${restoredFieldConfig.name} row ${rowNumber} mismatch: expected ${String(
            expected,
          )}, actual ${String(actual)}`,
        );
      }
      const rowOffset = rowNumber - 1;
      if (sampleRows.has(rowOffset)) {
        verifiedSamples.push({
          rowOffset,
          rowNumber,
          recordId: record.id,
          actual,
          expected,
        });
      }
    },
  );

  return {
    scannedRecords,
    pageSize,
    pageCount,
    verifiedSamples,
    restoredFieldId: restoredFieldConfig.id,
    restoredFieldName: restoredFieldConfig.name,
    restoredFieldCount: fields.length,
  };
};

const cleanupFieldRestoreFixture = async (
  baseId: string,
  fixture: RecordReplayFixture | undefined,
) => {
  if (!fixture?.tableId) {
    return;
  }

  if (isExecuteDbIsolated()) {
    return;
  }

  try {
    await permanentDeleteTable(baseId, fixture.tableId);
  } catch (error) {
    console.warn(
      `Failed to cleanup perf field restore table ${fixture.tableId}`,
      error,
    );
  }
};

const buildFieldRestoreResult = ({
  config,
  windowId,
  fixture,
  prepareMeasurement,
  seedReadyMeasurement,
  setupMeasurement,
  operationMeasurement,
  verifyMeasurement,
  error,
}: {
  config: FieldRestoreCaseConfig;
  windowId?: string;
  fixture?: RecordReplayFixture;
  prepareMeasurement?: Measurement<RecordReplayFixture>;
  seedReadyMeasurement?: Measurement<RecordReplayVerification>;
  setupMeasurement?: Measurement<RestoreFieldSetupResult>;
  operationMeasurement?: Measurement<RestoreFieldPrimaryResult>;
  verifyMeasurement?: Measurement<RestoreFieldVerification>;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    ...(prepareMeasurement ? { prepareMs: prepareMeasurement.durationMs } : {}),
    ...(fixture?.seedCacheInfo
      ? {
          seedCacheHit: fixture.seedCacheHit ? 1 : 0,
          seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
          ...(fixture.seedCacheHit
            ? { seedRestoreMs: prepareMeasurement?.durationMs ?? 0 }
            : fixture.seedCacheInfo.enabled
              ? { seedBuildMs: prepareMeasurement?.durationMs ?? 0 }
              : {}),
        }
      : {}),
    ...(seedReadyMeasurement
      ? { seedReadyMs: seedReadyMeasurement.durationMs }
      : {}),
    ...(setupMeasurement
      ? { deleteFieldSetupMs: setupMeasurement.durationMs }
      : {}),
    ...(operationMeasurement
      ? { [config.threshold.metric]: operationMeasurement.durationMs }
      : {}),
    ...(verifyMeasurement
      ? { verifyRestoredFieldMs: verifyMeasurement.durationMs }
      : {}),
  },
  thresholds: operationMeasurement
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
    ...(seedReadyMeasurement
      ? [
          {
            name: seedReadyMeasurement.name,
            durationMs: seedReadyMeasurement.durationMs,
          },
        ]
      : []),
    ...(setupMeasurement
      ? [
          {
            name: setupMeasurement.name,
            durationMs: setupMeasurement.durationMs,
          },
        ]
      : []),
    ...(operationMeasurement
      ? [
          {
            name: operationMeasurement.name,
            durationMs: operationMeasurement.durationMs,
          },
        ]
      : []),
    ...(verifyMeasurement
      ? [
          {
            name: verifyMeasurement.name,
            durationMs: verifyMeasurement.durationMs,
          },
        ]
      : []),
  ],
  details: {
    operation: "field-restore",
    windowId,
    tableId: fixture?.tableId,
    tableName: fixture?.tableName,
    viewId: fixture?.viewId,
    rowCount: config.rowCount,
    seedFieldCount: config.fields.length,
    restoreFieldName: config.restore.fieldName,
    deleteSetup: setupMeasurement?.result,
    restore: operationMeasurement?.result,
    verification: verifyMeasurement
      ? {
          restoredFieldId: verifyMeasurement.result.restoredFieldId,
          restoredFieldName: verifyMeasurement.result.restoredFieldName,
          restoredFieldCount: verifyMeasurement.result.restoredFieldCount,
          scannedRecords: verifyMeasurement.result.scannedRecords,
          pageSize: verifyMeasurement.result.pageSize,
          pageCount: verifyMeasurement.result.pageCount,
          verifiedSamples: verifyMeasurement.result.verifiedSamples,
        }
      : undefined,
    seed: fixture
      ? {
          seededRecords: fixture.seededRecords.length,
          ready: seedReadyMeasurement?.result,
          cache: fixture.seedCacheInfo
            ? {
                enabled: fixture.seedCacheInfo.enabled,
                cacheHit: Boolean(fixture.seedCacheHit),
                reusable: Boolean(fixture.reusableSeed),
                seedHash: fixture.seedCacheInfo.seedHash,
                seedHashShort: fixture.seedCacheInfo.seedHashShort,
                seedTableName: fixture.seedCacheInfo.seedTableName,
                schemaSignature: fixture.seedCacheInfo.schemaSignature,
              }
            : undefined,
        }
      : undefined,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
          }
        : undefined,
  },
});

export const seedFieldRestoreCase = async (
  perfCase: PerfCaseFor<"field-restore">,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const prepareMeasurement = await measureAsync("prepare", () =>
    prepareRecordReplayFixture(baseId, tableName, config, {
      perfCase,
      runner: "field-restore",
      seedCodeFiles: [new URL(import.meta.url)],
    }),
  );
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    assertRowsRestored(prepareMeasurement.result, config, {
      verifySamples: true,
    }),
  );

  return buildFieldRestoreResult({
    config,
    windowId: `seed-${context.runId}-${perfCase.id}`,
    fixture: prepareMeasurement.result,
    prepareMeasurement,
    seedReadyMeasurement,
  });
};

export const runFieldRestoreCase = async (
  perfCase: PerfCaseFor<"field-restore">,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const windowId = buildRecordWindowId(context, perfCase);
  let prepareMeasurement: Measurement<RecordReplayFixture> | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareRecordReplayFixture(baseId, tableName, config, {
        perfCase,
        runner: "field-restore",
        seedCodeFiles: [new URL(import.meta.url)],
      }),
    );
    const fixture = prepareMeasurement.result;
    let seedReadyMeasurement: Measurement<RecordReplayVerification> | undefined;
    let setupMeasurement: Measurement<RestoreFieldSetupResult> | undefined;
    let operationMeasurement:
      | Measurement<RestoreFieldPrimaryResult>
      | undefined;
    let verifyMeasurement: Measurement<RestoreFieldVerification> | undefined;

    try {
      seedReadyMeasurement = await measureAsync("seedReady", () =>
        assertRowsRestored(fixture, config, { verifySamples: true }),
      );

      await withRecordWindowId(windowId, async () => {
        setupMeasurement = await measureAsync("deleteFieldSetup", () =>
          deleteFieldForRestoreSetup(perfCase, context, fixture, config),
        );
        operationMeasurement = await measureAsync(config.threshold.metric, () =>
          runRestoreFieldPrimary(
            perfCase,
            context,
            fixture,
            config,
            setupMeasurement!.result.trashLookup,
          ),
        );
      });

      verifyMeasurement = await measureAsync("verifyRestoredField", () =>
        verifyRestoredFieldValues(fixture, config),
      );
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildFieldRestoreResult({
          config,
          windowId,
          fixture,
          prepareMeasurement,
          seedReadyMeasurement,
          setupMeasurement,
          operationMeasurement,
          verifyMeasurement,
          error,
        }),
      );
    }

    return buildFieldRestoreResult({
      config,
      windowId,
      fixture,
      prepareMeasurement,
      seedReadyMeasurement,
      setupMeasurement,
      operationMeasurement,
      verifyMeasurement,
    });
  } finally {
    await cleanupFieldRestoreFixture(baseId, prepareMeasurement?.result);
  }
};
