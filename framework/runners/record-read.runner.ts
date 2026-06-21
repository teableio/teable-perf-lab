import { FieldKeyType, FieldType } from "@teable/core";
import { getRecords as apiGetRecords } from "@teable/openapi";
import {
  createField,
  createRecords,
  createTable,
  getFields,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { chunk } from "../chunk";
import { getPrimaryThresholdMs } from "../env";
import { measureAsync, roundMetric, type Measurement } from "../metrics";
import { pollUntilReady } from "../readiness";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import {
  collectSampleRecords,
  type SeededSampleRecord,
} from "../sample-records";
import {
  buildSeedCacheInfo,
  buildSeedTableName,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordReadCaseConfig,
} from "../types";
import {
  runReadLifecycle,
  seedReadLifecycle,
  type ReadLifecycleSpec,
} from "./read-lifecycle";
import {
  assertConfigShape,
  buildHostBaseFieldModels,
  buildHostRecordFields,
  buildSourceFieldModels,
  buildSourceRecordFields,
  compileExpression,
  formulaName,
  getExpectedValue,
  getFormulaExpression,
  getProjectionFieldNames,
  getSourceFieldNames,
  HOST_LOOKUP_KEY_FIELD_NAME,
  lookupName,
  RECORD_READ_FIXTURE_VERSION,
  resolveFieldIds,
  type ResolvedField,
  parseRowNumberFromTitle,
  SOURCE_KEY_FIELD_NAME,
  sourceValueName,
  valuesMatch,
} from "./record-read-model";

type RecordReadFixture = {
  sourceTableId: string;
  sourceTableName: string;
  tableId: string;
  tableName: string;
  viewId: string;
  sourceFields: Record<string, string>;
  fields: ResolvedField[];
  fieldIdByName: Map<string, string>;
  projection: string[];
  seededSamples: SeededSampleRecord[];
  sourceBatchDurations: number[];
  hostBatchDurations: number[];
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
  createTablesMeasurement: Measurement<unknown>;
  seedSourceMeasurement: Measurement<unknown>;
  seedHostMeasurement: Measurement<unknown>;
  createFormulaFieldsMeasurement: Measurement<unknown>;
  createLookupFieldsMeasurement: Measurement<unknown>;
  computedReadyMeasurement: Measurement<ProjectionScanVerification>;
};

type ProjectionScanVerification = {
  scannedRecords: number;
  pageSize: number;
  pageCount: number;
  verifiedSamples: PageSampleVerification[];
};

type ProjectionBoundaryVerification = {
  checkedRecords: number;
  expectedRecords: number;
  firstRowNumber: number;
  lastRowNumber: number;
  beyondLastCount: number;
};

type PageSampleVerification = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
  checkedFields: number;
  actual: Record<string, unknown>;
  expected: Record<string, unknown>;
};

type ReadPageResult = {
  skip: number;
  take: number;
  status: number;
  records: Array<{ id: string; fields: Record<string, unknown> }>;
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
};

type ReadPagedScanResult = {
  pages: ReadPageResult[];
  records: Array<{ id: string; fields: Record<string, unknown> }>;
  query?: Record<string, unknown>;
};

type ReadPagedScanVerification = {
  scannedRecords: number;
  expectedRecords?: number;
  minimumRecords?: number;
  pageSize: number;
  pageCount: number;
  fieldCount: number;
  projectionFieldCount: number;
  verifiedSamples: PageSampleVerification[];
};

const pickResponseHeaders = pickRoutingResponseHeaders;

const assertExpectedRouting = (
  context: PerfRunContext,
  responseHeaders: Record<string, string>,
) =>
  assertEngineRouting(context, responseHeaders, {
    operation: "getRecords",
  });

const getSeedConfig = (config: RecordReadCaseConfig) => ({
  baseId: config.baseId,
  sourceTableNamePrefix: config.sourceTableNamePrefix,
  tableNamePrefix: config.tableNamePrefix,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  pageSize: config.pageSize,
  skip: config.skip,
  simpleTextFieldCount: config.simpleTextFieldCount,
  formulaFieldCount: config.formulaFieldCount,
  lookupFieldCount: config.lookupFieldCount,
  generator: config.generator,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: RECORD_READ_FIXTURE_VERSION,
});

const buildRecordReadSeedCacheInfo = (perfCase: PerfCase) => {
  const config = perfCase.config as RecordReadCaseConfig;
  return buildSeedCacheInfo({
    perfCase,
    runner: "record-read",
    fixtureVersion: RECORD_READ_FIXTURE_VERSION,
    seedConfig: getSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("./record-read-model.ts", import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
};

const fieldTypeByModel = {
  singleLineText: FieldType.SingleLineText,
  number: FieldType.Number,
} as const;

const toCreateFields = (
  fields: ReturnType<
    typeof buildSourceFieldModels | typeof buildHostBaseFieldModels
  >,
) =>
  fields.map((field) => ({
    name: field.name,
    type: fieldTypeByModel[field.type],
  }));

const resolveFixtureFields = async (
  sourceTableId: string,
  hostTableId: string,
  config: RecordReadCaseConfig,
) => {
  const [sourceFields, hostFields, views] = await Promise.all([
    getFields(sourceTableId),
    getFields(hostTableId),
    getViews(hostTableId),
  ]);
  const viewId = views[0]?.id;
  if (!viewId) {
    throw new Error(`No grid view found for record-read table ${hostTableId}`);
  }
  const sourceFieldIdByName = resolveFieldIds(
    sourceFields,
    getSourceFieldNames(config),
    sourceTableId,
  );
  const projectionNames = getProjectionFieldNames(config);
  const hostFieldIdByName = resolveFieldIds(
    hostFields,
    projectionNames,
    hostTableId,
  );
  return {
    viewId,
    sourceFields: Object.fromEntries(sourceFieldIdByName),
    fields: projectionNames.map((name) => {
      const field = hostFields.find((item) => item.name === name);
      return {
        id: hostFieldIdByName.get(name)!,
        name,
        type: field?.type,
      };
    }),
    fieldIdByName: hostFieldIdByName,
    projection: projectionNames.map((name) => hostFieldIdByName.get(name)!),
  };
};

const seedSourceRecords = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  tableId: string,
  config: RecordReadCaseConfig,
) => {
  const rows = Array.from({ length: config.rowCount }, (_, index) => ({
    rowNumber: index + 1,
    fields: buildSourceRecordFields(index + 1, config),
  }));
  const batchDurations: number[] = [];
  const seedSourceMeasurement = await measureAsync(
    "seedSourceRecords",
    async () => {
      for (const [batchIndex, batch] of chunk(
        rows,
        config.batchSize,
      ).entries()) {
        const batchMeasurement = await measureAsync(
          `seedSourceBatch:${batchIndex + 1}`,
          () =>
            withPerfTraceStep(
              context,
              perfCase,
              `seedSourceBatch:${batchIndex + 1}`,
              () =>
                createRecords(tableId, {
                  fieldKeyType: FieldKeyType.Name,
                  records: batch.map((record) => ({ fields: record.fields })),
                }),
            ),
        );
        batchDurations.push(batchMeasurement.durationMs);
        expect(batchMeasurement.result.records).toHaveLength(batch.length);
      }
    },
  );
  return { seedSourceMeasurement, batchDurations };
};

const seedHostRecords = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  tableId: string,
  config: RecordReadCaseConfig,
) => {
  const wantedSampleOffsets = new Set(config.verify.sampleRows);
  const sampleByOffset = new Map<number, SeededSampleRecord>();
  const rows = Array.from({ length: config.rowCount }, (_, index) => ({
    rowOffset: index,
    rowNumber: index + 1,
    fields: buildHostRecordFields(index + 1, config),
  }));
  const batchDurations: number[] = [];
  const seedHostMeasurement = await measureAsync(
    "seedHostRecords",
    async () => {
      for (const [batchIndex, batch] of chunk(
        rows,
        config.batchSize,
      ).entries()) {
        const batchMeasurement = await measureAsync(
          `seedHostBatch:${batchIndex + 1}`,
          () =>
            withPerfTraceStep(
              context,
              perfCase,
              `seedHostBatch:${batchIndex + 1}`,
              () =>
                createRecords(tableId, {
                  fieldKeyType: FieldKeyType.Name,
                  records: batch.map((record) => ({ fields: record.fields })),
                }),
            ),
        );
        batchDurations.push(batchMeasurement.durationMs);
        expect(batchMeasurement.result.records).toHaveLength(batch.length);
        collectSampleRecords(
          sampleByOffset,
          wantedSampleOffsets,
          batch,
          batchMeasurement.result.records,
        );
      }
    },
  );

  const seededSamples = config.verify.sampleRows.map((rowOffset) => {
    const sample = sampleByOffset.get(rowOffset);
    if (!sample) {
      throw new Error(`Missing record-read sample row offset ${rowOffset}`);
    }
    return sample;
  });

  return { seedHostMeasurement, batchDurations, seededSamples };
};

const createFormulaFields = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  tableId: string,
  fieldIdByName: Map<string, string>,
  config: RecordReadCaseConfig,
) =>
  measureAsync("createFormulaFields", async () => {
    for (let index = 1; index <= config.formulaFieldCount; index += 1) {
      await withPerfTraceStep(
        context,
        perfCase,
        // Identify by field name, not positional index: each formula has a
        // distinct expression, so these steps are NOT interchangeable repeats.
        // A bare trailing `:${index}` would normalize to the same shape and let
        // one saved trace falsely "cover" another field's Jaeger 404. Matches
        // the name-based convention in formula-table.runner.ts.
        `seedBuild:createFormulaField:${formulaName(index)}`,
        () =>
          createField(tableId, {
            name: formulaName(index),
            type: FieldType.Formula,
            options: {
              expression: compileExpression(
                getFormulaExpression(index),
                fieldIdByName,
              ),
            },
          }),
      );
    }
  });

const createLookupFields = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  sourceTableId: string,
  tableId: string,
  sourceFields: Record<string, string>,
  fieldIdByName: Map<string, string>,
  config: RecordReadCaseConfig,
) =>
  measureAsync("createLookupFields", async () => {
    for (let index = 1; index <= config.lookupFieldCount; index += 1) {
      await withPerfTraceStep(
        context,
        perfCase,
        // Identify by field name, not positional index (see createFormulaField):
        // each lookup targets a different source field, so these are distinct
        // operations that must not collapse to one normalized shape.
        `seedBuild:createLookupField:${lookupName(index)}`,
        () =>
          createField(tableId, {
            name: lookupName(index),
            type: FieldType.SingleLineText,
            isLookup: true,
            isConditionalLookup: true,
            lookupOptions: {
              foreignTableId: sourceTableId,
              lookupFieldId: sourceFields[sourceValueName(index)],
              filter: {
                conjunction: "and",
                filterSet: [
                  {
                    fieldId: sourceFields[SOURCE_KEY_FIELD_NAME],
                    operator: "is",
                    value: {
                      type: "field",
                      fieldId: fieldIdByName.get(HOST_LOOKUP_KEY_FIELD_NAME),
                    },
                  },
                ],
              },
              limit: 1,
            },
          }),
      );
    }
  });

const verifyRecords = (
  records: Array<{ id: string; fields: Record<string, unknown> }>,
  fields: ResolvedField[],
  config: RecordReadCaseConfig,
  expectedCount: number,
  sampleRows: number[] = config.verify.sampleRows,
) => {
  if (records.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} getRecords rows, got ${records.length}`,
    );
  }

  const sampleOffsets = new Set(sampleRows);
  const verifiedSamples: PageSampleVerification[] = [];

  for (const record of records) {
    const titleField = fields.find((field) => field.name === "Title");
    if (!titleField) {
      throw new Error("record-read projection is missing Title");
    }
    const rowNumber = parseRowNumberFromTitle(
      record.fields[titleField.id],
      config,
    );
    const rowOffset = rowNumber - 1;
    const actualFieldCount = Object.keys(record.fields).length;
    if (actualFieldCount !== fields.length) {
      throw new Error(
        `Row ${rowNumber} expected ${fields.length} projected fields, got ${actualFieldCount}`,
      );
    }

    const sampleActual: Record<string, unknown> = {};
    const sampleExpected: Record<string, unknown> = {};
    for (const field of fields) {
      const expected = getExpectedValue(field.name, rowNumber, config);
      const actual = record.fields[field.id];
      if (!valuesMatch(expected, actual)) {
        throw new Error(
          `Row ${rowNumber} ${field.name} mismatch: expected ${JSON.stringify(
            expected,
          )}, actual ${JSON.stringify(actual)}`,
        );
      }
      if (sampleOffsets.has(rowOffset)) {
        sampleActual[field.name] = actual;
        sampleExpected[field.name] = expected;
      }
    }

    if (sampleOffsets.has(rowOffset)) {
      verifiedSamples.push({
        rowOffset,
        rowNumber,
        recordId: record.id,
        checkedFields: fields.length,
        actual: sampleActual,
        expected: sampleExpected,
      });
    }
  }

  return verifiedSamples.sort(
    (left, right) => left.rowOffset - right.rowOffset,
  );
};

const assertProjectionFullScan = async (
  fixture: Pick<
    RecordReadFixture,
    "tableId" | "viewId" | "fields" | "projection"
  >,
  config: RecordReadCaseConfig,
): Promise<ProjectionScanVerification> => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const verifiedSamples: PageSampleVerification[] = [];
  let scannedRecords = 0;
  let pageCount = 0;

  for (let skip = 0; skip < config.rowCount; skip += pageSize) {
    const expectedTake = Math.min(pageSize, config.rowCount - skip);
    const response = await apiGetRecords(fixture.tableId, {
      viewId: fixture.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: fixture.projection,
      skip,
      take: expectedTake,
    });
    expect(response.status).toBe(200);
    pageCount += 1;
    verifiedSamples.push(
      ...verifyRecords(
        response.data.records,
        fixture.fields,
        config,
        expectedTake,
        config.verify.sampleRows,
      ),
    );
    scannedRecords += response.data.records.length;
  }

  if (scannedRecords !== config.rowCount) {
    throw new Error(
      `record-read full scan expected ${config.rowCount}, scanned ${scannedRecords}`,
    );
  }

  const beyondLast = await apiGetRecords(fixture.tableId, {
    viewId: fixture.viewId,
    fieldKeyType: FieldKeyType.Id,
    projection: [fixture.projection[0]],
    skip: config.rowCount,
    take: 1,
  });
  if (beyondLast.data.records.length !== 0) {
    throw new Error(
      `record-read seed has extra rows after rowCount=${config.rowCount}`,
    );
  }

  return {
    scannedRecords,
    pageSize,
    pageCount,
    verifiedSamples,
  };
};

const assertProjectionBoundary = async (
  fixture: Pick<RecordReadFixture, "tableId" | "viewId" | "fields">,
  config: RecordReadCaseConfig,
): Promise<ProjectionBoundaryVerification> => {
  const titleField = fixture.fields.find((field) => field.name === "Title");
  if (!titleField) {
    throw new Error("record-read projection is missing Title");
  }

  const [first, last, beyondLast] = await Promise.all([
    apiGetRecords(fixture.tableId, {
      viewId: fixture.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: [titleField.id],
      skip: 0,
      take: 1,
    }),
    apiGetRecords(fixture.tableId, {
      viewId: fixture.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: [titleField.id],
      skip: config.rowCount - 1,
      take: 1,
    }),
    apiGetRecords(fixture.tableId, {
      viewId: fixture.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: [titleField.id],
      skip: config.rowCount,
      take: 1,
    }),
  ]);

  expect(first.status).toBe(200);
  expect(last.status).toBe(200);
  expect(beyondLast.status).toBe(200);

  if (first.data.records.length !== 1) {
    throw new Error(
      `record-read seed boundary expected first row, got ${first.data.records.length}`,
    );
  }
  if (last.data.records.length !== 1) {
    throw new Error(
      `record-read seed boundary expected row ${config.rowCount}, got ${last.data.records.length}`,
    );
  }
  if (beyondLast.data.records.length !== 0) {
    throw new Error(
      `record-read seed boundary found extra rows after rowCount=${config.rowCount}`,
    );
  }

  const firstRowNumber = parseRowNumberFromTitle(
    first.data.records[0].fields[titleField.id],
    config,
  );
  const lastRowNumber = parseRowNumberFromTitle(
    last.data.records[0].fields[titleField.id],
    config,
  );
  if (firstRowNumber !== 1) {
    throw new Error(
      `record-read seed boundary expected first row number 1, got ${firstRowNumber}`,
    );
  }
  if (lastRowNumber !== config.rowCount) {
    throw new Error(
      `record-read seed boundary expected last row number ${config.rowCount}, got ${lastRowNumber}`,
    );
  }

  return {
    checkedRecords: first.data.records.length + last.data.records.length,
    expectedRecords: config.rowCount,
    firstRowNumber,
    lastRowNumber,
    beyondLastCount: beyondLast.data.records.length,
  };
};

const waitForProjectionFullScan = (
  fixture: Pick<
    RecordReadFixture,
    "tableId" | "viewId" | "fields" | "projection"
  >,
  config: RecordReadCaseConfig,
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 120_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 1_000,
      description: "record-read projection",
    },
    () => assertProjectionFullScan(fixture, config),
  );

const createEmptyMeasurement = <T>(
  name: string,
  result: T,
): Measurement<T> => ({
  name,
  durationMs: 0,
  result,
});

const buildCachedFixture = async (
  sourceTableId: string,
  sourceTableName: string,
  tableId: string,
  tableName: string,
  seedCacheInfo: SeedCacheInfo,
  config: RecordReadCaseConfig,
): Promise<RecordReadFixture> => {
  const resolved = await resolveFixtureFields(sourceTableId, tableId, config);
  const computedReadyMeasurement = await measureAsync(
    "computedReadyCached",
    () =>
      waitForProjectionFullScan(
        {
          tableId,
          viewId: resolved.viewId,
          fields: resolved.fields,
          projection: resolved.projection,
        },
        config,
      ),
  );
  return {
    sourceTableId,
    sourceTableName,
    tableId,
    tableName,
    ...resolved,
    seededSamples: computedReadyMeasurement.result.verifiedSamples.map(
      (sample) => ({
        rowOffset: sample.rowOffset,
        rowNumber: sample.rowNumber,
        recordId: sample.recordId,
      }),
    ),
    sourceBatchDurations: [0],
    hostBatchDurations: [0],
    seedCacheInfo,
    seedCacheHit: true,
    reusableSeed: true,
    createTablesMeasurement: createEmptyMeasurement("seedRestore", null),
    seedSourceMeasurement: createEmptyMeasurement(
      "seedSourceRecordsCached",
      null,
    ),
    seedHostMeasurement: createEmptyMeasurement("seedHostRecordsCached", null),
    createFormulaFieldsMeasurement: createEmptyMeasurement(
      "createFormulaFieldsCached",
      null,
    ),
    createLookupFieldsMeasurement: createEmptyMeasurement(
      "createLookupFieldsCached",
      null,
    ),
    computedReadyMeasurement,
  };
};

const deleteTables = async (baseId: string, tableIds: string[]) => {
  for (const tableId of tableIds.filter(Boolean)) {
    try {
      await permanentDeleteTable(baseId, tableId);
    } catch (error) {
      console.warn(`Failed to cleanup perf table ${tableId}`, error);
    }
  }
};

const createFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  sourceTableName: string,
  tableName: string,
  seedCacheInfo: SeedCacheInfo,
  config: RecordReadCaseConfig,
): Promise<RecordReadFixture> => {
  const createdTableIds: string[] = [];
  try {
    const createTablesMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      seedCacheInfo.enabled ? "seedBuild:createTables" : "createTables",
      () =>
        measureAsync("createTables", async () => {
          const sourceTable = await createTable(baseId, {
            name: sourceTableName,
            fields: toCreateFields(buildSourceFieldModels(config)),
            records: [],
          });
          createdTableIds.push(sourceTable.id);
          const hostTable = await createTable(baseId, {
            name: tableName,
            fields: toCreateFields(buildHostBaseFieldModels(config)),
            records: [],
          });
          createdTableIds.push(hostTable.id);
          return { sourceTable, hostTable };
        }),
    );
    const sourceTableId = (
      createTablesMeasurement.result as {
        sourceTable: { id: string };
      }
    ).sourceTable.id;
    const tableId = (
      createTablesMeasurement.result as {
        hostTable: { id: string };
      }
    ).hostTable.id;
    const initialResolved = await resolveFixtureFields(sourceTableId, tableId, {
      ...config,
      formulaFieldCount: 0,
      lookupFieldCount: 0,
    });
    const { seedSourceMeasurement, batchDurations: sourceBatchDurations } =
      await seedSourceRecords(perfCase, context, sourceTableId, config);
    const {
      seedHostMeasurement,
      batchDurations: hostBatchDurations,
      seededSamples,
    } = await seedHostRecords(perfCase, context, tableId, config);
    const createFormulaFieldsMeasurement = await createFormulaFields(
      perfCase,
      context,
      tableId,
      initialResolved.fieldIdByName,
      config,
    );
    const sourceFieldIdByName = resolveFieldIds(
      await getFields(sourceTableId),
      getSourceFieldNames(config),
      sourceTableId,
    );
    const createLookupFieldsMeasurement = await createLookupFields(
      perfCase,
      context,
      sourceTableId,
      tableId,
      Object.fromEntries(sourceFieldIdByName),
      initialResolved.fieldIdByName,
      config,
    );
    const resolved = await resolveFixtureFields(sourceTableId, tableId, config);
    const computedReadyMeasurement = await measureAsync("computedReady", () =>
      waitForProjectionFullScan(
        {
          tableId,
          viewId: resolved.viewId,
          fields: resolved.fields,
          projection: resolved.projection,
        },
        config,
      ),
    );

    return {
      sourceTableId,
      sourceTableName,
      tableId,
      tableName,
      ...resolved,
      seededSamples,
      sourceBatchDurations,
      hostBatchDurations,
      seedCacheInfo,
      seedCacheHit: false,
      reusableSeed: seedCacheInfo.enabled,
      createTablesMeasurement,
      seedSourceMeasurement,
      seedHostMeasurement,
      createFormulaFieldsMeasurement,
      createLookupFieldsMeasurement,
      computedReadyMeasurement,
    };
  } catch (error) {
    await deleteTables(baseId, createdTableIds.reverse());
    throw error;
  }
};

const prepareRecordReadFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: RecordReadCaseConfig,
) => {
  assertConfigShape(config);
  const baseId = globalThis.testConfig.baseId;
  const seedCacheInfo = await buildRecordReadSeedCacheInfo(perfCase);
  const timestamp = Date.now();
  const sourceTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "source")
    : `${config.sourceTableNamePrefix}-${timestamp}`;
  const tableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "host")
    : `${config.tableNamePrefix}-${timestamp}`;

  if (seedCacheInfo.enabled) {
    const [sourceTable, hostTable] = await Promise.all([
      findSeedTable(baseId, sourceTableName),
      findSeedTable(baseId, tableName),
    ]);
    if (sourceTable && hostTable) {
      try {
        return await buildCachedFixture(
          sourceTable.id,
          sourceTable.name,
          hostTable.id,
          hostTable.name,
          seedCacheInfo,
          config,
        );
      } catch (error) {
        console.warn(
          `Invalid cached record-read fixture ${tableName}; rebuilding`,
          error,
        );
        await deleteTables(baseId, [hostTable.id, sourceTable.id]);
      }
    } else if (sourceTable || hostTable) {
      await deleteTables(
        baseId,
        [hostTable?.id, sourceTable?.id].filter((id): id is string =>
          Boolean(id),
        ),
      );
    }
  }

  return createFixture(
    perfCase,
    context,
    baseId,
    sourceTableName,
    tableName,
    seedCacheInfo,
    config,
  );
};

const readPage = async (
  fixture: RecordReadFixture,
  context: PerfRunContext,
  config: RecordReadCaseConfig,
  skip: number,
  query: Record<string, unknown> = {},
): Promise<ReadPageResult> => {
  const response = await apiGetRecords(fixture.tableId, {
    viewId: fixture.viewId,
    fieldKeyType: FieldKeyType.Id,
    projection: fixture.projection,
    skip,
    take: config.pageSize,
    ...query,
  });
  expect(response.status).toBe(200);
  const responseHeaders = pickResponseHeaders(
    response.headers as Record<string, unknown>,
  );
  return {
    skip,
    take: config.pageSize,
    status: response.status,
    records: response.data.records,
    responseHeaders,
    routing: assertExpectedRouting(context, responseHeaders),
  };
};

const readPagedScan = async (
  fixture: RecordReadFixture,
  context: PerfRunContext,
  config: RecordReadCaseConfig,
  query: Record<string, unknown> = {},
): Promise<ReadPagedScanResult> => {
  const pages: ReadPageResult[] = [];

  for (
    let skip = config.skip;
    skip < config.rowCount;
    skip += config.pageSize
  ) {
    pages.push(await readPage(fixture, context, config, skip, query));
  }

  return {
    pages,
    records: pages.flatMap((page) => page.records),
    query,
  };
};

const resolveQueryFieldId = (fixture: RecordReadFixture, fieldName: string) => {
  const fieldId = fixture.fieldIdByName.get(fieldName);
  if (!fieldId) {
    throw new Error(
      `record-read query variant references missing field ${fieldName}`,
    );
  }
  return fieldId;
};

const buildQueryVariant = (
  fixture: RecordReadFixture,
  config: RecordReadCaseConfig,
): Record<string, unknown> => {
  const variant = config.queryVariant;
  if (!variant) {
    return {};
  }

  const filterFieldId = resolveQueryFieldId(fixture, variant.filterFieldName);
  const orderByFieldId = resolveQueryFieldId(fixture, variant.orderByFieldName);
  const groupByFieldId = resolveQueryFieldId(fixture, variant.groupByFieldName);
  // Shapes below match getRecordsRoSchema (packages/openapi record/get-list):
  // `filter` is IFilter { conjunction, filterSet:[{fieldId, operator, value}] },
  // `orderBy`/`groupBy` are ISortItem[] { fieldId, order }. The client
  // JSON-stringifies these objects into the query string, so passing objects
  // (not strings) is correct. `isNotEmpty` is in operatorsExpectingNull, hence
  // value:null. The return is intentionally a plain record because the e2e
  // getRecords util is stubbed as `any` under the standalone type check, so this
  // shape is validated at runtime (per-page routing is asserted in readPage, so
  // a V2->V1 fallback on queried reads surfaces as a routing failure).
  return {
    filter: {
      conjunction: "and",
      filterSet: [
        {
          fieldId: filterFieldId,
          operator: "isNotEmpty",
          value: null,
        },
      ],
    },
    orderBy: [{ fieldId: orderByFieldId, order: "asc" }],
    groupBy: [{ fieldId: groupByFieldId, order: "asc" }],
  };
};

const verifyReadPagedScan = (
  fixture: RecordReadFixture,
  config: RecordReadCaseConfig,
  readResult: ReadPagedScanResult,
): ReadPagedScanVerification => {
  const isQueryVariant = Boolean(config.queryVariant);
  const expectedPageCount = config.rowCount / config.pageSize;
  if (readResult.pages.length !== expectedPageCount) {
    throw new Error(
      `Expected ${expectedPageCount} getRecords pages, got ${readResult.pages.length}`,
    );
  }

  readResult.pages.forEach((page, pageIndex) => {
    const expectedSkip = config.skip + pageIndex * config.pageSize;
    if (page.skip !== expectedSkip) {
      throw new Error(
        `Expected getRecords page ${pageIndex + 1} skip=${expectedSkip}, got ${page.skip}`,
      );
    }
    if (!isQueryVariant && page.records.length !== config.pageSize) {
      throw new Error(
        `Expected getRecords page ${pageIndex + 1} to return ${config.pageSize} records, got ${page.records.length}`,
      );
    }
  });

  if (isQueryVariant && readResult.records.length === 0) {
    throw new Error("Query variant returned no records");
  }

  // The query variant relaxes the per-page full-page check (filter/sort/groupBy
  // may reshape pagination), so the count check in verifyRecords becomes a
  // tautology. Guard completeness here instead: every returned row must resolve
  // to a distinct row number inside [1, rowCount]. This catches duplicated or
  // out-of-range rows that the per-record field check alone would miss when the
  // paged groupBy scan overlaps or skips group boundaries.
  if (isQueryVariant) {
    const titleField = fixture.fields.find((field) => field.name === "Title");
    if (!titleField) {
      throw new Error("record-read projection is missing Title");
    }
    const seenRowNumbers = new Set<number>();
    for (const record of readResult.records) {
      const rowNumber = parseRowNumberFromTitle(
        record.fields[titleField.id],
        config,
      );
      if (rowNumber > config.rowCount) {
        throw new Error(
          `Query variant returned row ${rowNumber} beyond rowCount ${config.rowCount}`,
        );
      }
      if (seenRowNumbers.has(rowNumber)) {
        throw new Error(
          `Query variant returned duplicate row ${rowNumber} across paged scan`,
        );
      }
      seenRowNumbers.add(rowNumber);
    }
  }

  const sampleRows = isQueryVariant
    ? readResult.records
        .slice(
          0,
          Math.min(readResult.records.length, config.verify.sampleRows.length),
        )
        .map((record) => {
          const titleField = fixture.fields.find(
            (field) => field.name === "Title",
          );
          if (!titleField) {
            throw new Error("record-read projection is missing Title");
          }
          return (
            parseRowNumberFromTitle(record.fields[titleField.id], config) - 1
          );
        })
    : config.verify.sampleRows;
  const verifiedSamples = verifyRecords(
    readResult.records,
    fixture.fields,
    config,
    isQueryVariant ? readResult.records.length : config.rowCount,
    sampleRows,
  );
  return {
    scannedRecords: readResult.records.length,
    expectedRecords: isQueryVariant ? undefined : config.rowCount,
    minimumRecords: isQueryVariant ? 1 : undefined,
    pageSize: config.pageSize,
    pageCount: readResult.pages.length,
    fieldCount: fixture.fields.length,
    projectionFieldCount: fixture.projection.length,
    verifiedSamples,
  };
};

const buildRecordReadResult = ({
  config,
  fixture,
  prepareMeasurement,
  seedReadyMeasurement,
  readMeasurement,
  verifyMeasurement,
  baselineMeasurement,
  baselineVerifyMeasurement,
  error,
}: {
  config: RecordReadCaseConfig;
  fixture?: RecordReadFixture;
  prepareMeasurement?: Measurement<RecordReadFixture>;
  seedReadyMeasurement?: Measurement<ProjectionBoundaryVerification>;
  readMeasurement?: Measurement<ReadPagedScanResult>;
  verifyMeasurement?: Measurement<ReadPagedScanVerification>;
  baselineMeasurement?: Measurement<ReadPagedScanResult>;
  baselineVerifyMeasurement?: Measurement<ReadPagedScanVerification>;
  error?: unknown;
}): PerfRunResult => {
  const isOverheadCase = Boolean(config.queryVariant);
  const overheadMs =
    readMeasurement && baselineMeasurement
      ? roundMetric(readMeasurement.durationMs - baselineMeasurement.durationMs)
      : undefined;
  // The threshold-participating overhead is clamped at 0: when the query variant
  // runs at or below the baseline, overhead is effectively zero, so a negative
  // raw delta should not silently satisfy the threshold (every negative value is
  // <= maxMs and would pass without measuring anything). The signed delta is kept
  // as the diagnostic getRecordsFilterSortGroupByOverheadSignedMs below, and the
  // raw baseline/query durations remain reported for full reconstruction.
  const primaryMetricValue =
    isOverheadCase && overheadMs != null
      ? Math.max(overheadMs, 0)
      : readMeasurement?.durationMs;

  return {
    metrics: {
      ...(prepareMeasurement
        ? { prepareMs: prepareMeasurement.durationMs }
        : {}),
      ...(fixture
        ? {
            seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
            seedCacheHit: fixture.seedCacheHit ? 1 : 0,
            ...(fixture.seedCacheHit
              ? { seedRestoreMs: prepareMeasurement?.durationMs ?? 0 }
              : fixture.seedCacheInfo.enabled
                ? { seedBuildMs: prepareMeasurement?.durationMs ?? 0 }
                : {}),
            createTablesMs: fixture.createTablesMeasurement.durationMs,
            seedSourceRecordsMs: fixture.seedSourceMeasurement.durationMs,
            seedHostRecordsMs: fixture.seedHostMeasurement.durationMs,
            maxSeedBatchMs: roundMetric(
              Math.max(
                ...fixture.sourceBatchDurations,
                ...fixture.hostBatchDurations,
              ),
            ),
            createFormulaFieldsMs:
              fixture.createFormulaFieldsMeasurement.durationMs,
            createLookupFieldsMs:
              fixture.createLookupFieldsMeasurement.durationMs,
            computedReadyMs: fixture.computedReadyMeasurement.durationMs,
          }
        : {}),
      ...(seedReadyMeasurement
        ? { seedReadyMs: seedReadyMeasurement.durationMs }
        : {}),
      ...(baselineMeasurement
        ? {
            getRecordsBaselinePagedScanMs: baselineMeasurement.durationMs,
            baselineReturnedRecords: baselineMeasurement.result.records.length,
            baselineRequestCount: baselineMeasurement.result.pages.length,
          }
        : {}),
      ...(readMeasurement
        ? {
            ...(primaryMetricValue != null
              ? { [config.threshold.metric]: primaryMetricValue }
              : {}),
            getRecordsQueryPagedScanMs: readMeasurement.durationMs,
            returnedRecords: readMeasurement.result.records.length,
            requestCount: readMeasurement.result.pages.length,
            responseStatus: readMeasurement.result.pages.at(-1)?.status ?? 0,
            ...(baselineMeasurement && overheadMs != null
              ? {
                  getRecordsFilterSortGroupByOverheadSignedMs: overheadMs,
                  getRecordsFilterSortGroupByOverheadRatio: roundMetric(
                    readMeasurement.durationMs /
                      Math.max(baselineMeasurement.durationMs, 1),
                  ),
                }
              : {}),
          }
        : {}),
      ...(verifyMeasurement
        ? { verifyReadPagesMs: verifyMeasurement.durationMs }
        : {}),
      ...(baselineVerifyMeasurement
        ? { verifyBaselineReadPagesMs: baselineVerifyMeasurement.durationMs }
        : {}),
    },
    thresholds:
      primaryMetricValue != null
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
      ...(baselineMeasurement
        ? [
            {
              name: baselineMeasurement.name,
              durationMs: baselineMeasurement.durationMs,
            },
          ]
        : []),
      ...(readMeasurement
        ? [
            {
              name: readMeasurement.name,
              durationMs: readMeasurement.durationMs,
            },
          ]
        : []),
      ...(baselineVerifyMeasurement
        ? [
            {
              name: baselineVerifyMeasurement.name,
              durationMs: baselineVerifyMeasurement.durationMs,
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
      operation: "getRecords",
      sourceTableId: fixture?.sourceTableId,
      sourceTableName: fixture?.sourceTableName,
      tableId: fixture?.tableId,
      tableName: fixture?.tableName,
      viewId: fixture?.viewId,
      rowCount: config.rowCount,
      request: fixture
        ? {
            method: "GET",
            path: `/api/table/${fixture.tableId}/record`,
            fieldKeyType: "id",
            firstSkip: config.skip,
            lastSkip: config.rowCount - config.pageSize,
            take: config.pageSize,
            requestCount: config.rowCount / config.pageSize,
            projectionFieldCount: fixture.projection.length,
          }
        : undefined,
      fields: fixture?.fields,
      seed: fixture
        ? {
            cache: {
              enabled: fixture.seedCacheInfo.enabled,
              cacheHit: fixture.seedCacheHit,
              reusable: fixture.reusableSeed,
              seedHash: fixture.seedCacheInfo.seedHash,
              seedHashShort: fixture.seedCacheInfo.seedHashShort,
              seedNamePrefix: fixture.seedCacheInfo.seedNamePrefix,
              sourceTableName: fixture.sourceTableName,
              tableName: fixture.tableName,
              schemaSignature: fixture.seedCacheInfo.schemaSignature,
            },
            sourceBatchCount: fixture.sourceBatchDurations.length,
            hostBatchCount: fixture.hostBatchDurations.length,
            computedFullScan: {
              scannedRecords:
                fixture.computedReadyMeasurement.result.scannedRecords,
              pageSize: fixture.computedReadyMeasurement.result.pageSize,
              pageCount: fixture.computedReadyMeasurement.result.pageCount,
            },
            readyBoundary: seedReadyMeasurement?.result
              ? {
                  checkedRecords: seedReadyMeasurement.result.checkedRecords,
                  expectedRecords: seedReadyMeasurement.result.expectedRecords,
                  firstRowNumber: seedReadyMeasurement.result.firstRowNumber,
                  lastRowNumber: seedReadyMeasurement.result.lastRowNumber,
                  beyondLastCount: seedReadyMeasurement.result.beyondLastCount,
                }
              : undefined,
          }
        : undefined,
      queryVariant: config.queryVariant
        ? {
            config: config.queryVariant,
            query: readMeasurement?.result.query,
            baselineMs: baselineMeasurement?.durationMs,
            queryMs: readMeasurement?.durationMs,
            overheadMs,
            overheadRatio:
              readMeasurement && baselineMeasurement
                ? roundMetric(
                    readMeasurement.durationMs /
                      Math.max(baselineMeasurement.durationMs, 1),
                  )
                : undefined,
          }
        : undefined,
      responseHeaders: readMeasurement?.result.pages.map(
        (page) => page.responseHeaders,
      ),
      routing: readMeasurement?.result.pages.map((page) => page.routing),
      baselineReadPages: baselineVerifyMeasurement?.result,
      readPages: verifyMeasurement?.result,
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

// record-read is the FIRST member of the read lifecycle: seed (or restore) a host
// table plus the source table its lookups read through, assert the full 50-field
// projection is readable, run the measured paged getRecords scan (optionally vs a
// no-query baseline for the overhead variant) and verify it, then drop the host +
// source tables unless they are a reusable cached seed. Its prepare carries its
// own "prepare" measurement (so the driver emits no "prepare" phase), and its
// primary bundles the optional baseline scan + the trace-wrapped measured scan +
// the verify pass — all expressed in the spec, so the new read driver is born
// minimal and family-shaped (lookup-search-index joins as the second member).
type RecordReadLifecycleFixture = RecordReadFixture & {
  // Parked by prepareFixture (the driver emits no "prepare" phase); buildResult
  // rebuilds the prepare measurement from this.
  prepareDurationMs: number;
};

type RecordReadPrimary = {
  readMeasurement: Measurement<ReadPagedScanResult>;
  verifyMeasurement: Measurement<ReadPagedScanVerification>;
  // Only the queryVariant (overhead) case runs the no-query baseline scan.
  baselineMeasurement?: Measurement<ReadPagedScanResult>;
  baselineVerifyMeasurement?: Measurement<ReadPagedScanVerification>;
};

const recordReadSpec: ReadLifecycleSpec<
  RecordReadCaseConfig,
  RecordReadLifecycleFixture,
  ProjectionBoundaryVerification,
  RecordReadPrimary
> = {
  prepareFixture: async ({ perfCase, context, config }) => {
    const prepareMeasurement = await measureAsync("prepare", () =>
      prepareRecordReadFixture(perfCase, context, config),
    );
    return Object.assign(prepareMeasurement.result, {
      prepareDurationMs: prepareMeasurement.durationMs,
    });
  },
  assertSeedReady: ({ fixture, config }) =>
    assertProjectionBoundary(fixture, config),
  runPrimary: async ({ perfCase, context, fixture, config }) => {
    let baselineMeasurement: Measurement<ReadPagedScanResult> | undefined;
    let baselineVerifyMeasurement:
      | Measurement<ReadPagedScanVerification>
      | undefined;

    if (config.queryVariant) {
      baselineMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        "getRecordsBaselinePagedScan",
        () =>
          measureAsync("getRecordsBaselinePagedScan", () =>
            readPagedScan(fixture, context, config),
          ),
      );
      baselineVerifyMeasurement = await measureAsync(
        "verifyBaselineReadPages",
        () =>
          Promise.resolve(
            verifyReadPagedScan(fixture, config, baselineMeasurement!.result),
          ),
      );
    }

    const readMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      config.threshold.metric,
      () =>
        measureAsync(config.threshold.metric, () =>
          readPagedScan(
            fixture,
            context,
            config,
            buildQueryVariant(fixture, config),
          ),
        ),
    );
    const verifyMeasurement = await measureAsync("verifyReadPages", () =>
      Promise.resolve(
        verifyReadPagedScan(fixture, config, readMeasurement.result),
      ),
    );

    return {
      readMeasurement,
      verifyMeasurement,
      baselineMeasurement,
      baselineVerifyMeasurement,
    };
  },
  buildResult: ({ config, fixture, seedReadyMeasurement, primary, error }) => {
    const prepareMeasurement = fixture
      ? {
          name: "prepare",
          durationMs: fixture.prepareDurationMs,
          result: fixture,
        }
      : undefined;
    return buildRecordReadResult({
      config,
      fixture,
      prepareMeasurement,
      seedReadyMeasurement,
      readMeasurement: primary?.readMeasurement,
      verifyMeasurement: primary?.verifyMeasurement,
      baselineMeasurement: primary?.baselineMeasurement,
      baselineVerifyMeasurement: primary?.baselineVerifyMeasurement,
      error,
    });
  },
  // Non-destructive read: drop the host + source tables unless the seed is a
  // reusable cached seed (the driver also short-circuits on the isolated CI DB).
  seedTableIds: (fixture) => [fixture.tableId, fixture.sourceTableId],
  isReusableSeed: (fixture) => fixture.reusableSeed,
};

export const runRecordReadCase = (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runReadLifecycle(perfCase, context, recordReadSpec);

export const seedRecordReadCase = (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedReadLifecycle(perfCase, context, recordReadSpec);
