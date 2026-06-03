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
import { measureAsync } from "../metrics";
import {
  buildSeedCacheInfo,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { withPerfTraceStep } from "../trace-collector";
import { PerfRunDiagnosticError } from "../types";
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
  buildRecordWindowId,
  undoRedoMixed20Fields,
  withRecordWindowId,
} from "./record-undo-redo.shared";

type Measurement<T> = {
  name: string;
  durationMs: number;
  result: T;
};

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
  verification: ReorderVerification;
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

const normalizeValue = (value: unknown) => {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.includes("T")
      ? new Date(value).toISOString().slice(0, 10)
      : value.slice(0, 10);
  }
  return value;
};

const valuesMatch = (expected: unknown, actual: unknown) =>
  JSON.stringify(normalizeValue(actual)) ===
  JSON.stringify(normalizeValue(expected));

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

const getResponseHeader = (headers: Record<string, unknown>, name: string) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0]) : String(value ?? "");
};

const pickResponseHeaders = (headers: Record<string, unknown>) => ({
  "x-teable-v2": getResponseHeader(headers, "x-teable-v2"),
  "x-teable-v2-feature": getResponseHeader(headers, "x-teable-v2-feature"),
  "x-teable-v2-reason": getResponseHeader(headers, "x-teable-v2-reason"),
  traceparent: getResponseHeader(headers, "traceparent"),
});

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

      if (!valuesMatch(expectedValue, actualValue)) {
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
  fixture: ReorderFixture,
  config: RecordReorderCaseConfig,
): Promise<ReorderOperationResult> => {
  if (!fixture.cachedOrder) {
    throw new Error("Missing cached reorder order metadata");
  }
  const operation = await moveRecords({
    fixture,
    config,
    recordIds: fixture.cachedOrder.movedRecordIds,
    anchorId: fixture.cachedOrder.anchorRecordId,
  });
  const verification = await assertReordered(fixture, config);

  return {
    ...operation,
    verification,
  };
};

const restoreOriginalOrder = async (
  fixture: ReorderFixture,
  config: RecordReorderCaseConfig,
) => {
  if (!fixture.cachedOrder) {
    throw new Error("Missing cached reorder order metadata");
  }

  await moveRecords({
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
          reorderRequestMs: reorderMeasurement.result.requestMs,
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
        }
      : undefined,
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

export const runRecordReorderCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as RecordReorderCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const windowId = buildRecordWindowId(context, perfCase);
  let prepareMeasurement: Measurement<ReorderFixture> | undefined;
  let seedReadyMeasurement:
    | Measurement<Awaited<ReturnType<typeof assertSeedReady>>>
    | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareFixture(baseId, tableName, config, perfCase),
    );
    const fixture = prepareMeasurement.result;
    seedReadyMeasurement = await measureAsync("seedReady", () =>
      assertSeedReady(fixture, config),
    );
    let reorderMeasurement: Measurement<ReorderOperationResult> | undefined;

    try {
      await withRecordWindowId(windowId, async () => {
        reorderMeasurement = await withPerfTraceStep(
          context,
          perfCase,
          config.threshold.metric,
          () =>
            measureAsync(config.threshold.metric, () =>
              executeReorder(fixture, config),
            ),
        );
      });
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildResult({
          config,
          windowId,
          fixture,
          prepareMeasurement,
          seedReadyMeasurement,
          reorderMeasurement,
          error,
        }),
      );
    }

    return buildResult({
      config,
      windowId,
      fixture,
      prepareMeasurement,
      seedReadyMeasurement,
      reorderMeasurement,
    });
  } finally {
    const fixture = prepareMeasurement?.result;
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
    } else if (fixture?.tableId && !fixture.reusableSeed) {
      try {
        await permanentDeleteTable(baseId, fixture.tableId);
      } catch (error) {
        console.warn(`Failed to cleanup perf table ${fixture.tableId}`, error);
      }
    }
  }
};

export const seedRecordReorderCase = async (
  perfCase: PerfCase,
  _context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as RecordReorderCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const prepareMeasurement = await measureAsync("prepare", () =>
    prepareFixture(baseId, tableName, config, perfCase),
  );
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    assertSeedReady(prepareMeasurement.result, config),
  );

  return buildResult({
    config,
    windowId: `seed-${_context.runId}-${perfCase.id}`,
    fixture: prepareMeasurement.result,
    prepareMeasurement,
    seedReadyMeasurement,
  });
};

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
