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
import { chunk } from "../chunk";
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
import { forEachRecordPage } from "../record-page-scan";
import {
  collectSampleRecords,
  type SeededSampleRecord,
} from "../sample-records";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
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

const TAG_CHOICES = ["Alpha", "Beta", "Gamma", "Delta"];
const STATUS_CHOICES = ["Todo", "Doing", "Done"];

const FIELD_CONVERT_FIXTURE_VERSION = "field-convert-v1";

type NamedField = {
  id: string;
  name: string;
  type?: string;
  options?: unknown;
  isComputed?: boolean;
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
  convertedField: {
    id: string;
    name: string;
    type: string;
    optionNames?: string[];
    ratingMax?: number;
    isComputed?: boolean;
  };
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

const getSeedDateText = (rowNumber: number) =>
  new Date(
    Date.UTC(2026, 0, 1 + ((rowNumber - 1) % 365), 8, 30, 0),
  ).toISOString();

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
    case "Status":
      return STATUS_CHOICES[(rowNumber - 1) % STATUS_CHOICES.length];
    case "Amount":
      return rowNumber * 7;
    case "Active":
      return rowNumber % 2 === 1;
    case "Score":
      return ((rowNumber - 1) % 5) + 1;
    case "Description":
      return `${titlePrefix}-description-${rowNumber}\nline-2\nline-3`;
    case "Numeric Text":
      return rowNumber % 4 === 0
        ? "not-a-number"
        : (rowNumber * 1.25).toFixed(2);
    case "Select Text":
      return STATUS_CHOICES[(rowNumber - 1) % STATUS_CHOICES.length];
    case "Multi Text":
      return getSeedTags(rowNumber).join(", ");
    case "Truthy Text":
      return rowNumber % 2 === 1 ? `checked-${rowNumber}` : null;
    case "Date Text":
      return rowNumber % 2 === 1 ? getSeedDateText(rowNumber) : "not-a-date";
    case "Attachment Text":
      return `${titlePrefix}-attachment-${rowNumber}`;
    case "Sequence Text":
      return `${titlePrefix}-sequence-${rowNumber}`;
    case "Rating Input":
      return ((rowNumber - 1) % 8) + 1;
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
  titlePrefix: string,
): unknown => {
  switch (expected) {
    case "multiSelectJoinedText":
      return getSeedTags(rowNumber).join(", ");
    case "singleSelectText":
      return STATUS_CHOICES[(rowNumber - 1) % STATUS_CHOICES.length];
    case "numberText":
      return String(rowNumber * 7);
    case "checkboxText":
      return rowNumber % 2 === 1 ? "true" : null;
    case "ratingText":
      return String(((rowNumber - 1) % 5) + 1);
    case "longTextSingleLine":
      return `${titlePrefix}-description-${rowNumber} line-2 line-3`;
    case "textNumberMixed":
      return rowNumber % 4 === 0 ? null : Number((rowNumber * 1.25).toFixed(2));
    case "textSingleSelect":
      return STATUS_CHOICES[(rowNumber - 1) % STATUS_CHOICES.length];
    case "textMultipleSelect":
      return getSeedTags(rowNumber);
    case "textCheckboxMixed":
      return rowNumber % 2 === 1 ? true : null;
    case "textDateMixed":
      return rowNumber % 2 === 1 ? getSeedDateText(rowNumber) : null;
    case "clearedValues":
      return null;
    case "autoNumberSequence":
      return rowNumber;
    case "numberRatingClamped":
      return Math.min(((rowNumber - 1) % 8) + 1, 5);
    case "singleSelectChoicePruned":
      return STATUS_CHOICES[(rowNumber - 1) % STATUS_CHOICES.length] === "Todo"
        ? "Planned"
        : null;
    case "multipleSelectChoicePruned":
      return getSeedTags(rowNumber).includes("Alpha") ? ["Primary"] : null;
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
  if (expected == null) {
    return actual == null;
  }
  if (Array.isArray(expected)) {
    return JSON.stringify(expected) === JSON.stringify(actual);
  }
  if (expected === false && actual == null) {
    return true;
  }
  return expected === actual;
};

const convertedValuesMatch = (expected: unknown, actual: unknown) =>
  expected == null
    ? actual == null
    : Array.isArray(expected)
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : actual === expected;

const getConvertedOptionNames = (options: unknown) => {
  const choices = (options as { choices?: Array<{ name?: unknown }> } | null)
    ?.choices;
  return Array.isArray(choices)
    ? choices
        .map((choice) => choice.name)
        .filter((name): name is string => typeof name === "string")
    : undefined;
};

const getConvertedRatingMax = (options: unknown) => {
  const max = (options as { max?: unknown } | null)?.max;
  return typeof max === "number" ? max : undefined;
};

const assertConvertedFieldMetadata = (
  convertedField: NamedField,
  config: FieldConvertCaseConfig,
) => {
  if (convertedField.type !== config.convert.target.type) {
    throw new Error(
      `Converted field type mismatch: expected ${config.convert.target.type}, got ${convertedField.type}`,
    );
  }

  const optionNames = getConvertedOptionNames(convertedField.options);
  if (config.verify.targetOptionNames) {
    const expected = [...config.verify.targetOptionNames].sort();
    const actual = [...(optionNames ?? [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Converted field choices mismatch: expected ${expected.join(", ")}, actual ${actual.join(", ")}`,
      );
    }
  }

  const ratingMax = getConvertedRatingMax(convertedField.options);
  if (
    config.verify.targetRatingMax !== undefined &&
    ratingMax !== config.verify.targetRatingMax
  ) {
    throw new Error(
      `Converted field rating max mismatch: expected ${config.verify.targetRatingMax}, actual ${String(ratingMax)}`,
    );
  }

  if (
    config.verify.targetIsComputed !== undefined &&
    convertedField.isComputed !== config.verify.targetIsComputed
  ) {
    throw new Error(
      `Converted field computed flag mismatch: expected ${config.verify.targetIsComputed}, actual ${String(convertedField.isComputed)}`,
    );
  }

  return { optionNames, ratingMax };
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
    const createTableMeasurement = await measureAsync(
      seedCacheInfo.enabled ? "seedBuild" : "createTable",
      () =>
        createTable(baseId, {
          name: actualTableName,
          fields: config.fields,
          records: [],
        }),
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
            createRecords(createdTableId, {
              fieldKeyType: FieldKeyType.Name,
              typecast: true,
              records: batch.map((item) => item.record),
            }),
        );
        batchDurations.push(batchMeasurement.durationMs);
        expect(batchMeasurement.result.records).toHaveLength(batch.length);
        collectSampleRecords(
          sampleRecordByOffset,
          wantedSampleOffsets,
          batch,
          batchMeasurement.result.records,
        );
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
      config.generator.titlePrefix,
    );
    const actual = record.fields[convertedFieldId];
    if (!convertedValuesMatch(expected, actual)) {
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

  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.rowCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: [fixture.titleField.id, convertedFieldId],
          skip,
          take,
        }),
    },
    (record) => {
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
        config.generator.titlePrefix,
      );
      const actual = record.fields[convertedFieldId];
      if (!convertedValuesMatch(expected, actual)) {
        throw new Error(
          `Converted full scan mismatch at row ${rowNumber}: expected ${String(
            expected,
          )}, actual ${String(actual)}`,
        );
      }
    },
  );

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
  const convertedMetadata = assertConvertedFieldMetadata(
    convertedField,
    config,
  );

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
      optionNames: convertedMetadata.optionNames,
      ratingMax: convertedMetadata.ratingMax,
      isComputed: convertedField.isComputed,
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
  perfCase: PerfCaseFor<"field-convert">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedFieldConvertLifecycle(perfCase, context, fieldConvertLifecycleSpec);

export const runFieldConvertCase = async (
  perfCase: PerfCaseFor<"field-convert">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runFieldConvertLifecycle(perfCase, context, fieldConvertLifecycleSpec);
