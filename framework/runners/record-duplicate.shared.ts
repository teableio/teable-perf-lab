import { FieldKeyType, FieldType } from "@teable/core";
import { chunk } from "../chunk";
import {
  deleteRecords,
  createRecords,
  createTable,
  getFields,
  getRecords,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { measureAsync, type Measurement } from "../metrics";
import { forEachRecordPage } from "../record-page-scan";
import {
  buildSeedCacheInfo,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import type {
  DuplicateRecordSeedBaseCaseConfig,
  PerfCase,
  PerfRunnerKind,
} from "../types";

type NamedField = {
  id: string;
  name: string;
};

export type DuplicateSeedField =
  DuplicateRecordSeedBaseCaseConfig["fields"][number] & {
    id: string;
    name: string;
  };

export type DuplicateRecordFixture = {
  tableId: string;
  tableName: string;
  viewId: string;
  fields: DuplicateSeedField[];
  projection: string[];
  seedBatchDurations: number[];
  seedCacheInfo?: SeedCacheInfo;
  seedCacheHit?: boolean;
  reusableSeed?: boolean;
};

export type ExpectedCellValue = string | number | boolean | string[] | null;

export type SourceReadyVerification = {
  scannedRecords: number;
  pageSize: number;
  pageCount: number;
  verifiedSamples: Array<{
    rowOffset: number;
    rowNumber: number;
    recordId: string;
    actual: Record<string, unknown>;
    expected: Record<string, unknown>;
  }>;
};

export type DuplicateValueVerification = {
  scannedRecords: number;
  pageSize: number;
  pageCount: number;
  checkedRecords: number;
  verifiedSamples: Array<{
    duplicateOffset: number;
    sourceRowOffset: number;
    sourceRowNumber: number;
    recordId: string;
    actual: Record<string, unknown>;
    expected: Record<string, unknown>;
  }>;
};

export type RowCountVerification = {
  scannedRecords: number;
  expectedRecords: number;
  pageSize: number;
  pageCount: number;
};

const DEFAULT_GROUPS = ["A", "B", "C", "D", "E"];
const RECORD_ID_QUERY_BATCH_SIZE = 100;
const DELETE_RECORD_BATCH_SIZE = 100;

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const fieldNameKey = (fieldName: string) => fieldName.replace(/\s+/g, "-");

const selectChoices = (
  field: DuplicateRecordSeedBaseCaseConfig["fields"][number],
) =>
  (
    field.options as
      | {
          choices?: Array<{ name: string }>;
        }
      | undefined
  )?.choices ?? [];

const ratingMax = (
  field: DuplicateRecordSeedBaseCaseConfig["fields"][number],
) =>
  (
    field.options as
      | {
          max?: number;
        }
      | undefined
  )?.max ?? 5;

const dateOnlyForRow = (rowNumber: number, offsetDays = 0) => {
  const date = new Date(
    Date.UTC(2026, 0, 1 + offsetDays + ((rowNumber - 1) % 365)),
  );
  return date.toISOString().slice(0, 10);
};

const dateIsoForRow = (rowNumber: number, offsetDays = 0) =>
  `${dateOnlyForRow(rowNumber, offsetDays)}T00:00:00.000Z`;

const getGroups = (config: DuplicateRecordSeedBaseCaseConfig) =>
  config.generator.groups?.length ? config.generator.groups : DEFAULT_GROUPS;

const getGroupValue = (
  rowNumber: number,
  config: DuplicateRecordSeedBaseCaseConfig,
) => {
  const groups = getGroups(config);
  return groups[(rowNumber - 1) % groups.length];
};

export const getDuplicateExpectedCellValue = (
  field: DuplicateRecordSeedBaseCaseConfig["fields"][number],
  rowNumber: number,
  config: DuplicateRecordSeedBaseCaseConfig,
): ExpectedCellValue => {
  const padded = padRowNumber(rowNumber);
  const group = getGroupValue(rowNumber, config);

  if (field.name === "Name" || field.name === "Title") {
    return `${config.generator.titlePrefix} ${padded}`;
  }
  if (field.name === "Index") {
    return rowNumber;
  }
  if (field.name === "Group") {
    return group;
  }
  if (field.name === "Payload") {
    return `${config.generator.payloadPrefix}-${padded}-${group}`;
  }

  switch (field.type) {
    case FieldType.Number:
      return rowNumber;
    case FieldType.SingleSelect: {
      const choices = selectChoices(field);
      return choices.length
        ? choices[(rowNumber - 1) % choices.length].name
        : group;
    }
    case FieldType.MultipleSelect: {
      const choices = selectChoices(field);
      if (choices.length === 0) {
        return [];
      }
      const first = choices[(rowNumber - 1) % choices.length].name;
      const second = choices[rowNumber % choices.length].name;
      return first === second ? [first] : [first, second];
    }
    case FieldType.Date:
      return dateIsoForRow(
        rowNumber,
        field.name.toLowerCase().includes("due") ? 7 : 0,
      );
    case FieldType.Checkbox:
      return rowNumber % 2 === 1 ? true : null;
    case FieldType.Rating:
      return ((rowNumber - 1) % ratingMax(field)) + 1;
    case FieldType.LongText:
      return `${config.generator.payloadPrefix}-${padded}-${fieldNameKey(
        field.name,
      )}`;
    case FieldType.SingleLineText:
      return `${config.generator.titlePrefix} ${padded}-${fieldNameKey(
        field.name,
      )}`;
    default:
      return `${config.generator.payloadPrefix}-${padded}-${fieldNameKey(
        field.name,
      )}`;
  }
};

export const valuesMatch = (
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

const buildRecordFields = (
  config: DuplicateRecordSeedBaseCaseConfig,
  rowNumber: number,
) =>
  Object.fromEntries(
    config.fields.map((field) => [
      field.name,
      getDuplicateExpectedCellValue(field, rowNumber, config),
    ]),
  );

const resolveDuplicateFields = (
  fields: NamedField[],
  config: DuplicateRecordSeedBaseCaseConfig,
): DuplicateSeedField[] => {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  return config.fields.map((field) => {
    const resolvedField = fieldByName.get(field.name);
    if (!resolvedField) {
      throw new Error(
        `Missing duplicate record field ${field.name}; available fields: ${fields
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

const buildBaseFixture = async (
  tableId: string,
  tableName: string,
  config: DuplicateRecordSeedBaseCaseConfig,
): Promise<Omit<DuplicateRecordFixture, "seedBatchDurations">> => {
  const tableFields = await getFields(tableId);
  const views = await getViews(tableId);
  const viewId = views[0]?.id;

  if (!viewId) {
    throw new Error(`No grid view found for duplicate record table ${tableId}`);
  }

  const fields = resolveDuplicateFields(tableFields, config);
  return {
    tableId,
    tableName,
    viewId,
    fields,
    projection: fields.map((field) => field.id),
  };
};

const seedRecords = async (
  fixture: Omit<DuplicateRecordFixture, "seedBatchDurations">,
  config: DuplicateRecordSeedBaseCaseConfig,
) => {
  const records = Array.from({ length: config.rowCount }, (_, index) => {
    const rowNumber = index + 1;
    return {
      fields: buildRecordFields(config, rowNumber),
    };
  });
  const batches = chunk(records, config.batchSize);
  const batchDurations: number[] = [];

  for (const [batchIndex, batch] of batches.entries()) {
    const batchMeasurement = await measureAsync(
      `seedBatch:${batchIndex + 1}`,
      () =>
        createRecords(fixture.tableId, {
          fieldKeyType: FieldKeyType.Name,
          typecast: true,
          records: batch,
        }),
    );
    batchDurations.push(batchMeasurement.durationMs);
    expect(batchMeasurement.result.records).toHaveLength(batch.length);
  }

  return batchDurations;
};

const getDuplicateSourceSeedConfig = (
  config: DuplicateRecordSeedBaseCaseConfig,
  fixtureVersion: string,
) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  fields: config.fields,
  generator: config.generator,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion,
});

export const prepareDuplicateSourceFixture = async ({
  baseId,
  tableName,
  config,
  perfCase,
  runner,
  fixtureVersion,
}: {
  baseId: string;
  tableName: string;
  config: DuplicateRecordSeedBaseCaseConfig;
  perfCase: PerfCase;
  runner: Extract<
    PerfRunnerKind,
    "selection-duplicate" | "record-duplicate-single"
  >;
  fixtureVersion: string;
}): Promise<DuplicateRecordFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner,
    fixtureVersion,
    seedConfig: getDuplicateSourceSeedConfig(config, fixtureVersion),
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
      const cachedFixture: DuplicateRecordFixture = {
        ...(await buildBaseFixture(cachedTable.id, cachedTable.name, config)),
        seedBatchDurations: [0],
        seedCacheInfo,
        seedCacheHit: true,
        reusableSeed: true,
      };
      await assertDuplicateSourceReady(cachedFixture, config);
      return cachedFixture;
    } catch (error) {
      console.warn(
        `Invalid cached duplicate record seed ${seedCacheInfo.seedTableName}; rebuilding`,
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
    const baseFixture = await buildBaseFixture(
      table.id,
      actualTableName,
      config,
    );
    const seedBatchDurations = await seedRecords(baseFixture, config);

    return {
      ...baseFixture,
      seedBatchDurations,
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
          `Failed to cleanup incomplete duplicate record seed ${createdTableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const assertRecordValues = ({
  fixture,
  config,
  record,
  rowNumber,
  context,
}: {
  fixture: DuplicateRecordFixture;
  config: DuplicateRecordSeedBaseCaseConfig;
  record: { id: string; fields: Record<string, unknown> };
  rowNumber: number;
  context: string;
}) => {
  const actual: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};

  for (const field of fixture.fields) {
    const expectedValue = getDuplicateExpectedCellValue(
      field,
      rowNumber,
      config,
    );
    const actualValue = record.fields[field.id];
    actual[field.name] = actualValue;
    expected[field.name] = expectedValue;

    if (!valuesMatch(expectedValue, actualValue)) {
      throw new Error(
        `${context} row ${rowNumber} ${field.name} mismatch: expected ${String(
          expectedValue,
        )}, actual ${String(actualValue)}`,
      );
    }
  }

  return { actual, expected };
};

export const assertDuplicateSourceReady = async (
  fixture: DuplicateRecordFixture,
  config: DuplicateRecordSeedBaseCaseConfig,
): Promise<SourceReadyVerification> => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleRowOffsets = new Set(config.verify.sampleRows);
  const verifiedSamples: SourceReadyVerification["verifiedSamples"] = [];

  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.rowCount,
      pageSize,
      pageNoun: "duplicate source records",
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          viewId: fixture.viewId,
          fieldKeyType: FieldKeyType.Id,
          projection: fixture.projection,
          skip,
          take,
        }),
    },
    (record, rowNumber) => {
      const compared = assertRecordValues({
        fixture,
        config,
        record,
        rowNumber,
        context: "Duplicate source",
      });

      const rowOffset = rowNumber - 1;
      if (sampleRowOffsets.has(rowOffset)) {
        verifiedSamples.push({
          rowOffset,
          rowNumber,
          recordId: record.id,
          ...compared,
        });
      }
    },
  );

  const beyondLastPage = await getRecords(fixture.tableId, {
    viewId: fixture.viewId,
    fieldKeyType: FieldKeyType.Id,
    projection: fixture.projection,
    skip: config.rowCount,
    take: 1,
  });
  if (beyondLastPage.records.length !== 0) {
    throw new Error(
      `Duplicate source has extra rows after expected rowCount=${config.rowCount}`,
    );
  }

  return {
    scannedRecords,
    pageSize,
    pageCount,
    verifiedSamples,
  };
};

export const assertRecordCount = async (
  fixture: DuplicateRecordFixture,
  expectedRecords: number,
  pageSize: number,
): Promise<RowCountVerification> => {
  let scannedRecords = 0;
  let pageCount = 0;

  for (let skip = 0; skip < expectedRecords; skip += pageSize) {
    const expectedTake = Math.min(pageSize, expectedRecords - skip);
    const result = await getRecords(fixture.tableId, {
      viewId: fixture.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: fixture.projection.slice(0, 1),
      skip,
      take: expectedTake,
    });
    pageCount += 1;

    if (result.records.length !== expectedTake) {
      throw new Error(
        `Expected ${expectedTake} records at skip ${skip}, got ${result.records.length}`,
      );
    }
    scannedRecords += result.records.length;
  }

  const beyondLastPage = await getRecords(fixture.tableId, {
    viewId: fixture.viewId,
    fieldKeyType: FieldKeyType.Id,
    projection: fixture.projection.slice(0, 1),
    skip: expectedRecords,
    take: 1,
  });
  if (beyondLastPage.records.length !== 0) {
    throw new Error(
      `Expected ${expectedRecords} records, but found additional rows after the expected count`,
    );
  }

  return {
    scannedRecords,
    expectedRecords,
    pageSize,
    pageCount,
  };
};

export const getSourceRecords = async (
  fixture: DuplicateRecordFixture,
  sourceRowCount: number,
) => {
  const result = await getRecords(fixture.tableId, {
    viewId: fixture.viewId,
    fieldKeyType: FieldKeyType.Id,
    projection: fixture.projection,
    skip: 0,
    take: sourceRowCount,
  });

  if (result.records.length !== sourceRowCount) {
    throw new Error(
      `Expected ${sourceRowCount} source records for single duplicate, got ${result.records.length}`,
    );
  }

  return result.records.map((record, index) => ({
    rowOffset: index,
    rowNumber: index + 1,
    recordId: record.id,
    record,
  }));
};

const getRecordsByIds = async (
  fixture: DuplicateRecordFixture,
  recordIds: string[],
  pageSize: number,
) => {
  const recordsById = new Map<
    string,
    { id: string; fields: Record<string, unknown> }
  >();
  let pageCount = 0;

  const batchSize = Math.min(pageSize, RECORD_ID_QUERY_BATCH_SIZE);
  for (const recordIdBatch of chunk(recordIds, batchSize)) {
    const result = await getRecords(fixture.tableId, {
      viewId: fixture.viewId,
      fieldKeyType: FieldKeyType.Id,
      ignoreViewQuery: true,
      selectedRecordIds: recordIdBatch,
      projection: fixture.projection,
      take: recordIdBatch.length,
    });
    pageCount += 1;

    for (const record of result.records) {
      recordsById.set(record.id, record);
    }
  }

  return { recordsById, pageCount };
};

export const assertDuplicatedRecordsMatchSource = async ({
  fixture,
  config,
  duplicatedRecordIds,
  sourceStartRowOffset,
  sampleDuplicateOffsets,
}: {
  fixture: DuplicateRecordFixture;
  config: DuplicateRecordSeedBaseCaseConfig;
  duplicatedRecordIds: string[];
  sourceStartRowOffset: number;
  sampleDuplicateOffsets: number[];
}): Promise<DuplicateValueVerification> => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const { recordsById, pageCount } = await getRecordsByIds(
    fixture,
    duplicatedRecordIds,
    pageSize,
  );
  const sampleOffsets = new Set(sampleDuplicateOffsets);
  const verifiedSamples: DuplicateValueVerification["verifiedSamples"] = [];

  if (recordsById.size !== duplicatedRecordIds.length) {
    throw new Error(
      `Expected to fetch ${duplicatedRecordIds.length} duplicated records by id, got ${recordsById.size}`,
    );
  }

  for (const [duplicateOffset, recordId] of duplicatedRecordIds.entries()) {
    const record = recordsById.get(recordId);
    if (!record) {
      throw new Error(`Missing duplicated record ${recordId}`);
    }

    const sourceRowOffset = sourceStartRowOffset + duplicateOffset;
    const sourceRowNumber = sourceRowOffset + 1;
    const compared = assertRecordValues({
      fixture,
      config,
      record,
      rowNumber: sourceRowNumber,
      context: "Duplicated record",
    });

    if (sampleOffsets.has(duplicateOffset)) {
      verifiedSamples.push({
        duplicateOffset,
        sourceRowOffset,
        sourceRowNumber,
        recordId,
        ...compared,
      });
    }
  }

  return {
    scannedRecords: duplicatedRecordIds.length,
    pageSize: Math.min(pageSize, RECORD_ID_QUERY_BATCH_SIZE),
    pageCount,
    checkedRecords: duplicatedRecordIds.length,
    verifiedSamples,
  };
};

export const deleteRecordsInBatches = async (
  tableId: string,
  recordIds: string[],
) => {
  for (const recordIdBatch of chunk(recordIds, DELETE_RECORD_BATCH_SIZE)) {
    await deleteRecords(tableId, recordIdBatch);
  }
};

export const assertDuplicateResponseMatchesSource = ({
  fixture,
  config,
  record,
  sourceRowNumber,
  context,
}: {
  fixture: DuplicateRecordFixture;
  config: DuplicateRecordSeedBaseCaseConfig;
  record: { id: string; fields: Record<string, unknown> };
  sourceRowNumber: number;
  context: string;
}) =>
  assertRecordValues({
    fixture,
    config,
    record,
    rowNumber: sourceRowNumber,
    context,
  });
