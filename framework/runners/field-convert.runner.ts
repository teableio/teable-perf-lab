import { FieldKeyType } from "@teable/core";
import { convertField as apiConvertField } from "@teable/openapi";
import {
  createRecords,
  createTable,
  getFields,
  getRecord,
  getRecords,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs } from "../env";
import { measureAsync, roundMetric, type Measurement } from "../metrics";
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
import { pollUntilReady } from "../readiness";
import { withPerfTraceStep } from "../trace-collector";
import type {
  FieldConvertCaseConfig,
  FieldConvertExpectedKind,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  runFieldConvertLifecycle,
  seedFieldConvertLifecycle,
  type FieldConvertLifecycleSpec,
} from "./field-convert-lifecycle";

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const TAG_CHOICES = ["Alpha", "Beta", "Gamma", "Delta"];

const FIELD_CONVERT_FIXTURE_VERSION = "field-convert-v1";

type NamedField = { id: string; name: string; type?: string };

type SeededSampleRecord = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
};

type FieldConvertFixture = {
  tableId: string;
  tableName: string;
  fields: NamedField[];
  titleField: NamedField;
  sourceField: NamedField;
  sampleRecords: SeededSampleRecord[];
  batchDurations: number[];
  createTableMeasurement: Measurement<unknown>;
  seedMeasurement: Measurement<unknown>;
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
};

type ConvertPrimaryResult = {
  convertRequestMs: number;
  samplesReadyMs: number;
  fullScanReadyMs: number;
  convertedField: { id: string; name: string; type: string };
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
  verifiedSamples: Array<{
    rowOffset: number;
    rowNumber: number;
    recordId: string;
    actual: unknown;
    expected: unknown;
  }>;
  fullScan: {
    scannedRecords: number;
    pageSize: number;
    pageCount: number;
  };
};

// Seed values are derived from the row number only, so V1/V2 runs and reruns
// produce identical tables. A/B/C reuse the formula-table numeric scheme so
// the aTimesBPlusC expectation matches `({A} * {B}) + {C}`.
const getSeedNumbers = (rowNumber: number) => ({
  a: rowNumber,
  b: (rowNumber % 97) + 1,
  c: rowNumber % 13,
});

const getSeedTags = (rowNumber: number) => {
  const first = TAG_CHOICES[(rowNumber - 1) % TAG_CHOICES.length];
  const second = TAG_CHOICES[rowNumber % TAG_CHOICES.length];
  return first === second ? [first] : [first, second];
};

const buildSeedValue = (
  fieldName: string,
  rowNumber: number,
  titlePrefix: string,
): unknown => {
  const { a, b, c } = getSeedNumbers(rowNumber);
  switch (fieldName) {
    case "Title":
      return `${titlePrefix} ${rowNumber}`;
    case "A":
      return a;
    case "B":
      return b;
    case "C":
      return c;
    case "Tags":
      return getSeedTags(rowNumber);
    case "Total":
      return `${titlePrefix}-total-${rowNumber}`;
    default:
      throw new Error(
        `field-convert generator has no seed value for field ${fieldName}`,
      );
  }
};

const getExpectedConvertedValue = (
  expected: FieldConvertExpectedKind,
  rowNumber: number,
): string | number => {
  switch (expected) {
    case "multiSelectJoinedText":
      return getSeedTags(rowNumber).join(", ");
    case "aTimesBPlusC": {
      const { a, b, c } = getSeedNumbers(rowNumber);
      return a * b + c;
    }
    default:
      throw new Error(
        `Unsupported field-convert expected kind: ${String(expected)}`,
      );
  }
};

const seedValuesMatch = (expected: unknown, actual: unknown) => {
  if (Array.isArray(expected)) {
    return JSON.stringify(expected) === JSON.stringify(actual);
  }
  return expected === actual;
};

const parseTitleRowNumber = (value: unknown, titlePrefix: string) => {
  if (typeof value !== "string") {
    throw new Error(`Expected Title to be a string, got ${String(value)}`);
  }

  const prefix = `${titlePrefix} `;
  const rowNumber = Number(value.slice(prefix.length));
  if (!value.startsWith(prefix) || !Number.isInteger(rowNumber)) {
    throw new Error(`Expected ${value} to match "${prefix}<rowNumber>"`);
  }

  return rowNumber;
};

const pickResponseHeaders = pickRoutingResponseHeaders;

const assertExpectedRouting = (
  context: PerfRunContext,
  responseHeaders: Record<string, string>,
) =>
  assertEngineRouting(context, responseHeaders, {
    operation: "Field convert",
  });

const resolveNamedField = (fields: NamedField[], fieldName: string) => {
  const field = fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw new Error(
      `Missing field ${fieldName}; available fields: ${fields
        .map(({ name }) => name)
        .join(", ")}`,
    );
  }
  return field;
};

const compileExpression = (expression: string, fields: NamedField[]) => {
  const fieldIdByName = new Map(fields.map((field) => [field.name, field.id]));
  return expression.replace(/\{([^}]+)\}/g, (match, fieldName: string) => {
    const fieldId = fieldIdByName.get(fieldName);
    return fieldId ? `{${fieldId}}` : match;
  });
};

const buildConvertFieldRo = (
  config: FieldConvertCaseConfig,
  fields: NamedField[],
) => {
  const { target } = config.convert;
  const options = target.options ? { ...target.options } : undefined;
  if (options && typeof options.expression === "string") {
    options.expression = compileExpression(options.expression, fields);
  }
  return {
    type: target.type,
    name: config.convert.sourceFieldName,
    ...(options ? { options } : {}),
  };
};

const getFieldConvertSeedConfig = (config: FieldConvertCaseConfig) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  fields: config.fields,
  generator: config.generator,
  sourceFieldName: config.convert.sourceFieldName,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: FIELD_CONVERT_FIXTURE_VERSION,
});

const getCachedSampleRecords = async (
  tableId: string,
  titleField: NamedField,
  config: FieldConvertCaseConfig,
): Promise<SeededSampleRecord[]> => {
  const sampleRecords: SeededSampleRecord[] = [];
  for (const rowOffset of config.verify.sampleRows) {
    const expectedRowNumber = rowOffset + 1;
    const result = await getRecords(tableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [titleField.id],
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(
        `Missing cached seed sample at row offset ${rowOffset}; rowCount=${config.rowCount}`,
      );
    }
    const rowNumber = parseTitleRowNumber(
      record.fields[titleField.id],
      config.generator.titlePrefix,
    );
    if (rowNumber !== expectedRowNumber) {
      throw new Error(
        `Cached seed sample row mismatch: expected row ${expectedRowNumber}, got ${rowNumber}`,
      );
    }
    sampleRecords.push({ rowOffset, rowNumber, recordId: record.id });
  }
  return sampleRecords;
};

const createEmptyMeasurement = <T>(
  name: string,
  result: T,
): Measurement<T> => ({
  name,
  durationMs: 0,
  result,
});

// The measured conversion rewrites the source column in place, so a cached
// seed table cannot be restored cheaply after execute. Instead the cache
// relies on the same contract as field-delete: CI execute jobs run on a
// disposable restored copy of the seed database, and local runs delete the
// mutated table so the next run reseeds it.
const prepareFieldConvertFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  tableName: string,
  config: FieldConvertCaseConfig,
): Promise<FieldConvertFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "field-convert",
    fixtureVersion: FIELD_CONVERT_FIXTURE_VERSION,
    seedConfig: getFieldConvertSeedConfig(config) as never,
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
      const tableFields = (await getFields(cachedTable.id)) as NamedField[];
      const titleField = resolveNamedField(tableFields, "Title");
      const sourceField = resolveNamedField(
        tableFields,
        config.convert.sourceFieldName,
      );
      const expectedSourceType = config.fields.find(
        (field) => field.name === config.convert.sourceFieldName,
      )?.type;
      if (sourceField.type !== expectedSourceType) {
        throw new Error(
          `Cached seed source field ${config.convert.sourceFieldName} has type ${sourceField.type}, expected ${expectedSourceType} (leftover converted column?)`,
        );
      }
      const fixture: FieldConvertFixture = {
        tableId: cachedTable.id,
        tableName: cachedTable.name,
        fields: tableFields,
        titleField,
        sourceField,
        sampleRecords: await getCachedSampleRecords(
          cachedTable.id,
          titleField,
          config,
        ),
        batchDurations: [0],
        createTableMeasurement: createEmptyMeasurement("seedRestore", {
          id: cachedTable.id,
        }),
        seedMeasurement: createEmptyMeasurement("seedBuildSkipped", undefined),
        seedCacheInfo,
        seedCacheHit: true,
        reusableSeed: true,
      };
      await assertSeedSamples(fixture, config);
      return fixture;
    } catch (error) {
      console.warn(
        `Invalid cached field convert seed ${seedCacheInfo.seedTableName}; rebuilding`,
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
    const createTableMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      seedCacheInfo.enabled ? "seedBuild:createTable" : "createTable",
      () =>
        measureAsync(seedCacheInfo.enabled ? "seedBuild" : "createTable", () =>
          createTable(baseId, {
            name: actualTableName,
            fields: config.fields,
            records: [],
          }),
        ),
    );
    createdTableId = createTableMeasurement.result.id;
    const tableFields = (await getFields(createdTableId)) as NamedField[];
    const titleField = resolveNamedField(tableFields, "Title");
    const sourceField = resolveNamedField(
      tableFields,
      config.convert.sourceFieldName,
    );

    const records = Array.from({ length: config.rowCount }, (_, index) => {
      const rowNumber = index + 1;
      return {
        rowOffset: index,
        rowNumber,
        record: {
          fields: Object.fromEntries(
            config.fields.map((field) => [
              field.name,
              buildSeedValue(
                field.name,
                rowNumber,
                config.generator.titlePrefix,
              ),
            ]),
          ),
        },
      };
    });
    const batches = chunk(records, config.batchSize);
    const batchDurations: number[] = [];
    const wantedSampleOffsets = new Set(config.verify.sampleRows);
    const sampleRecordByOffset = new Map<number, SeededSampleRecord>();

    const seedMeasurement = await measureAsync("seedRecords", async () => {
      for (const [batchIndex, batch] of batches.entries()) {
        const batchMeasurement = await measureAsync(
          `seedBatch:${batchIndex + 1}`,
          () =>
            withPerfTraceStep(
              context,
              perfCase,
              `seedBatch:${batchIndex + 1}`,
              () =>
                createRecords(createdTableId, {
                  fieldKeyType: FieldKeyType.Name,
                  typecast: true,
                  records: batch.map((item) => item.record),
                }),
            ),
        );
        batchDurations.push(batchMeasurement.durationMs);
        expect(batchMeasurement.result.records).toHaveLength(batch.length);
        batchMeasurement.result.records.forEach((record, index) => {
          const input = batch[index];
          if (input && wantedSampleOffsets.has(input.rowOffset)) {
            sampleRecordByOffset.set(input.rowOffset, {
              rowOffset: input.rowOffset,
              rowNumber: input.rowNumber,
              recordId: record.id,
            });
          }
        });
      }
    });

    const sampleRecords = config.verify.sampleRows.map((rowOffset) => {
      const sampleRecord = sampleRecordByOffset.get(rowOffset);
      if (!sampleRecord) {
        throw new Error(
          `Missing seeded sample record for row offset ${rowOffset}; rowCount=${config.rowCount}`,
        );
      }
      return sampleRecord;
    });

    return {
      tableId: createdTableId,
      tableName: actualTableName,
      fields: tableFields,
      titleField,
      sourceField,
      sampleRecords,
      batchDurations,
      createTableMeasurement,
      seedMeasurement,
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
          `Failed to cleanup incomplete field convert seed ${createdTableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const assertSeedSamples = async (
  fixture: FieldConvertFixture,
  config: FieldConvertCaseConfig,
) => {
  const verifiedSamples = [];

  for (const sampleRecord of fixture.sampleRecords) {
    const record = await getRecord(fixture.tableId, sampleRecord.recordId);
    if (!record) {
      throw new Error(
        `Missing seed sample record ${sampleRecord.recordId} at row ${sampleRecord.rowNumber}`,
      );
    }

    const expectedTitle = buildSeedValue(
      "Title",
      sampleRecord.rowNumber,
      config.generator.titlePrefix,
    );
    const expectedSource = buildSeedValue(
      config.convert.sourceFieldName,
      sampleRecord.rowNumber,
      config.generator.titlePrefix,
    );
    const actualTitle = record.fields[fixture.titleField.id];
    const actualSource = record.fields[fixture.sourceField.id];

    if (actualTitle !== expectedTitle) {
      throw new Error(
        `Seed sample Title mismatch at row ${sampleRecord.rowNumber}: expected ${String(
          expectedTitle,
        )}, actual ${String(actualTitle)}`,
      );
    }
    if (!seedValuesMatch(expectedSource, actualSource)) {
      throw new Error(
        `Seed sample ${config.convert.sourceFieldName} mismatch at row ${sampleRecord.rowNumber}: expected ${JSON.stringify(
          expectedSource,
        )}, actual ${JSON.stringify(actualSource)}`,
      );
    }

    verifiedSamples.push({
      rowOffset: sampleRecord.rowOffset,
      rowNumber: sampleRecord.rowNumber,
      recordId: sampleRecord.recordId,
      actualSource,
      expectedSource,
    });
  }

  const lastPage = await getRecords(fixture.tableId, {
    fieldKeyType: FieldKeyType.Id,
    projection: [fixture.titleField.id],
    skip: config.rowCount - 1,
    take: 1,
  });
  const lastRecord = lastPage.records[0];
  if (!lastRecord) {
    throw new Error(`Missing final seed row at offset ${config.rowCount - 1}`);
  }
  const lastRowNumber = parseTitleRowNumber(
    lastRecord.fields[fixture.titleField.id],
    config.generator.titlePrefix,
  );
  if (lastRowNumber !== config.rowCount) {
    throw new Error(
      `Final seed row mismatch: expected row ${config.rowCount}, got ${lastRowNumber}`,
    );
  }

  const beyondLastPage = await getRecords(fixture.tableId, {
    fieldKeyType: FieldKeyType.Id,
    projection: [fixture.titleField.id],
    skip: config.rowCount,
    take: 1,
  });
  if (beyondLastPage.records.length !== 0) {
    throw new Error(
      `Seed table has extra rows after expected rowCount=${config.rowCount}`,
    );
  }

  return verifiedSamples;
};

const assertConvertedSamples = async (
  fixture: FieldConvertFixture,
  config: FieldConvertCaseConfig,
  convertedFieldId: string,
) => {
  const verifiedSamples = [];

  for (const sampleRecord of fixture.sampleRecords) {
    const record = await getRecord(fixture.tableId, sampleRecord.recordId);
    if (!record) {
      throw new Error(
        `Missing converted sample record ${sampleRecord.recordId} at row ${sampleRecord.rowNumber}`,
      );
    }

    const expected = getExpectedConvertedValue(
      config.convert.expected,
      sampleRecord.rowNumber,
    );
    const actual = record.fields[convertedFieldId];
    if (actual !== expected) {
      throw new Error(
        `Converted sample mismatch at row ${sampleRecord.rowNumber}: expected ${String(
          expected,
        )}, actual ${String(actual)}`,
      );
    }

    verifiedSamples.push({
      rowOffset: sampleRecord.rowOffset,
      rowNumber: sampleRecord.rowNumber,
      recordId: sampleRecord.recordId,
      actual,
      expected,
    });
  }

  return verifiedSamples;
};

const waitForConvertedSamples = (
  fixture: FieldConvertFixture,
  config: FieldConvertCaseConfig,
  convertedFieldId: string,
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 30_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 200,
      description: "converted samples",
    },
    () => assertConvertedSamples(fixture, config, convertedFieldId),
  );

const assertConvertedFullScan = async (
  fixture: FieldConvertFixture,
  config: FieldConvertCaseConfig,
  convertedFieldId: string,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const seenRowNumbers = new Set<number>();
  let scannedRecords = 0;
  let pageCount = 0;

  for (let skip = 0; skip < config.rowCount; skip += pageSize) {
    const expectedTake = Math.min(pageSize, config.rowCount - skip);
    const result = await getRecords(fixture.tableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [fixture.titleField.id, convertedFieldId],
      skip,
      take: expectedTake,
    });
    pageCount += 1;

    if (result.records.length !== expectedTake) {
      throw new Error(
        `Expected ${expectedTake} records at skip ${skip}, got ${result.records.length}`,
      );
    }

    for (const record of result.records) {
      const rowNumber = parseTitleRowNumber(
        record.fields[fixture.titleField.id],
        config.generator.titlePrefix,
      );
      if (seenRowNumbers.has(rowNumber)) {
        throw new Error(
          `Duplicate row number in converted full scan: ${rowNumber}`,
        );
      }
      seenRowNumbers.add(rowNumber);

      const expected = getExpectedConvertedValue(
        config.convert.expected,
        rowNumber,
      );
      const actual = record.fields[convertedFieldId];
      if (actual !== expected) {
        throw new Error(
          `Converted full scan mismatch at row ${rowNumber}: expected ${String(
            expected,
          )}, actual ${String(actual)}`,
        );
      }
      scannedRecords += 1;
    }
  }

  if (scannedRecords !== config.rowCount) {
    throw new Error(
      `Converted full scan record count mismatch: expected ${config.rowCount}, scanned ${scannedRecords}`,
    );
  }

  return { scannedRecords, pageSize, pageCount };
};

const waitForConvertedFullScan = (
  fixture: FieldConvertFixture,
  config: FieldConvertCaseConfig,
  convertedFieldId: string,
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 30_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 200,
      description: "converted full scan",
    },
    () => assertConvertedFullScan(fixture, config, convertedFieldId),
  );

const runFieldConvertPrimary = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: FieldConvertFixture,
  config: FieldConvertCaseConfig,
): Promise<ConvertPrimaryResult> => {
  const convertRo = buildConvertFieldRo(config, fixture.fields);
  const convertMeasurement = await measureAsync("convertRequest", () =>
    withPerfTraceStep(context, perfCase, config.threshold.metric, () =>
      apiConvertField(
        fixture.tableId,
        fixture.sourceField.id,
        convertRo as Parameters<typeof apiConvertField>[2],
      ),
    ),
  );
  const response = convertMeasurement.result;
  expect(response.status).toBe(200);

  const responseHeaders = pickResponseHeaders(
    response.headers as Record<string, unknown>,
  );
  const routing = assertExpectedRouting(context, responseHeaders);

  const convertedField = response.data;
  if (convertedField.type !== config.convert.target.type) {
    throw new Error(
      `Converted field type mismatch: expected ${config.convert.target.type}, got ${convertedField.type}`,
    );
  }

  const samplesMeasurement = await measureAsync("convertedSamplesReady", () =>
    waitForConvertedSamples(fixture, config, convertedField.id),
  );
  const fullScanMeasurement = await measureAsync("convertedFullScanReady", () =>
    waitForConvertedFullScan(fixture, config, convertedField.id),
  );

  return {
    convertRequestMs: convertMeasurement.durationMs,
    samplesReadyMs: samplesMeasurement.durationMs,
    fullScanReadyMs: fullScanMeasurement.durationMs,
    convertedField: {
      id: convertedField.id,
      name: convertedField.name,
      type: convertedField.type,
    },
    responseHeaders,
    routing,
    verifiedSamples: samplesMeasurement.result,
    fullScan: fullScanMeasurement.result,
  };
};

const buildFieldConvertResult = ({
  config,
  fixture,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  config: FieldConvertCaseConfig;
  fixture?: FieldConvertFixture;
  seedReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertSeedSamples>>
  >;
  primaryMeasurement?: Measurement<ConvertPrimaryResult>;
  error?: unknown;
}): PerfRunResult => {
  const primaryResult = primaryMeasurement?.result;

  return {
    metrics: {
      ...(fixture
        ? {
            createTableMs: fixture.createTableMeasurement.durationMs,
            seedRecordsMs: fixture.seedMeasurement.durationMs,
            maxSeedBatchMs: roundMetric(Math.max(...fixture.batchDurations)),
            seedCacheHit: fixture.seedCacheHit ? 1 : 0,
            seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
            ...(fixture.seedCacheHit
              ? { seedRestoreMs: fixture.createTableMeasurement.durationMs }
              : fixture.seedCacheInfo.enabled
                ? {
                    seedBuildMs: roundMetric(
                      fixture.createTableMeasurement.durationMs +
                        fixture.seedMeasurement.durationMs,
                    ),
                  }
                : {}),
          }
        : {}),
      ...(seedReadyMeasurement
        ? { seedReadyMs: seedReadyMeasurement.durationMs }
        : {}),
      ...(primaryMeasurement
        ? {
            [config.threshold.metric]: primaryMeasurement.durationMs,
            convertRequestMs: primaryMeasurement.result.convertRequestMs,
            convertedSamplesReadyMs: primaryMeasurement.result.samplesReadyMs,
            convertedFullScanReadyMs: primaryMeasurement.result.fullScanReadyMs,
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
      ...(fixture
        ? [
            {
              name: fixture.createTableMeasurement.name,
              durationMs: fixture.createTableMeasurement.durationMs,
            },
            {
              name: fixture.seedMeasurement.name,
              durationMs: fixture.seedMeasurement.durationMs,
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
      ...(primaryMeasurement
        ? [
            {
              name: primaryMeasurement.name,
              durationMs: primaryMeasurement.durationMs,
            },
          ]
        : []),
    ],
    details: {
      operation: "field-convert",
      tableId: fixture?.tableId,
      tableName: fixture?.tableName,
      rowCount: config.rowCount,
      batchSize: config.batchSize,
      fields: fixture?.fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
      })),
      convert: {
        sourceFieldName: config.convert.sourceFieldName,
        sourceFieldId: fixture?.sourceField.id,
        targetType: config.convert.target.type,
        targetOptions: config.convert.target.options,
        expected: config.convert.expected,
      },
      convertedField: primaryResult?.convertedField,
      responseHeaders: primaryResult?.responseHeaders,
      routing: primaryResult?.routing,
      seed: fixture
        ? {
            seededRecords: config.rowCount,
            batchCount: fixture.batchDurations.length,
            ready: seedReadyMeasurement?.result,
            cache: {
              enabled: fixture.seedCacheInfo.enabled,
              cacheHit: fixture.seedCacheHit,
              reusable: fixture.reusableSeed,
              seedHash: fixture.seedCacheInfo.seedHash,
              seedHashShort: fixture.seedCacheInfo.seedHashShort,
              seedTableName: fixture.seedCacheInfo.seedTableName,
              schemaSignature: fixture.seedCacheInfo.schemaSignature,
            },
          }
        : undefined,
      verifiedSamples: primaryResult?.verifiedSamples,
      fullScan: primaryResult?.fullScan,
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

const cleanupFieldConvertFixture = async ({
  baseId,
  fixture,
}: {
  baseId: string;
  fixture: FieldConvertFixture;
}) => {
  try {
    await permanentDeleteTable(baseId, fixture.tableId);
  } catch (error) {
    console.warn(
      `Failed to cleanup perf field convert table ${fixture.tableId}`,
      error,
    );
  }
};

const fieldConvertLifecycleSpec: FieldConvertLifecycleSpec<
  FieldConvertCaseConfig,
  FieldConvertFixture,
  Awaited<ReturnType<typeof assertSeedSamples>>,
  ConvertPrimaryResult
> = {
  prepareFixture: ({ perfCase, context, baseId, tableName, config }) =>
    prepareFieldConvertFixture(perfCase, context, baseId, tableName, config),
  assertSeedReady: ({ fixture, config }) => assertSeedSamples(fixture, config),
  runPrimary: ({ perfCase, context, fixture, config }) =>
    runFieldConvertPrimary(perfCase, context, fixture, config),
  buildResult: buildFieldConvertResult,
  cleanupConvertedFixture: cleanupFieldConvertFixture,
};

export const seedFieldConvertCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedFieldConvertLifecycle(perfCase, context, fieldConvertLifecycleSpec);

export const runFieldConvertCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runFieldConvertLifecycle(perfCase, context, fieldConvertLifecycleSpec);
