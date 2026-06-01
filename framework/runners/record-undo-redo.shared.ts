import { Colors, FieldKeyType, FieldType } from "@teable/core";
import {
  axios,
  deleteSelectionStream,
  RangeType,
  redoStream,
  undoStream,
} from "@teable/openapi";
import {
  createRecords,
  createTable,
  getFields,
  getRecords,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs } from "../env";
import { measureAsync } from "../metrics";
import {
  buildSeedCacheInfo,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  PerfRunnerKind,
  RecordUndoRedoBaseCaseConfig,
} from "../types";

export type Measurement<T> = {
  name: string;
  durationMs: number;
  result: T;
};

type NamedField = {
  id: string;
  name: string;
  type?: FieldType;
};

type OperationField = RecordUndoRedoBaseCaseConfig["fields"][number] & {
  id: string;
  name: string;
};

type SeededRecord = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
};

export type RecordUndoRedoOperation = "delete" | "undo" | "redo";

export type RecordUndoRedoFixture = {
  tableId: string;
  tableName: string;
  viewId: string;
  fields: OperationField[];
  projection: string[];
  seededRecords: SeededRecord[];
  seedBatchDurations: number[];
  seedCacheInfo?: SeedCacheInfo;
  seedCacheHit?: boolean;
  reusableSeed?: boolean;
};

export type RecordReplayVerification = {
  scannedRecords: number;
  pageSize: number;
  pageCount: number;
  verifiedSamples: Array<Record<string, unknown>>;
};

export type RecordReplaySetupMeasurements = {
  deleteSetupMeasurement?: Measurement<unknown>;
  deleteSetupVerifyMeasurement?: Measurement<RecordReplayVerification>;
  undoSetupMeasurement?: Measurement<unknown>;
  undoSetupVerifyMeasurement?: Measurement<RecordReplayVerification>;
};

type RecordUndoRedoSeedOptions = {
  perfCase: PerfCase;
  runner: PerfRunnerKind;
  seedCodeFiles?: URL[];
};

type ExpectedCellValue = string | number | boolean | string[] | null;

const WINDOW_ID_HEADER = "X-Window-Id";
const STATUS_CHOICES = ["Todo", "Doing", "Done"];
const PRIORITY_CHOICES = ["P0", "P1", "P2"];
const TAG_CHOICES = ["Alpha", "Beta", "Gamma", "Delta"];
const CATEGORY_CHOICES = ["A", "B", "C"];
const LABEL_CHOICES = ["Red", "Blue", "Green"];

const selectChoices = (names: string[]) =>
  names.map((name, index) => ({
    name,
    color: [
      Colors.BlueBright,
      Colors.GreenBright,
      Colors.OrangeBright,
      Colors.PurpleBright,
      Colors.CyanBright,
    ][index % 5],
  }));

const dateOptions = {
  formatting: {
    date: "YYYY-MM-DD",
    time: "None",
    timeZone: "Asia/Shanghai",
  },
};

export const undoRedoMixed20Fields = [
  { name: "Title", type: FieldType.SingleLineText },
  { name: "Description", type: FieldType.LongText },
  {
    name: "Status",
    type: FieldType.SingleSelect,
    options: { choices: selectChoices(STATUS_CHOICES) },
  },
  {
    name: "Priority",
    type: FieldType.SingleSelect,
    options: { choices: selectChoices(PRIORITY_CHOICES) },
  },
  {
    name: "Tags",
    type: FieldType.MultipleSelect,
    options: {
      choices: selectChoices(TAG_CHOICES),
    },
  },
  { name: "Amount", type: FieldType.Number },
  { name: "Quantity", type: FieldType.Number },
  { name: "Start Date", type: FieldType.Date, options: dateOptions },
  { name: "Due Date", type: FieldType.Date, options: dateOptions },
  { name: "Active", type: FieldType.Checkbox },
  {
    name: "Score",
    type: FieldType.Rating,
    options: {
      icon: "star",
      color: Colors.YellowBright,
      max: 5,
    },
  },
  { name: "Owner Text", type: FieldType.SingleLineText },
  { name: "Notes", type: FieldType.LongText },
  {
    name: "Category",
    type: FieldType.SingleSelect,
    options: { choices: selectChoices(CATEGORY_CHOICES) },
  },
  {
    name: "Labels",
    type: FieldType.MultipleSelect,
    options: { choices: selectChoices(LABEL_CHOICES) },
  },
  { name: "External ID", type: FieldType.SingleLineText },
  { name: "Source", type: FieldType.SingleLineText },
  { name: "Percent", type: FieldType.Number },
  { name: "Approved", type: FieldType.Checkbox },
  { name: "Comment", type: FieldType.LongText },
];

export const undoRedo10kBaseConfig = {
  baseId: "seed-base" as const,
  rowCount: 10_000,
  batchSize: 1_000,
  fields: undoRedoMixed20Fields,
  generator: {
    type: "mixed-undo-redo" as const,
    titlePrefix: "Item",
    payloadPrefix: "Undo redo",
    source: "perf-lab-undo-redo",
  },
  verify: {
    sampleRows: [0, 4_999, 9_999],
    fullScanPageSize: 1_000,
  },
};

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const buildSyntheticSeededRecords = (rowCount: number): SeededRecord[] =>
  Array.from({ length: rowCount }, (_, index) => ({
    rowOffset: index,
    rowNumber: index + 1,
    recordId: "",
  }));

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const dateOnlyForRow = (rowNumber: number, offsetDays = 0) => {
  const date = new Date(
    Date.UTC(2026, 0, 1 + offsetDays + ((rowNumber - 1) % 365)),
  );
  return date.toISOString().slice(0, 10);
};

const getExpectedCellValue = (
  field: RecordUndoRedoBaseCaseConfig["fields"][number],
  rowNumber: number,
  config: RecordUndoRedoBaseCaseConfig,
): ExpectedCellValue => {
  const padded = padRowNumber(rowNumber);

  switch (field.name) {
    case "Title":
      return `${config.generator.titlePrefix} ${padded}`;
    case "Description":
      return `${config.generator.payloadPrefix} description ${padded}`;
    case "Status":
      return STATUS_CHOICES[(rowNumber - 1) % STATUS_CHOICES.length];
    case "Priority":
      return PRIORITY_CHOICES[(rowNumber - 1) % PRIORITY_CHOICES.length];
    case "Tags":
      return [
        TAG_CHOICES[(rowNumber - 1) % TAG_CHOICES.length],
        TAG_CHOICES[rowNumber % TAG_CHOICES.length],
      ];
    case "Amount":
      return Number((rowNumber * 1.25).toFixed(2));
    case "Quantity":
      return rowNumber;
    case "Start Date":
      return dateOnlyForRow(rowNumber);
    case "Due Date":
      return dateOnlyForRow(rowNumber, 7);
    case "Active":
      return rowNumber % 2 === 1;
    case "Score":
      return ((rowNumber - 1) % 5) + 1;
    case "Owner Text":
      return `Owner ${((rowNumber - 1) % 10) + 1}`;
    case "Notes":
      return `${config.generator.payloadPrefix} notes ${padded}`;
    case "Category":
      return CATEGORY_CHOICES[(rowNumber - 1) % CATEGORY_CHOICES.length];
    case "Labels":
      return [
        LABEL_CHOICES[(rowNumber - 1) % LABEL_CHOICES.length],
        LABEL_CHOICES[rowNumber % LABEL_CHOICES.length],
      ];
    case "External ID":
      return `UNDO-REDO-${padded}`;
    case "Source":
      return config.generator.source ?? "perf-lab-undo-redo";
    case "Percent":
      return Number((rowNumber / config.rowCount).toFixed(4));
    case "Approved":
      return rowNumber % 3 === 0;
    case "Comment":
      return `${config.generator.payloadPrefix} comment ${padded}`;
    default:
      return null;
  }
};

const buildRecordFields = (
  config: RecordUndoRedoBaseCaseConfig,
  rowNumber: number,
) =>
  Object.fromEntries(
    config.fields.map((field) => [
      field.name,
      getExpectedCellValue(field, rowNumber, config),
    ]),
  );

const resolveOperationFields = (
  fields: NamedField[],
  config: RecordUndoRedoBaseCaseConfig,
): OperationField[] => {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  return config.fields.map((field) => {
    const resolvedField = fieldByName.get(field.name);
    if (!resolvedField) {
      throw new Error(
        `Missing operation field ${field.name}; available fields: ${fields
          .map(({ name }) => name)
          .join(", ")}`,
      );
    }
    return {
      ...field,
      id: resolvedField.id,
      name: resolvedField.name,
    };
  });
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
  if (typeof expectedValue === "number") {
    return Number(actualValue) === expectedValue;
  }
  return actualValue === expectedValue;
};

const buildAllRowsRange = (fixture: RecordUndoRedoFixture) => ({
  viewId: fixture.viewId,
  type: RangeType.Rows,
  ranges: [[0, fixture.seededRecords.length - 1] as [number, number]],
  projection: fixture.projection,
});

const getStreamHeaders = (context: PerfRunContext) =>
  context.cookie ? { Cookie: context.cookie } : undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const formatRowCountLabel = (rowCount: number) =>
  rowCount % 1_000 === 0 ? `${rowCount / 1_000}k` : String(rowCount);

export const buildRecordReplayPhaseName = (
  prefix: "deleteSetup" | "undoSetup",
  rowCount: number,
) => `${prefix}${formatRowCountLabel(rowCount)}`;

const durationMetricKey = (phaseName: string) =>
  phaseName.endsWith("Ms") ? phaseName : `${phaseName}Ms`;

export const buildRecordWindowId = (
  context: PerfRunContext,
  perfCase: PerfCase,
) =>
  `win-${context.runId}-${context.engine}-${perfCase.id}-${Date.now()}`.replace(
    /[^A-Za-z0-9_-]/g,
    "-",
  );

export const withRecordWindowId = async <T>(
  windowId: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const previousWindowId =
    axios.defaults.headers.common[WINDOW_ID_HEADER]?.toString();
  axios.defaults.headers.common[WINDOW_ID_HEADER] = windowId;

  try {
    return await fn();
  } finally {
    if (previousWindowId == null) {
      delete axios.defaults.headers.common[WINDOW_ID_HEADER];
    } else {
      axios.defaults.headers.common[WINDOW_ID_HEADER] = previousWindowId;
    }
  }
};

const seedRecords = async (
  fixture: Omit<RecordUndoRedoFixture, "seededRecords" | "seedBatchDurations">,
  config: RecordUndoRedoBaseCaseConfig,
) => {
  const records = Array.from({ length: config.rowCount }, (_, index) => {
    const rowNumber = index + 1;
    return {
      rowOffset: index,
      rowNumber,
      record: {
        fields: buildRecordFields(config, rowNumber),
      },
    };
  });
  const batches = chunk(records, config.batchSize);
  const seededRecords: SeededRecord[] = [];
  const batchDurations: number[] = [];

  for (const [batchIndex, batch] of batches.entries()) {
    const batchMeasurement = await measureAsync(
      `seedBatch:${batchIndex + 1}`,
      () =>
        createRecords(fixture.tableId, {
          fieldKeyType: FieldKeyType.Name,
          typecast: true,
          records: batch.map((item) => item.record),
        }),
    );
    batchDurations.push(batchMeasurement.durationMs);
    expect(batchMeasurement.result.records).toHaveLength(batch.length);
    batchMeasurement.result.records.forEach((record, index) => {
      const input = batch[index];
      if (!input) {
        return;
      }
      seededRecords.push({
        rowOffset: input.rowOffset,
        rowNumber: input.rowNumber,
        recordId: record.id,
      });
    });
  }

  return { seededRecords, batchDurations };
};

const getRecordUndoRedoSeedConfig = (config: RecordUndoRedoBaseCaseConfig) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  fields: config.fields,
  generator: config.generator,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: "record-undo-redo-v1",
});

const buildBaseFixture = async (
  tableId: string,
  tableName: string,
  config: RecordUndoRedoBaseCaseConfig,
): Promise<
  Omit<RecordUndoRedoFixture, "seededRecords" | "seedBatchDurations">
> => {
  const tableFields = await getFields(tableId);
  const views = await getViews(tableId);
  const viewId = views[0]?.id;

  if (!viewId) {
    throw new Error(`No grid view found for undo-redo table ${tableId}`);
  }

  const fields = resolveOperationFields(tableFields, config);
  return {
    tableId,
    tableName,
    viewId,
    fields,
    projection: fields.map((field) => field.id),
  };
};

export const prepareRecordUndoRedoFixture = async (
  baseId: string,
  tableName: string,
  config: RecordUndoRedoBaseCaseConfig,
  seedOptions?: RecordUndoRedoSeedOptions,
): Promise<RecordUndoRedoFixture> => {
  const seedCacheInfo = seedOptions
    ? await buildSeedCacheInfo({
        perfCase: seedOptions.perfCase,
        runner: seedOptions.runner,
        fixtureVersion: "record-undo-redo-v1",
        seedConfig: getRecordUndoRedoSeedConfig(config),
        seedCodeFiles: [
          new URL(import.meta.url),
          new URL("../seed-cache.ts", import.meta.url),
          ...(seedOptions.seedCodeFiles ?? []),
        ],
      })
    : undefined;

  const cachedTable =
    seedCacheInfo?.enabled &&
    (await findSeedTable(baseId, seedCacheInfo.seedTableName));

  if (cachedTable && seedCacheInfo) {
    try {
      const cachedFixture: RecordUndoRedoFixture = {
        ...(await buildBaseFixture(cachedTable.id, cachedTable.name, config)),
        seededRecords: buildSyntheticSeededRecords(config.rowCount),
        seedBatchDurations: [0],
        seedCacheInfo,
        seedCacheHit: true,
        reusableSeed: true,
      };
      await assertRowsRestored(cachedFixture, config);
      return cachedFixture;
    } catch (error) {
      console.warn(
        `Invalid cached record seed ${seedCacheInfo.seedTableName}; rebuilding`,
        error,
      );
      await permanentDeleteTable(baseId, cachedTable.id);
    }
  }

  const actualTableName = seedCacheInfo?.enabled
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

    const baseFixture = await buildBaseFixture(
      table.id,
      actualTableName,
      config,
    );
    const seeded = await seedRecords(baseFixture, config);

    return {
      ...baseFixture,
      seededRecords: seeded.seededRecords,
      seedBatchDurations: seeded.batchDurations,
      seedCacheInfo,
      seedCacheHit: false,
      reusableSeed: seedCacheInfo?.enabled ?? false,
    };
  } catch (error) {
    if (createdTableId) {
      try {
        await permanentDeleteTable(baseId, createdTableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup incomplete record seed ${createdTableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

export const deleteAllRows = async (
  fixture: RecordUndoRedoFixture,
  context: PerfRunContext,
) => {
  const result = await deleteSelectionStream(
    fixture.tableId,
    buildAllRowsRange(fixture),
    {
      headers: getStreamHeaders(context),
    },
  );
  expect(result.errors).toHaveLength(0);
  expect(result.done.deletedCount).toBe(fixture.seededRecords.length);
  expect(result.done.data.deletedRecordIds).toHaveLength(
    fixture.seededRecords.length,
  );
  return result;
};

export const undoLastOperation = async (
  fixture: RecordUndoRedoFixture,
  context: PerfRunContext,
) => {
  const result = await undoStream(fixture.tableId, {
    headers: getStreamHeaders(context),
  });
  expect(result.errors).toHaveLength(0);
  expect(result.data.status).toBe("fulfilled");
  return result;
};

export const redoLastOperation = async (
  fixture: RecordUndoRedoFixture,
  context: PerfRunContext,
) => {
  const result = await redoStream(fixture.tableId, {
    headers: getStreamHeaders(context),
  });
  expect(result.errors).toHaveLength(0);
  expect(result.data.status).toBe("fulfilled");
  return result;
};

export const assertRowsRestored = async (
  fixture: RecordUndoRedoFixture,
  config: RecordUndoRedoBaseCaseConfig,
): Promise<RecordReplayVerification> => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleRowOffsets = new Set(config.verify.sampleRows);
  const fieldsToVerify = fixture.fields.filter((field) =>
    ["Title", "Status", "External ID"].includes(field.name),
  );
  const verifiedSamples: RecordReplayVerification["verifiedSamples"] = [];
  let scannedRecords = 0;
  let pageCount = 0;

  for (let skip = 0; skip < config.rowCount; skip += pageSize) {
    const expectedTake = Math.min(pageSize, config.rowCount - skip);
    const result = await getRecords(fixture.tableId, {
      viewId: fixture.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: fixture.projection,
      skip,
      take: expectedTake,
    });
    pageCount += 1;

    if (result.records.length !== expectedTake) {
      throw new Error(
        `Expected ${expectedTake} records at skip ${skip}, got ${result.records.length}`,
      );
    }

    for (const [index, record] of result.records.entries()) {
      const rowNumber = skip + index + 1;
      const actual: Record<string, unknown> = {};
      const expected: Record<string, unknown> = {};

      for (const field of fieldsToVerify) {
        const actualValue = record.fields[field.id];
        const expectedValue = getExpectedCellValue(field, rowNumber, config);
        actual[field.name] = actualValue;
        expected[field.name] = expectedValue;

        if (!valuesMatch(expectedValue, actualValue)) {
          throw new Error(
            `Row ${rowNumber} ${field.name} mismatch after restore: expected ${String(
              expectedValue,
            )}, actual ${String(actualValue)}`,
          );
        }
      }

      const rowOffset = rowNumber - 1;
      if (sampleRowOffsets.has(rowOffset)) {
        verifiedSamples.push({
          rowOffset,
          rowNumber,
          recordId: record.id,
          actual,
          expected,
        });
      }
      scannedRecords += 1;
    }
  }

  return {
    scannedRecords,
    pageSize,
    pageCount,
    verifiedSamples,
  };
};

export const waitForRowsRestored = async (
  fixture: RecordUndoRedoFixture,
  config: RecordUndoRedoBaseCaseConfig,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<RecordReplayVerification> => {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const started = Date.now();
  let lastError: unknown;

  while (Date.now() - started < timeoutMs) {
    try {
      return await assertRowsRestored(fixture, config);
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(
    `Timed out waiting for ${config.rowCount} restored records in table ${fixture.tableId}`,
  );
};

export const assertDeleted = async (
  fixture: RecordUndoRedoFixture,
): Promise<RecordReplayVerification> => {
  const result = await getRecords(fixture.tableId, {
    viewId: fixture.viewId,
    fieldKeyType: FieldKeyType.Id,
    projection: fixture.projection,
    skip: 0,
    take: 1,
  });

  if (result.records.length !== 0) {
    throw new Error(
      `Expected all records deleted, got ${result.records.length}`,
    );
  }

  return {
    scannedRecords: 0,
    pageSize: 1,
    pageCount: 1,
    verifiedSamples: [],
  };
};

export const cleanupRecordUndoRedoFixture = async (
  baseId: string,
  prepareMeasurement?: Measurement<RecordUndoRedoFixture>,
  options?: {
    config?: RecordUndoRedoBaseCaseConfig;
    context?: PerfRunContext;
    windowId?: string;
  },
) => {
  const fixture = prepareMeasurement?.result;
  if (!fixture?.tableId) {
    return;
  }

  if (fixture.reusableSeed && options?.config) {
    try {
      await assertRowsRestored(fixture, options.config);
      return;
    } catch {
      // The measured operation may have deleted rows; try the real undo path
      // once so the cached fixture is ready for the next engine or workflow run.
    }

    if (options.context && options.windowId) {
      try {
        await withRecordWindowId(options.windowId, async () => {
          await undoLastOperation(fixture, options.context!);
        });
        await waitForRowsRestored(fixture, options.config);
        return;
      } catch (error) {
        console.warn(
          `Failed to restore cached record seed ${fixture.tableId}; deleting it`,
          error,
        );
      }
    }
  }

  try {
    await permanentDeleteTable(baseId, fixture.tableId);
  } catch (error) {
    console.warn(`Failed to cleanup perf table ${fixture.tableId}`, error);
  }
};

export const buildRecordReplayResult = ({
  config,
  operation,
  windowId,
  fixture,
  prepareMeasurement,
  seedReadyMeasurement,
  setupMeasurements,
  operationMeasurement,
  verifyMeasurement,
  error,
}: {
  config: RecordUndoRedoBaseCaseConfig & {
    threshold: { metric: string; maxMs: number };
  };
  operation: RecordUndoRedoOperation;
  windowId?: string;
  fixture?: RecordUndoRedoFixture;
  prepareMeasurement?: Measurement<RecordUndoRedoFixture>;
  seedReadyMeasurement?: Measurement<RecordReplayVerification>;
  setupMeasurements?: RecordReplaySetupMeasurements;
  operationMeasurement?: Measurement<unknown>;
  verifyMeasurement?: Measurement<RecordReplayVerification>;
  error?: unknown;
}): PerfRunResult => {
  const deleteSetupMetricKey = setupMeasurements?.deleteSetupMeasurement
    ? durationMetricKey(setupMeasurements.deleteSetupMeasurement.name)
    : undefined;
  const undoSetupMetricKey = setupMeasurements?.undoSetupMeasurement
    ? durationMetricKey(setupMeasurements.undoSetupMeasurement.name)
    : undefined;

  return {
    metrics: {
      ...(prepareMeasurement
        ? { prepareMs: prepareMeasurement.durationMs }
        : {}),
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
      ...(setupMeasurements?.deleteSetupMeasurement
        ? {
            [deleteSetupMetricKey!]:
              setupMeasurements.deleteSetupMeasurement.durationMs,
          }
        : {}),
      ...(setupMeasurements?.deleteSetupVerifyMeasurement
        ? {
            deleteSetupVerifyMs:
              setupMeasurements.deleteSetupVerifyMeasurement.durationMs,
          }
        : {}),
      ...(setupMeasurements?.undoSetupMeasurement
        ? {
            [undoSetupMetricKey!]:
              setupMeasurements.undoSetupMeasurement.durationMs,
          }
        : {}),
      ...(setupMeasurements?.undoSetupVerifyMeasurement
        ? {
            undoSetupVerifyMs:
              setupMeasurements.undoSetupVerifyMeasurement.durationMs,
          }
        : {}),
      ...(operationMeasurement
        ? { [config.threshold.metric]: operationMeasurement.durationMs }
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
      ...(setupMeasurements?.deleteSetupMeasurement
        ? [
            {
              name: setupMeasurements.deleteSetupMeasurement.name,
              durationMs: setupMeasurements.deleteSetupMeasurement.durationMs,
            },
          ]
        : []),
      ...(setupMeasurements?.deleteSetupVerifyMeasurement
        ? [
            {
              name: setupMeasurements.deleteSetupVerifyMeasurement.name,
              durationMs:
                setupMeasurements.deleteSetupVerifyMeasurement.durationMs,
            },
          ]
        : []),
      ...(setupMeasurements?.undoSetupMeasurement
        ? [
            {
              name: setupMeasurements.undoSetupMeasurement.name,
              durationMs: setupMeasurements.undoSetupMeasurement.durationMs,
            },
          ]
        : []),
      ...(setupMeasurements?.undoSetupVerifyMeasurement
        ? [
            {
              name: setupMeasurements.undoSetupVerifyMeasurement.name,
              durationMs:
                setupMeasurements.undoSetupVerifyMeasurement.durationMs,
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
      operation,
      windowId,
      tableId: fixture?.tableId,
      tableName: fixture?.tableName,
      viewId: fixture?.viewId,
      rowCount: config.rowCount,
      batchSize: config.batchSize,
      fields: fixture?.fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
      })),
      seed: fixture
        ? {
            seededRecords: fixture.seededRecords.length,
            batchCount: fixture.seedBatchDurations.length,
            maxSeedBatchMs: fixture.seedBatchDurations.length
              ? Math.max(...fixture.seedBatchDurations)
              : undefined,
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
      replaySetup: setupMeasurements
        ? {
            ...(setupMeasurements.deleteSetupMeasurement && deleteSetupMetricKey
              ? {
                  [deleteSetupMetricKey]:
                    setupMeasurements.deleteSetupMeasurement.durationMs,
                }
              : {}),
            deleteSetupVerifyMs:
              setupMeasurements.deleteSetupVerifyMeasurement?.durationMs,
            ...(setupMeasurements.undoSetupMeasurement && undoSetupMetricKey
              ? {
                  [undoSetupMetricKey]:
                    setupMeasurements.undoSetupMeasurement.durationMs,
                }
              : {}),
            undoSetupVerifyMs:
              setupMeasurements.undoSetupVerifyMeasurement?.durationMs,
          }
        : undefined,
      fullScan: verifyMeasurement?.result
        ? {
            scannedRecords: verifyMeasurement.result.scannedRecords,
            pageSize: verifyMeasurement.result.pageSize,
            pageCount: verifyMeasurement.result.pageCount,
          }
        : undefined,
      verifiedSamples: verifyMeasurement?.result.verifiedSamples,
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
