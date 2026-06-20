import { FieldKeyType, FieldType } from "@teable/core";
import { updateRecordOrders, updateTableDescription } from "@teable/openapi";
import {
  createRecords,
  createTable,
  getFields,
  getRecords,
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
import { withPerfTraceStep } from "../trace-collector";
import type {
  MetricThreshold,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  PerfRunnerKind,
  RecordReorderCaseConfig,
  RecordUndoRedoBaseCaseConfig,
} from "../types";
import {
  undoRedoMixed20Fields,
  withRecordWindowId,
} from "./record-undo-redo.shared";
import {
  runRecordMutationLifecycle,
  seedRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

type ReorderField = RecordReorderCaseConfig["fields"][number] & {
  id: string;
  name: string;
};

type OrderedRecord = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
  title: unknown;
};

type ReorderFixture = {
  tableId: string;
  tableName: string;
  viewId: string;
  fields: ReorderField[];
  projection: string[];
  seedBatchDurations: number[];
  cachedOrder?: CachedReorderOrder;
  seedCacheInfo?: SeedCacheInfo;
  seedCacheHit?: boolean;
  orderCacheHit?: boolean;
  reusableSeed?: boolean;
};

type ReorderVerification = {
  firstRecordId?: string;
  anchorRecordId?: string;
  movedRecordIds: string[];
  verifiedSamples: Array<Record<string, unknown>>;
  checkedPositions: Array<{
    viewOffset: number;
    expectedOriginalRowNumber: number;
    recordId: string;
  }>;
};

type ReorderOperationResult = {
  status: number;
  requestMs: number;
  updatedRecordCount: number;
  responseHeaders: {
    "x-teable-v2": string;
    "x-teable-v2-feature": string;
    "x-teable-v2-reason": string;
    traceparent: string;
  };
  routing: EngineRouting;
  verification?: ReorderVerification;
  verifyReorderMs?: number;
};

const RECORD_REORDER_FIXTURE_VERSION = "record-reorder-v2";
const RECORD_REORDER_METADATA_PREFIX = "perf-lab-record-reorder:";
const DEFAULT_PAGE_SIZE = 1_000;
const RECORD_REORDER_RUNNER = "record-reorder" as PerfRunnerKind;

type CachedReorderOrder = {
  fixtureVersion: string;
  rowCount: number;
  fieldIds: string[];
  initialRecordIds: string[];
  anchorRecordId: string;
  movedRecordIds: string[];
  restoreAnchorRecordId: string;
};

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const dateOnlyForRow = (rowNumber: number, offsetDays = 0) => {
  const date = new Date(
    Date.UTC(2026, 0, 1 + offsetDays + ((rowNumber - 1) % 365)),
  );
  return date.toISOString().slice(0, 10);
};

const getExpectedCellValue = (
  field: RecordReorderCaseConfig["fields"][number],
  rowNumber: number,
  config: RecordReorderCaseConfig,
) => {
  const padded = padRowNumber(rowNumber);

  switch (field.name) {
    case "Title":
      return `${config.generator.titlePrefix} ${padded}`;
    case "Description":
      return `${config.generator.payloadPrefix} description ${padded}`;
    case "Status":
      return ["Todo", "Doing", "Done"][(rowNumber - 1) % 3];
    case "Priority":
      return ["P0", "P1", "P2"][(rowNumber - 1) % 3];
    case "Tags":
      return [
        ["Alpha", "Beta", "Gamma", "Delta"][(rowNumber - 1) % 4],
        ["Alpha", "Beta", "Gamma", "Delta"][rowNumber % 4],
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
      return ["A", "B", "C"][(rowNumber - 1) % 3];
    case "Labels":
      return [
        ["Red", "Blue", "Green"][(rowNumber - 1) % 3],
        ["Red", "Blue", "Green"][rowNumber % 3],
      ];
    case "External ID":
      return `REORDER-${padded}`;
    case "Source":
      return config.generator.source ?? "perf-lab-record-reorder";
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

const getFieldTimeZone = (field: RecordReorderCaseConfig["fields"][number]) => {
  const options = field.options as
    | { formatting?: { timeZone?: string } }
    | undefined;
  return options?.formatting?.timeZone ?? "UTC";
};

const formatDateInTimeZone = (value: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const partByType = new Map(parts.map((part) => [part.type, part.value]));
  return `${partByType.get("year")}-${partByType.get("month")}-${partByType.get(
    "day",
  )}`;
};

const normalizeValue = (
  field: RecordReorderCaseConfig["fields"][number],
  value: unknown,
) => {
  if (field.type === FieldType.Checkbox && value == null) {
    return false;
  }
  if (field.type !== FieldType.Date) {
    return value;
  }
  if (value instanceof Date) {
    return formatDateInTimeZone(value, getFieldTimeZone(field));
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.includes("T")
      ? formatDateInTimeZone(new Date(value), getFieldTimeZone(field))
      : value.slice(0, 10);
  }
  return value;
};

const valuesMatch = (
  field: RecordReorderCaseConfig["fields"][number],
  expected: unknown,
  actual: unknown,
) =>
  JSON.stringify(normalizeValue(field, actual)) ===
  JSON.stringify(normalizeValue(field, expected));

const buildRecordFields = (
  config: RecordReorderCaseConfig,
  rowNumber: number,
) =>
  Object.fromEntries(
    config.fields.map((field) => [
      field.name,
      getExpectedCellValue(field, rowNumber, config),
    ]),
  );

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const pickResponseHeaders = pickRoutingResponseHeaders;

const resolveFields = (
  tableFields: Array<{ id: string; name: string }>,
  config: RecordReorderCaseConfig,
): ReorderField[] => {
  const fieldByName = new Map(tableFields.map((field) => [field.name, field]));
  return config.fields.map((field) => {
    const resolvedField = fieldByName.get(field.name);
    if (!resolvedField) {
      throw new Error(
        `Missing reorder field ${field.name}; available fields: ${tableFields
          .map(({ name }) => name)
          .join(", ")}`,
      );
    }
    return { ...field, id: resolvedField.id, name: resolvedField.name };
  });
};

const buildBaseFixture = async (
  tableId: string,
  tableName: string,
  config: RecordReorderCaseConfig,
): Promise<Omit<ReorderFixture, "seedBatchDurations">> => {
  const tableFields = await getFields(tableId);
  const views = await getViews(tableId);
  const viewId = views[0]?.id;

  if (!viewId) {
    throw new Error(`No grid view found for reorder table ${tableId}`);
  }

  const fields = resolveFields(tableFields, config);
  return {
    tableId,
    tableName,
    viewId,
    fields,
    projection: fields.map((field) => field.id),
  };
};

const seedRecords = async (
  fixture: Omit<ReorderFixture, "seedBatchDurations">,
  config: RecordReorderCaseConfig,
) => {
  const inputs = Array.from({ length: config.rowCount }, (_, index) => {
    const rowNumber = index + 1;
    return {
      fields: buildRecordFields(config, rowNumber),
    };
  });
  const batchDurations: number[] = [];

  for (const [batchIndex, batch] of chunk(inputs, config.batchSize).entries()) {
    const batchMeasurement = await measureAsync(
      `seedBatch:${batchIndex + 1}`,
      () =>
        createRecords(fixture.tableId, {
          fieldKeyType: FieldKeyType.Name,
          typecast: true,
          records: batch,
        }),
    );
    expect(batchMeasurement.result.records).toHaveLength(batch.length);
    batchDurations.push(batchMeasurement.durationMs);
  }

  return batchDurations;
};

const getFieldIds = (fixture: Pick<ReorderFixture, "fields">) =>
  fixture.fields.map((field) => field.id);

const parseCachedReorderOrder = (
  description: string | null | undefined,
): CachedReorderOrder | undefined => {
  if (!description?.startsWith(RECORD_REORDER_METADATA_PREFIX)) {
    return;
  }
  try {
    return JSON.parse(
      description.slice(RECORD_REORDER_METADATA_PREFIX.length),
    ) as CachedReorderOrder;
  } catch {
    return;
  }
};

const persistCachedReorderOrder = async (
  baseId: string,
  tableId: string,
  metadata: CachedReorderOrder,
) => {
  await updateTableDescription(baseId, tableId, {
    description: `${RECORD_REORDER_METADATA_PREFIX}${JSON.stringify(metadata)}`,
  });
};

const buildCachedReorderOrder = (
  fixture: Pick<ReorderFixture, "fields">,
  config: RecordReorderCaseConfig,
  orderedRecords: OrderedRecord[],
): CachedReorderOrder => {
  const initialRecordIds = orderedRecords.map((record) => record.recordId);
  const anchorRecordId = initialRecordIds[config.reorder.anchorOffset];
  const movedRecordIds = initialRecordIds.slice(
    config.reorder.blockStartOffset,
    config.reorder.blockStartOffset + config.reorder.blockSize,
  );
  const restoreAnchorRecordId =
    config.reorder.blockStartOffset > 0
      ? initialRecordIds[config.reorder.blockStartOffset - 1]
      : undefined;
  if (!anchorRecordId || movedRecordIds.length !== config.reorder.blockSize) {
    throw new Error("Unable to build cached reorder order metadata");
  }
  if (!restoreAnchorRecordId) {
    throw new Error("Unable to build cached reorder restore anchor");
  }

  return {
    fixtureVersion: RECORD_REORDER_FIXTURE_VERSION,
    rowCount: config.rowCount,
    fieldIds: getFieldIds(fixture),
    initialRecordIds,
    anchorRecordId,
    movedRecordIds,
    restoreAnchorRecordId,
  };
};

const resolveCachedReorderOrder = (
  fixture: Pick<ReorderFixture, "fields">,
  config: RecordReorderCaseConfig,
  cachedOrder?: CachedReorderOrder,
) => {
  if (
    cachedOrder?.fixtureVersion === RECORD_REORDER_FIXTURE_VERSION &&
    cachedOrder.rowCount === config.rowCount &&
    cachedOrder.initialRecordIds.length === config.rowCount &&
    cachedOrder.movedRecordIds.length === config.reorder.blockSize &&
    JSON.stringify(cachedOrder.fieldIds) ===
      JSON.stringify(getFieldIds(fixture))
  ) {
    return cachedOrder;
  }
};

const getSeedConfig = (config: RecordReorderCaseConfig) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  fields: config.fields,
  generator: config.generator,
  reorder: config.reorder,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: RECORD_REORDER_FIXTURE_VERSION,
});

const prepareFixture = async (
  baseId: string,
  tableName: string,
  config: RecordReorderCaseConfig,
  perfCase: PerfCase,
): Promise<ReorderFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: RECORD_REORDER_RUNNER,
    fixtureVersion: RECORD_REORDER_FIXTURE_VERSION,
    seedConfig: getSeedConfig(config),
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
      const fixture: ReorderFixture = {
        ...(await buildBaseFixture(cachedTable.id, cachedTable.name, config)),
        seedBatchDurations: [0],
        seedCacheInfo,
        seedCacheHit: true,
        reusableSeed: true,
      };
      const cachedOrder = resolveCachedReorderOrder(
        fixture,
        config,
        parseCachedReorderOrder(tableMeta.description),
      );
      if (!cachedOrder) {
        throw new Error(
          `Missing cached record reorder order for ${seedCacheInfo.seedTableName}`,
        );
      }
      const fixtureWithOrder = {
        ...fixture,
        cachedOrder,
        orderCacheHit: true,
      };
      await assertSeedReady(fixtureWithOrder, config);
      return fixtureWithOrder;
    } catch (error) {
      console.warn(
        `Invalid cached record reorder seed ${seedCacheInfo.seedTableName}; rebuilding`,
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
    const fixtureWithoutDurations = await buildBaseFixture(
      table.id,
      actualTableName,
      config,
    );
    const seedBatchDurations = await seedRecords(
      fixtureWithoutDurations,
      config,
    );
    const fixture: ReorderFixture = {
      ...fixtureWithoutDurations,
      seedBatchDurations,
      seedCacheInfo,
      seedCacheHit: false,
      orderCacheHit: false,
      reusableSeed: seedCacheInfo.enabled,
    };
    const orderedRecords = await readOrderedRecords(fixture, config);
    assertOrderMatches(
      orderedRecords,
      config,
      buildInitialRowNumbers(config),
      "initial order",
    );
    const cachedOrder = buildCachedReorderOrder(
      fixture,
      config,
      orderedRecords,
    );
    await persistCachedReorderOrder(baseId, table.id, cachedOrder);
    return {
      ...fixture,
      cachedOrder,
    };
  } catch (error) {
    if (createdTableId) {
      try {
        await permanentDeleteTable(baseId, createdTableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup incomplete record reorder seed ${createdTableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const readOrderedRecords = async (
  fixture: ReorderFixture,
  config: RecordReorderCaseConfig,
): Promise<OrderedRecord[]> => {
  const pageSize = config.verify.fullScanPageSize ?? DEFAULT_PAGE_SIZE;
  const titleField = fixture.fields.find((field) => field.name === "Title");
  if (!titleField) {
    throw new Error("Record reorder fixture is missing Title field");
  }

  const orderedRecords: OrderedRecord[] = [];
  for (let skip = 0; skip < config.rowCount; skip += pageSize) {
    const expectedTake = Math.min(pageSize, config.rowCount - skip);
    const result = await getRecords(fixture.tableId, {
      viewId: fixture.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: [titleField.id],
      skip,
      take: expectedTake,
    });

    if (result.records.length !== expectedTake) {
      throw new Error(
        `Expected ${expectedTake} ordered records at skip ${skip}, got ${result.records.length}`,
      );
    }

    for (const [index, record] of result.records.entries()) {
      const rowOffset = skip + index;
      orderedRecords.push({
        rowOffset,
        rowNumber: rowOffset + 1,
        recordId: record.id,
        title: record.fields[titleField.id],
      });
    }
  }

  return orderedRecords;
};

const expectedTitleForRowNumber = (
  config: RecordReorderCaseConfig,
  rowNumber: number,
) => `${config.generator.titlePrefix} ${padRowNumber(rowNumber)}`;

const assertOrderMatches = (
  orderedRecords: OrderedRecord[],
  config: RecordReorderCaseConfig,
  expectedRowNumbers: number[],
  label: string,
) => {
  if (orderedRecords.length !== expectedRowNumbers.length) {
    throw new Error(
      `${label}: expected ${expectedRowNumbers.length} records, got ${orderedRecords.length}`,
    );
  }

  for (const [index, expectedRowNumber] of expectedRowNumbers.entries()) {
    const actual = orderedRecords[index];
    const expectedTitle = expectedTitleForRowNumber(config, expectedRowNumber);
    if (actual?.title !== expectedTitle) {
      throw new Error(
        `${label}: expected row ${index + 1} title ${expectedTitle}, got ${String(
          actual?.title,
        )}`,
      );
    }
  }
};

const assertSeedReady = async (
  fixture: ReorderFixture,
  config: RecordReorderCaseConfig,
) => {
  const orderedRecords = await readOrderedRecords(fixture, config);
  assertOrderMatches(
    orderedRecords,
    config,
    buildInitialRowNumbers(config),
    "seed ready order",
  );
  return {
    checkedRecords: orderedRecords.length,
  };
};

const buildInitialRowNumbers = (config: RecordReorderCaseConfig) =>
  Array.from({ length: config.rowCount }, (_, index) => index + 1);

const buildReorderedRowNumbers = (config: RecordReorderCaseConfig) => {
  const initial = buildInitialRowNumbers(config);
  const moved = initial.splice(
    config.reorder.blockStartOffset,
    config.reorder.blockSize,
  );
  const anchorIndex = initial.indexOf(config.reorder.anchorOffset + 1);
  if (anchorIndex === -1) {
    throw new Error("Reorder anchor row is inside the moved block or missing");
  }
  initial.splice(anchorIndex, 0, ...moved);
  return initial;
};

const assertReordered = async (
  fixture: ReorderFixture,
  config: RecordReorderCaseConfig,
): Promise<ReorderVerification> => {
  if (!fixture.cachedOrder) {
    throw new Error("Missing cached reorder order metadata");
  }
  const checkedPositions = await verifyReorderedPositions(fixture, config);
  return {
    firstRecordId: fixture.cachedOrder.initialRecordIds[0],
    anchorRecordId: fixture.cachedOrder.anchorRecordId,
    movedRecordIds: fixture.cachedOrder.movedRecordIds,
    checkedPositions,
    verifiedSamples: await verifySampleFields(fixture, config),
  };
};

const getReorderedViewOffsetForOriginalRowNumber = (
  config: RecordReorderCaseConfig,
  rowNumber: number,
) => {
  const reorderedRowNumbers = buildReorderedRowNumbers(config);
  const index = reorderedRowNumbers.indexOf(rowNumber);
  if (index === -1) {
    throw new Error(`Missing reordered sample record for row ${rowNumber}`);
  }
  return index;
};

const readRecordAtViewOffset = async (
  fixture: ReorderFixture,
  viewOffset: number,
  projection: string[],
) => {
  const result = await getRecords(fixture.tableId, {
    viewId: fixture.viewId,
    fieldKeyType: FieldKeyType.Id,
    projection,
    skip: viewOffset,
    take: 1,
  });
  if (result.records.length !== 1) {
    throw new Error(
      `Expected one record at view offset ${viewOffset}, got ${result.records.length}`,
    );
  }
  return result.records[0];
};

const verifyReorderedPositions = async (
  fixture: ReorderFixture,
  config: RecordReorderCaseConfig,
) => {
  if (!fixture.cachedOrder) {
    throw new Error("Missing cached reorder order metadata");
  }
  const titleField = fixture.fields.find((field) => field.name === "Title");
  if (!titleField) {
    throw new Error("Record reorder fixture is missing Title field");
  }
  const positions = [
    {
      viewOffset: 0,
      expectedOriginalRowNumber: config.reorder.blockStartOffset + 1,
    },
    {
      viewOffset: Math.floor(config.reorder.blockSize / 2) - 1,
      expectedOriginalRowNumber:
        config.reorder.blockStartOffset +
        Math.floor(config.reorder.blockSize / 2),
    },
    {
      viewOffset: config.reorder.blockSize - 1,
      expectedOriginalRowNumber:
        config.reorder.blockStartOffset + config.reorder.blockSize,
    },
    {
      viewOffset: config.reorder.blockSize,
      expectedOriginalRowNumber: config.reorder.anchorOffset + 1,
    },
  ].filter(
    ({ viewOffset, expectedOriginalRowNumber }) =>
      viewOffset < config.rowCount &&
      expectedOriginalRowNumber <= config.rowCount,
  );
  const checkedPositions = [];
  for (const position of positions) {
    const record = await readRecordAtViewOffset(fixture, position.viewOffset, [
      titleField.id,
    ]);
    const expectedRecordId =
      fixture.cachedOrder.initialRecordIds[
        position.expectedOriginalRowNumber - 1
      ];
    const expectedTitle = expectedTitleForRowNumber(
      config,
      position.expectedOriginalRowNumber,
    );
    if (record.id !== expectedRecordId) {
      throw new Error(
        `Reordered position ${position.viewOffset} expected record ${expectedRecordId}, got ${record.id}`,
      );
    }
    if (record.fields[titleField.id] !== expectedTitle) {
      throw new Error(
        `Reordered position ${position.viewOffset} expected title ${expectedTitle}, got ${String(
          record.fields[titleField.id],
        )}`,
      );
    }
    checkedPositions.push({
      ...position,
      recordId: record.id,
    });
  }
  return checkedPositions;
};

const verifyInitialPositions = async (
  fixture: ReorderFixture,
  config: RecordReorderCaseConfig,
) => {
  if (!fixture.cachedOrder) {
    throw new Error("Missing cached reorder order metadata");
  }
  const titleField = fixture.fields.find((field) => field.name === "Title");
  if (!titleField) {
    throw new Error("Record reorder fixture is missing Title field");
  }
  const positions = [
    0,
    config.reorder.blockStartOffset,
    config.reorder.blockStartOffset + config.reorder.blockSize - 1,
  ].filter((viewOffset) => viewOffset >= 0 && viewOffset < config.rowCount);

  for (const viewOffset of positions) {
    const record = await readRecordAtViewOffset(fixture, viewOffset, [
      titleField.id,
    ]);
    const expectedRecordId = fixture.cachedOrder.initialRecordIds[viewOffset];
    const expectedTitle = expectedTitleForRowNumber(config, viewOffset + 1);
    if (record.id !== expectedRecordId) {
      throw new Error(
        `Initial position ${viewOffset} expected record ${expectedRecordId}, got ${record.id}`,
      );
    }
    if (record.fields[titleField.id] !== expectedTitle) {
      throw new Error(
        `Initial position ${viewOffset} expected title ${expectedTitle}, got ${String(
          record.fields[titleField.id],
        )}`,
      );
    }
  }
};

const verifySampleFields = async (
  fixture: ReorderFixture,
  config: RecordReorderCaseConfig,
) => {
  const verifiedSamples = [];

  for (const rowOffset of config.verify.sampleRows) {
    if (rowOffset < 0 || rowOffset >= config.rowCount) {
      throw new Error(
        `Sample row offset ${rowOffset} is outside rowCount ${config.rowCount}`,
      );
    }

    const rowNumber = rowOffset + 1;
    const viewOffset = getReorderedViewOffsetForOriginalRowNumber(
      config,
      rowNumber,
    );

    const record = await readRecordAtViewOffset(
      fixture,
      viewOffset,
      fixture.projection,
    );
    const expectedRecordId = fixture.cachedOrder?.initialRecordIds[rowOffset];
    if (record.id !== expectedRecordId) {
      throw new Error(
        `Sample row ${rowNumber} read unexpected record ${record.id}; expected ${expectedRecordId}`,
      );
    }
    const actual: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};

    for (const field of fixture.fields) {
      const expectedValue = getExpectedCellValue(field, rowNumber, config);
      const actualValue = record.fields[field.id];
      actual[field.name] = actualValue;
      expected[field.name] = expectedValue;

      if (!valuesMatch(field, expectedValue, actualValue)) {
        throw new Error(
          `Row ${rowNumber} ${field.name} changed during reorder: expected ${String(
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

  return verifiedSamples;
};

const moveRecords = async ({
  fixture,
  recordIds,
  anchorId,
  config,
}: {
  fixture: ReorderFixture;
  recordIds: string[];
  anchorId: string;
  config: RecordReorderCaseConfig;
}) => {
  const requestMeasurement = await measureAsync("reorderRequest", async () => {
    const response = await updateRecordOrders(fixture.tableId, fixture.viewId, {
      anchorId,
      position: config.reorder.position,
      recordIds,
    });
    expect(response.status).toBe(200);
    return response;
  });

  return {
    status: requestMeasurement.result.status,
    requestMs: requestMeasurement.durationMs,
    updatedRecordCount: recordIds.length,
    responseHeaders: pickResponseHeaders(requestMeasurement.result.headers),
  };
};

const executeReorder = async (
  context: PerfRunContext,
  perfCase: PerfCase,
  fixture: ReorderFixture,
  config: RecordReorderCaseConfig,
) => {
  if (!fixture.cachedOrder) {
    throw new Error("Missing cached reorder order metadata");
  }
  return withPerfTraceStep(context, perfCase, config.threshold.metric, () =>
    moveRecords({
      fixture,
      config,
      recordIds: fixture.cachedOrder!.movedRecordIds,
      anchorId: fixture.cachedOrder!.anchorRecordId,
    }),
  );
};

const verifyReorder = async (
  fixture: ReorderFixture,
  config: RecordReorderCaseConfig,
) => {
  const verificationMeasurement = await measureAsync("verifyReorder", () =>
    assertReordered(fixture, config),
  );
  return {
    verification: verificationMeasurement.result,
    verifyReorderMs: verificationMeasurement.durationMs,
  };
};

const restoreOriginalOrder = async (
  fixture: ReorderFixture,
  config: RecordReorderCaseConfig,
) => {
  if (!fixture.cachedOrder) {
    throw new Error("Missing cached reorder order metadata");
  }

  const restored = await moveRecords({
    fixture,
    config: {
      ...config,
      reorder: {
        ...config.reorder,
        position: "after",
      },
    },
    recordIds: fixture.cachedOrder.movedRecordIds,
    anchorId: fixture.cachedOrder.restoreAnchorRecordId,
  });
  assertEngineRouting(
    { engine: process.env.PERF_LAB_ENGINE ?? "local" },
    restored.responseHeaders,
    {
      operation: "updateRecordOrders",
    },
  );
  await verifyInitialPositions(fixture, config);
};

const buildThreshold = (config: RecordReorderCaseConfig): MetricThreshold => ({
  metric: config.threshold.metric,
  max: getPrimaryThresholdMs(config.threshold.maxMs),
  unit: "ms",
});

const buildResult = ({
  config,
  windowId,
  fixture,
  prepareMeasurement,
  seedReadyMeasurement,
  reorderMeasurement,
  error,
}: {
  config: RecordReorderCaseConfig;
  windowId?: string;
  fixture?: ReorderFixture;
  prepareMeasurement?: Measurement<ReorderFixture>;
  seedReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertSeedReady>>
  >;
  reorderMeasurement?: Measurement<ReorderOperationResult>;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    ...(prepareMeasurement ? { prepareMs: prepareMeasurement.durationMs } : {}),
    ...(fixture?.seedCacheInfo
      ? {
          seedCacheHit: fixture.seedCacheHit ? 1 : 0,
          seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
          orderCacheHit: fixture.orderCacheHit ? 1 : 0,
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
    ...(reorderMeasurement
      ? {
          [config.threshold.metric]: reorderMeasurement.durationMs,
          reorderRequestMs: reorderMeasurement.durationMs,
          ...(reorderMeasurement.result.verifyReorderMs != null
            ? { verifyReorderMs: reorderMeasurement.result.verifyReorderMs }
            : {}),
        }
      : {}),
  },
  thresholds: reorderMeasurement ? [buildThreshold(config)] : [],
  phases: [
    ...(prepareMeasurement
      ? [
          {
            name: prepareMeasurement.name,
            durationMs: prepareMeasurement.durationMs,
          },
        ]
      : []),
    ...(reorderMeasurement
      ? [
          {
            name: reorderMeasurement.name,
            durationMs: reorderMeasurement.durationMs,
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
    operation: "move-last-block-to-front",
    tableId: fixture?.tableId,
    tableName: fixture?.tableName,
    viewId: fixture?.viewId,
    windowId,
    rowCount: config.rowCount,
    fieldCount: config.fields.length,
    blockStartOffset: config.reorder.blockStartOffset,
    blockSize: config.reorder.blockSize,
    anchorOffset: config.reorder.anchorOffset,
    request: fixture
      ? {
          path: `/api/table/${fixture.tableId}/record`,
          method: "PATCH",
          order: {
            viewId: fixture.viewId,
            position: config.reorder.position,
          },
          fieldsPayload: "empty-object",
        }
      : undefined,
    prepare: fixture
      ? {
          durationMs: prepareMeasurement?.durationMs,
          seedBatchDurations: fixture.seedBatchDurations,
          ready: seedReadyMeasurement?.result,
          cache: fixture.seedCacheInfo
            ? {
                enabled: fixture.seedCacheInfo.enabled,
                cacheHit: Boolean(fixture.seedCacheHit),
                orderCacheHit: Boolean(fixture.orderCacheHit),
                reusable: Boolean(fixture.reusableSeed),
                seedHash: fixture.seedCacheInfo.seedHash,
                seedHashShort: fixture.seedCacheInfo.seedHashShort,
                seedTableName: fixture.seedCacheInfo.seedTableName,
                schemaSignature: fixture.seedCacheInfo.schemaSignature,
              }
            : undefined,
        }
      : undefined,
    reorder: reorderMeasurement?.result
      ? {
          status: reorderMeasurement.result.status,
          requestMs: reorderMeasurement.result.requestMs,
          updatedRecordCount: reorderMeasurement.result.updatedRecordCount,
          responseHeaders: reorderMeasurement.result.responseHeaders,
          routing: reorderMeasurement.result.routing,
        }
      : undefined,
    routing: reorderMeasurement?.result.routing,
    verification: reorderMeasurement?.result.verification,
    fields: fixture?.fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
    })),
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
          }
        : undefined,
  },
});

// The single measured operation, run inside the driver's record window:
// trace-wrapped block reorder -> routing assertion -> post-reorder position
// verification, all bundled into one reorder measurement whose duration is the
// primary metric.
const runReorderMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: RecordReorderCaseConfig,
  fixture: ReorderFixture,
): Promise<Measurement<ReorderOperationResult>> => {
  const requestMeasurement = await measureAsync(config.threshold.metric, () =>
    executeReorder(context, perfCase, fixture, config),
  );
  let reorderMeasurement: Measurement<ReorderOperationResult> = {
    ...requestMeasurement,
    result: {
      ...requestMeasurement.result,
      requestMs: requestMeasurement.durationMs,
      routing: assertEngineRouting(
        context,
        requestMeasurement.result.responseHeaders,
        {
          operation: "updateRecordOrders",
        },
      ),
    },
  };
  const verification = await verifyReorder(fixture, config);
  reorderMeasurement = {
    ...reorderMeasurement,
    result: {
      ...reorderMeasurement.result,
      ...verification,
    },
  };
  return reorderMeasurement;
};

// The measured reorder moves the reusable seed rows, so a shared (non-isolated)
// execute DB is restored to the original order inside the same record window —
// or the table dropped if restore fails. The non-reusable case just drops the
// table. Isolated CI execute DBs are discarded after the job.
const cleanupReorderFixture = async ({
  baseId,
  fixture,
  config,
  windowId,
}: {
  baseId: string;
  fixture: ReorderFixture | undefined;
  config: RecordReorderCaseConfig;
  windowId: string;
}) => {
  if (fixture?.tableId && fixture.reusableSeed && !isExecuteDbIsolated()) {
    try {
      await withRecordWindowId(windowId, () =>
        restoreOriginalOrder(fixture, config),
      );
    } catch (error) {
      console.warn(
        `Failed to restore cached record reorder seed ${fixture.tableId}; deleting it`,
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

const recordReorderLifecycleSpec: RecordMutationLifecycleSpec<
  RecordReorderCaseConfig,
  ReorderFixture,
  Awaited<ReturnType<typeof assertSeedReady>>,
  ReorderOperationResult
> = {
  // Group the reorder write under one record window id (mirrors the legacy
  // runner; the same window scopes the restore in cleanup).
  useRecordWindow: true,
  prepareFixture: ({ baseId, tableName, config, perfCase }) =>
    prepareFixture(baseId, tableName, config, perfCase),
  assertSeedReady: ({ fixture, config }) => assertSeedReady(fixture, config),
  runMeasuredOperation: ({ perfCase, context, config, fixture }) =>
    runReorderMeasuredOperation(perfCase, context, config, fixture),
  buildResult: ({ primaryMeasurement, ...rest }) =>
    buildResult({ ...rest, reorderMeasurement: primaryMeasurement }),
  cleanup: cleanupReorderFixture,
};

export const runRecordReorderCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, recordReorderLifecycleSpec);

export const seedRecordReorderCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(perfCase, context, recordReorderLifecycleSpec);

export const recordReorderMixed10kBaseConfig = {
  baseId: "seed-base" as const,
  rowCount: 10_000,
  batchSize: 1_000,
  fields: undoRedoMixed20Fields.map((field) =>
    field.name === "External ID"
      ? {
          ...field,
          type: FieldType.SingleLineText,
        }
      : field,
  ),
  generator: {
    type: "mixed-undo-redo" as const,
    titlePrefix: "Mixed row",
    payloadPrefix: "Record reorder",
    source: "perf-lab-record-reorder",
  },
  verify: {
    sampleRows: [0, 9_000, 9_999],
    fullScanPageSize: 1_000,
  },
};
