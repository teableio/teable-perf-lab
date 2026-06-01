import { FieldKeyType, FieldType } from "@teable/core";
import { clearSelectionStream, updateRecords } from "@teable/openapi";
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
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  SelectionClearCaseConfig,
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

type ClearField = SelectionClearCaseConfig["fields"][number] & {
  id: string;
  name: string;
};

type SeededRecord = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
};

type ClearFixture = {
  tableId: string;
  tableName: string;
  viewId: string;
  fields: ClearField[];
  projection: string[];
  seededRecords: SeededRecord[];
  seedBatchDurations: number[];
  seedCacheInfo?: SeedCacheInfo;
  seedCacheHit?: boolean;
  reusableSeed?: boolean;
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

const buildSyntheticSeededRecords = (rowCount: number): SeededRecord[] =>
  Array.from({ length: rowCount }, (_, index) => ({
    rowOffset: index,
    rowNumber: index + 1,
    recordId: "",
  }));

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const fieldNameKey = (fieldName: string) => fieldName.replace(/\s+/g, "-");

const selectChoices = (field: SelectionClearCaseConfig["fields"][number]) =>
  (
    field.options as
      | {
          choices?: Array<{ name: string }>;
        }
      | undefined
  )?.choices ?? [];

const ratingMax = (field: SelectionClearCaseConfig["fields"][number]) =>
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

const getGroups = (config: SelectionClearCaseConfig) =>
  config.generator.groups?.length ? config.generator.groups : DEFAULT_GROUPS;

const getGroupValue = (rowNumber: number, config: SelectionClearCaseConfig) => {
  const groups = getGroups(config);
  return groups[(rowNumber - 1) % groups.length];
};

const getExpectedCellValue = (
  field: SelectionClearCaseConfig["fields"][number],
  rowNumber: number,
  config: SelectionClearCaseConfig,
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

const buildRecordFields = (
  config: SelectionClearCaseConfig,
  rowNumber: number,
) =>
  Object.fromEntries(
    config.fields.map((field) => [
      field.name,
      getExpectedCellValue(field, rowNumber, config),
    ]),
  );

const resolveClearFields = (
  fields: NamedField[],
  config: SelectionClearCaseConfig,
): ClearField[] => {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  return config.fields.map((field) => {
    const resolvedField = fieldByName.get(field.name);
    if (!resolvedField) {
      throw new Error(
        `Missing clear field ${field.name}; available fields: ${fields
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

const getStreamHeaders = (context: PerfRunContext) =>
  context.cookie ? { Cookie: context.cookie } : undefined;

const seedRecords = async (
  fixture: Omit<ClearFixture, "seededRecords" | "seedBatchDurations">,
  config: SelectionClearCaseConfig,
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

const getSelectionClearSeedConfig = (config: SelectionClearCaseConfig) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  fields: config.fields,
  generator: config.generator,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: "selection-clear-v1",
});

const buildBaseFixture = async (
  tableId: string,
  tableName: string,
  config: SelectionClearCaseConfig,
): Promise<Omit<ClearFixture, "seededRecords" | "seedBatchDurations">> => {
  const tableFields = await getFields(tableId);
  const views = await getViews(tableId);
  const viewId = views[0]?.id;

  if (!viewId) {
    throw new Error(`No grid view found for selection clear table ${tableId}`);
  }

  const fields = resolveClearFields(tableFields, config);
  return {
    tableId,
    tableName,
    viewId,
    fields,
    projection: fields.map((field) => field.id),
  };
};

const prepareClearFixture = async (
  baseId: string,
  tableName: string,
  config: SelectionClearCaseConfig,
  perfCase: PerfCase,
): Promise<ClearFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "selection-clear",
    fixtureVersion: "selection-clear-v1",
    seedConfig: getSelectionClearSeedConfig(config),
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
      const cachedFixture: ClearFixture = {
        ...(await buildBaseFixture(cachedTable.id, cachedTable.name, config)),
        seededRecords: buildSyntheticSeededRecords(config.rowCount),
        seedBatchDurations: [0],
        seedCacheInfo,
        seedCacheHit: true,
        reusableSeed: true,
      };
      await assertCellsRestored(cachedFixture, config);
      return cachedFixture;
    } catch (error) {
      console.warn(
        `Invalid cached selection clear seed ${seedCacheInfo.seedTableName}; rebuilding`,
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
    const seeded = await seedRecords(baseFixture, config);

    return {
      ...baseFixture,
      seededRecords: seeded.seededRecords,
      seedBatchDurations: seeded.batchDurations,
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
          `Failed to cleanup incomplete selection clear seed ${createdTableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const buildAllCellsRange = (fixture: ClearFixture) => ({
  viewId: fixture.viewId,
  ranges: [
    [0, 0],
    [fixture.projection.length - 1, fixture.seededRecords.length - 1],
  ] as [[number, number], [number, number]],
  projection: fixture.projection,
});

const clearAllCells = async (
  fixture: ClearFixture,
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

const assertCellsCleared = async (
  fixture: ClearFixture,
  config: SelectionClearCaseConfig,
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

      for (const field of fixture.fields) {
        const actualValue = record.fields[field.id];
        actual[field.name] = actualValue;

        if (actualValue != null) {
          throw new Error(
            `Row ${rowNumber} ${field.name} not cleared: actual ${String(
              actualValue,
            )}`,
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

const assertCellsRestored = async (
  fixture: ClearFixture,
  config: SelectionClearCaseConfig,
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
        const expectedValue = getExpectedCellValue(field, rowNumber, config);
        const actualValue = record.fields[field.id];
        actual[field.name] = actualValue;
        expected[field.name] = expectedValue;

        if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
          throw new Error(
            `Row ${rowNumber} ${field.name} mismatch in selection clear seed: expected ${String(
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

const restoreClearedCells = async (
  fixture: ClearFixture,
  config: SelectionClearCaseConfig,
) => {
  const pageSize = config.verify.fullScanPageSize ?? config.batchSize;
  const batchDurations: number[] = [];
  let restoredRecords = 0;
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
        `Expected ${expectedTake} records to restore at skip ${skip}, got ${result.records.length}`,
      );
    }

    const updates = result.records.map((record, index) => {
      const rowNumber = skip + index + 1;
      return {
        id: record.id,
        fields: Object.fromEntries(
          fixture.fields.map((field) => [
            field.id,
            getExpectedCellValue(field, rowNumber, config),
          ]),
        ),
      };
    });

    const updateMeasurement = await measureAsync(
      `restoreBatch:${pageCount}`,
      () =>
        updateRecords(fixture.tableId, {
          fieldKeyType: FieldKeyType.Id,
          typecast: true,
          records: updates,
        }),
    );
    expect(updateMeasurement.result.status).toBe(200);
    expect(updateMeasurement.result.data).toHaveLength(updates.length);
    batchDurations.push(updateMeasurement.durationMs);
    restoredRecords += updates.length;
  }

  const verified = await assertCellsRestored(fixture, config);

  return {
    restoredRecords,
    pageCount,
    batchDurations,
    maxRestoreBatchMs: batchDurations.length
      ? Math.max(...batchDurations)
      : undefined,
    verified,
  };
};

const buildSelectionClearResult = ({
  config,
  fixture,
  prepareMeasurement,
  clearMeasurement,
  verifyMeasurement,
  error,
}: {
  config: SelectionClearCaseConfig;
  fixture?: ClearFixture;
  prepareMeasurement?: Measurement<ClearFixture>;
  clearMeasurement?: Measurement<Awaited<ReturnType<typeof clearAllCells>>>;
  verifyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertCellsCleared>>
  >;
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
    ...(clearMeasurement
      ? { [config.threshold.metric]: clearMeasurement.durationMs }
      : {}),
  },
  thresholds: clearMeasurement
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
    ...(clearMeasurement
      ? [
          {
            name: clearMeasurement.name,
            durationMs: clearMeasurement.durationMs,
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
    operation: "clear-stream",
    tableId: fixture?.tableId,
    tableName: fixture?.tableName,
    viewId: fixture?.viewId,
    rowCount: config.rowCount,
    batchSize: config.batchSize,
    request: fixture
      ? {
          method: "PATCH",
          path: `/api/table/${fixture.tableId}/selection/clear-stream`,
          ranges: buildAllCellsRange(fixture).ranges,
          projectionSize: fixture.projection.length,
        }
      : undefined,
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
    clearStream: clearMeasurement?.result,
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

export const runSelectionClearCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as SelectionClearCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  let prepareMeasurement: Measurement<ClearFixture> | undefined;
  let restoreMeasurement:
    | Measurement<Awaited<ReturnType<typeof restoreClearedCells>>>
    | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareClearFixture(baseId, tableName, config, perfCase),
    );
    const fixture = prepareMeasurement.result;
    let clearMeasurement:
      | Measurement<Awaited<ReturnType<typeof clearAllCells>>>
      | undefined;
    let verifyMeasurement:
      | Measurement<Awaited<ReturnType<typeof assertCellsCleared>>>
      | undefined;

    try {
      clearMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        "clear",
        () => measureAsync("clear", () => clearAllCells(fixture, context)),
      );

      verifyMeasurement = await measureAsync("verify", () =>
        assertCellsCleared(fixture, config),
      );
    } catch (error) {
      const diagnosticResult = buildSelectionClearResult({
        config,
        fixture,
        prepareMeasurement,
        clearMeasurement,
        verifyMeasurement,
        error,
      });

      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        diagnosticResult,
      );
    }

    return buildSelectionClearResult({
      config,
      fixture,
      prepareMeasurement,
      clearMeasurement,
      verifyMeasurement,
    });
  } finally {
    if (prepareMeasurement?.result.reusableSeed) {
      try {
        restoreMeasurement = await measureAsync("restoreSeed", () =>
          restoreClearedCells(prepareMeasurement!.result, config),
        );
      } catch (error) {
        console.warn(
          `Failed to restore cached selection clear seed ${prepareMeasurement.result.tableId}; deleting it`,
          error,
        );
        try {
          await permanentDeleteTable(baseId, prepareMeasurement.result.tableId);
        } catch (cleanupError) {
          console.warn(
            `Failed to cleanup perf table ${prepareMeasurement.result.tableId}`,
            cleanupError,
          );
        }
      }
    } else if (prepareMeasurement?.result.tableId) {
      try {
        await permanentDeleteTable(baseId, prepareMeasurement.result.tableId);
      } catch (error) {
        console.warn(
          `Failed to cleanup perf table ${prepareMeasurement.result.tableId}`,
          error,
        );
      }
    }

    if (restoreMeasurement) {
      console.log(
        `[perf-lab] restored selection clear seed table=${prepareMeasurement?.result.tableId} durationMs=${Math.round(
          restoreMeasurement.durationMs,
        )}`,
      );
    }
  }
};
