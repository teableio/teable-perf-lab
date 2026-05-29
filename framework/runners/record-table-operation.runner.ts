import { FieldKeyType, FieldType } from "@teable/core";
import {
  clearSelectionStream,
  deleteSelection,
  duplicateSelectionStream,
  RangeType,
  updateRecords as updateRecordsApi,
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
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordTableOperationBaseCaseConfig,
} from "../types";
import { PerfRunDiagnosticError } from "../types";

type Measurement<T> = {
  name: string;
  durationMs: number;
  result: T;
};

type NamedField = {
  id: string;
  name: string;
};

type OperationField = RecordTableOperationBaseCaseConfig["fields"][number] & {
  id: string;
  name: string;
};

type SeededRecord = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
};

type OperationKind = "create" | "update" | "clear" | "delete" | "duplicate";

type OperationFixture = {
  tableId: string;
  tableName: string;
  viewId: string;
  fields: OperationField[];
  projection: string[];
  seededRecords: SeededRecord[];
  seedBatchDurations: number[];
};

type ExpectedCellValue = string | number | boolean | string[] | null;

const DEFAULT_GROUPS = ["A", "B", "C", "D", "E"];

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const fieldNameKey = (fieldName: string) => fieldName.replace(/\s+/g, "-");

const selectChoices = (
  field: RecordTableOperationBaseCaseConfig["fields"][number],
) =>
  (
    field.options as
      | {
          choices?: Array<{ name: string }>;
        }
      | undefined
  )?.choices ?? [];

const ratingMax = (
  field: RecordTableOperationBaseCaseConfig["fields"][number],
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

const getGroups = (config: RecordTableOperationBaseCaseConfig) =>
  config.generator.groups?.length ? config.generator.groups : DEFAULT_GROUPS;

const getGroupValue = (
  rowNumber: number,
  config: RecordTableOperationBaseCaseConfig,
  mode: "seed" | "updated" = "seed",
) => {
  const groups = getGroups(config);
  const offset = mode === "updated" ? rowNumber : rowNumber - 1;
  return groups[offset % groups.length];
};

const getExpectedCellValue = (
  field: RecordTableOperationBaseCaseConfig["fields"][number],
  rowNumber: number,
  config: RecordTableOperationBaseCaseConfig,
  mode: "seed" | "updated" = "seed",
): ExpectedCellValue => {
  const padded = padRowNumber(rowNumber);
  const group = getGroupValue(rowNumber, config, mode);
  const payloadPrefix =
    mode === "updated"
      ? (config.generator.updatePayloadPrefix ?? "updated")
      : config.generator.payloadPrefix;

  if (field.name === "Name" || field.name === "Title") {
    return mode === "updated"
      ? `${config.generator.titlePrefix} updated ${padded}`
      : `${config.generator.titlePrefix} ${padded}`;
  }
  if (field.name === "Index") {
    return mode === "updated" ? rowNumber + 100_000 : rowNumber;
  }
  if (field.name === "Group") {
    return group;
  }
  if (field.name === "Payload") {
    return `${payloadPrefix}-${padded}-${group}`;
  }

  switch (field.type) {
    case FieldType.Number:
      return mode === "updated" ? rowNumber + 100_000 : rowNumber;
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
      return `${payloadPrefix}-${padded}-${fieldNameKey(field.name)}`;
    case FieldType.SingleLineText:
      return mode === "updated"
        ? `${config.generator.titlePrefix} updated ${padded}-${fieldNameKey(
            field.name,
          )}`
        : `${config.generator.titlePrefix} ${padded}-${fieldNameKey(
            field.name,
          )}`;
    default:
      return `${payloadPrefix}-${padded}-${fieldNameKey(field.name)}`;
  }
};

const buildRecordFields = (
  config: RecordTableOperationBaseCaseConfig,
  rowNumber: number,
  mode: "seed" | "updated" = "seed",
) =>
  Object.fromEntries(
    config.fields.map((field) => [
      field.name,
      getExpectedCellValue(field, rowNumber, config, mode),
    ]),
  );

const normalizeMultiSelectValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
};

const resolveOperationFields = (
  fields: NamedField[],
  config: RecordTableOperationBaseCaseConfig,
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
    return (
      JSON.stringify(normalizeMultiSelectValue(actualValue)) ===
      JSON.stringify(expectedValue)
    );
  }
  if (typeof expectedValue === "number") {
    return Number(actualValue) === expectedValue;
  }
  if (typeof expectedValue === "boolean") {
    return actualValue === expectedValue;
  }
  return actualValue === expectedValue;
};

const getOperationKind = (runner: PerfCase["runner"]): OperationKind => {
  switch (runner) {
    case "record-create":
      return "create";
    case "record-update":
      return "update";
    case "selection-clear":
      return "clear";
    case "selection-duplicate":
      return "duplicate";
    case "record-delete":
      return "delete";
    default:
      throw new Error(`Unsupported table operation runner: ${runner}`);
  }
};

const buildAllRowsRange = (fixture: OperationFixture) => ({
  viewId: fixture.viewId,
  type: RangeType.Rows,
  ranges: [[0, fixture.seededRecords.length - 1] as [number, number]],
  projection: fixture.projection,
});

const buildAllCellsRange = (fixture: OperationFixture) => ({
  viewId: fixture.viewId,
  ranges: [
    [0, 0],
    [fixture.projection.length - 1, fixture.seededRecords.length - 1],
  ] as [[number, number], [number, number]],
  projection: fixture.projection,
});

const getStreamHeaders = (context: PerfRunContext) =>
  context.cookie ? { Cookie: context.cookie } : undefined;

const seedRecords = async (
  fixture: Omit<OperationFixture, "seededRecords" | "seedBatchDurations">,
  config: RecordTableOperationBaseCaseConfig,
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

const prepareOperationFixture = async (
  baseId: string,
  tableName: string,
  config: RecordTableOperationBaseCaseConfig,
  operationKind: OperationKind,
): Promise<OperationFixture> => {
  const table = await createTable(baseId, {
    name: tableName,
    fields: config.fields,
    records: [],
  });
  const tableFields = await getFields(table.id);
  const views = await getViews(table.id);
  const viewId = views[0]?.id;

  if (!viewId) {
    throw new Error(`No grid view found for table operation table ${table.id}`);
  }

  const fields = resolveOperationFields(tableFields, config);
  const baseFixture = {
    tableId: table.id,
    tableName,
    viewId,
    fields,
    projection: fields.map((field) => field.id),
  };

  if (operationKind === "create") {
    return {
      ...baseFixture,
      seededRecords: [],
      seedBatchDurations: [],
    };
  }

  const seeded = await seedRecords(baseFixture, config);
  return {
    ...baseFixture,
    seededRecords: seeded.seededRecords,
    seedBatchDurations: seeded.batchDurations,
  };
};

const createRecordsInBatches = async (
  fixture: OperationFixture,
  config: RecordTableOperationBaseCaseConfig,
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
  const createdRecords: SeededRecord[] = [];

  for (const batch of batches) {
    const result = await createRecords(fixture.tableId, {
      fieldKeyType: FieldKeyType.Name,
      typecast: true,
      records: batch.map((item) => item.record),
    });
    expect(result.records).toHaveLength(batch.length);
    result.records.forEach((record, index) => {
      const input = batch[index];
      if (!input) {
        return;
      }
      createdRecords.push({
        rowOffset: input.rowOffset,
        rowNumber: input.rowNumber,
        recordId: record.id,
      });
    });
  }

  fixture.seededRecords = createdRecords;
  return { createdCount: createdRecords.length };
};

const updateRecordsInBatches = async (
  fixture: OperationFixture,
  config: RecordTableOperationBaseCaseConfig,
) => {
  const batches = chunk(fixture.seededRecords, config.batchSize);
  let updatedCount = 0;

  for (const batch of batches) {
    const response = await updateRecordsApi(fixture.tableId, {
      fieldKeyType: FieldKeyType.Name,
      typecast: false,
      records: batch.map((item) => ({
        id: item.recordId,
        fields: buildRecordFields(config, item.rowNumber, "updated"),
      })),
    });
    expect(response.status).toBe(200);
    expect(response.data).toHaveLength(batch.length);
    updatedCount += response.data.length;
  }

  return { updatedCount };
};

const deleteAllRows = async (fixture: OperationFixture) => {
  const response = await deleteSelection(
    fixture.tableId,
    buildAllRowsRange(fixture),
  );
  expect(response.status).toBe(200);
  expect(response.data.ids).toHaveLength(fixture.seededRecords.length);
  return response.data;
};

const clearAllRows = async (
  fixture: OperationFixture,
  context: PerfRunContext,
) => {
  let progressEventCount = 0;
  const result = await clearSelectionStream(
    fixture.tableId,
    buildAllCellsRange(fixture),
    {
      headers: getStreamHeaders(context),
      onProgress: () => {
        progressEventCount += 1;
      },
    },
  );
  expect(result.errors).toHaveLength(0);
  expect(result.done.totalCount).toBe(fixture.seededRecords.length);
  expect(result.done.processedCount).toBe(fixture.seededRecords.length);
  expect(result.done.clearedCount).toBe(fixture.seededRecords.length);
  return {
    totalCount: result.done.totalCount,
    processedCount: result.done.processedCount,
    clearedCount: result.done.clearedCount,
    progressEventCount,
  };
};

const duplicateAllRows = async (
  fixture: OperationFixture,
  context: PerfRunContext,
) => {
  const result = await duplicateSelectionStream(
    fixture.tableId,
    buildAllRowsRange(fixture),
    {
      headers: getStreamHeaders(context),
    },
  );
  expect(result.errors).toHaveLength(0);
  expect(result.done.duplicatedCount).toBe(fixture.seededRecords.length);
  return result;
};

const executeOperation = async (
  operationKind: OperationKind,
  fixture: OperationFixture,
  config: RecordTableOperationBaseCaseConfig,
  context: PerfRunContext,
) => {
  switch (operationKind) {
    case "create":
      return createRecordsInBatches(fixture, config);
    case "update":
      return updateRecordsInBatches(fixture, config);
    case "clear":
      return clearAllRows(fixture, context);
    case "delete":
      return deleteAllRows(fixture);
    case "duplicate":
      return duplicateAllRows(fixture, context);
  }
};

const assertRowsMatch = async (
  fixture: OperationFixture,
  config: RecordTableOperationBaseCaseConfig,
  mode: "seed" | "updated" | "cleared",
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleRowOffsets = new Set(config.verify.sampleRows);
  const verifiedSamples = [];
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

      for (const field of fixture.fields) {
        const actualValue = record.fields[field.id];
        const expectedValue =
          mode === "cleared"
            ? null
            : getExpectedCellValue(field, rowNumber, config, mode);
        actual[field.name] = actualValue;
        expected[field.name] = expectedValue;

        if (
          mode === "cleared"
            ? actualValue != null
            : !valuesMatch(expectedValue, actualValue)
        ) {
          throw new Error(
            `Row ${rowNumber} ${field.name} mismatch after ${mode}: expected ${String(
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

const assertDeleted = async (fixture: OperationFixture) => {
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

const assertDuplicatedRows = async (
  fixture: OperationFixture,
  config: RecordTableOperationBaseCaseConfig,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const indexField = fixture.fields.find((field) => field.name === "Index");
  if (!indexField) {
    throw new Error("Duplicate verification requires an Index field");
  }

  const expectedTotal = config.rowCount * 2;
  const countsByIndex = new Map<number, number>();
  let scannedRecords = 0;
  let pageCount = 0;

  for (let skip = 0; skip < expectedTotal; skip += pageSize) {
    const expectedTake = Math.min(pageSize, expectedTotal - skip);
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
        `Expected ${expectedTake} duplicated records at skip ${skip}, got ${result.records.length}`,
      );
    }

    for (const record of result.records) {
      const rowNumber = Number(record.fields[indexField.id]);
      countsByIndex.set(rowNumber, (countsByIndex.get(rowNumber) ?? 0) + 1);
      scannedRecords += 1;
    }
  }

  const verifiedSamples = config.verify.sampleRows.map((rowOffset) => {
    const rowNumber = rowOffset + 1;
    const count = countsByIndex.get(rowNumber) ?? 0;
    if (count !== 2) {
      throw new Error(
        `Expected duplicated row ${rowNumber} to appear twice, got ${count}`,
      );
    }
    return { rowOffset, rowNumber, duplicateCount: count };
  });

  for (let rowNumber = 1; rowNumber <= config.rowCount; rowNumber += 1) {
    const count = countsByIndex.get(rowNumber) ?? 0;
    if (count !== 2) {
      throw new Error(
        `Expected row ${rowNumber} to appear twice after duplicate, got ${count}`,
      );
    }
  }

  return {
    scannedRecords,
    pageSize,
    pageCount,
    verifiedSamples,
  };
};

const verifyOperation = async (
  operationKind: OperationKind,
  fixture: OperationFixture,
  config: RecordTableOperationBaseCaseConfig,
) => {
  switch (operationKind) {
    case "create":
      return assertRowsMatch(fixture, config, "seed");
    case "update":
      return assertRowsMatch(fixture, config, "updated");
    case "clear":
      return assertRowsMatch(fixture, config, "cleared");
    case "delete":
      return assertDeleted(fixture);
    case "duplicate":
      return assertDuplicatedRows(fixture, config);
  }
};

const buildRecordTableOperationResult = ({
  config,
  operationKind,
  fixture,
  prepareMeasurement,
  operationMeasurement,
  verifyMeasurement,
  error,
}: {
  config: RecordTableOperationBaseCaseConfig & {
    threshold: { metric: string; maxMs: number };
  };
  operationKind: OperationKind;
  fixture?: OperationFixture;
  prepareMeasurement?: Measurement<OperationFixture>;
  operationMeasurement?: Measurement<unknown>;
  verifyMeasurement?: Measurement<Awaited<ReturnType<typeof verifyOperation>>>;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    ...(prepareMeasurement ? { prepareMs: prepareMeasurement.durationMs } : {}),
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
    operation: operationKind,
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
});

export const runRecordTableOperationCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as RecordTableOperationBaseCaseConfig & {
    threshold: { metric: string; maxMs: number };
  };
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const operationKind = getOperationKind(perfCase.runner);
  let prepareMeasurement: Measurement<OperationFixture> | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareOperationFixture(baseId, tableName, config, operationKind),
    );
    const fixture = prepareMeasurement.result;
    let operationMeasurement: Measurement<unknown> | undefined;
    let verifyMeasurement:
      | Measurement<Awaited<ReturnType<typeof verifyOperation>>>
      | undefined;

    try {
      operationMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        operationKind,
        () =>
          measureAsync(operationKind, () =>
            executeOperation(operationKind, fixture, config, context),
          ),
      );

      verifyMeasurement = await measureAsync("verify", () =>
        verifyOperation(operationKind, fixture, config),
      );
    } catch (error) {
      const diagnosticResult = buildRecordTableOperationResult({
        config,
        operationKind,
        fixture,
        prepareMeasurement,
        operationMeasurement,
        verifyMeasurement,
        error,
      });

      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        diagnosticResult,
      );
    }

    return buildRecordTableOperationResult({
      config,
      operationKind,
      fixture,
      prepareMeasurement,
      operationMeasurement,
      verifyMeasurement,
    });
  } finally {
    if (prepareMeasurement?.result.tableId) {
      try {
        await permanentDeleteTable(baseId, prepareMeasurement.result.tableId);
      } catch (error) {
        console.warn(
          `Failed to cleanup perf table ${prepareMeasurement.result.tableId}`,
          error,
        );
      }
    }
  }
};
