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
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, roundMetric } from "../metrics";
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
import { PerfRunDiagnosticError } from "../types";

type Measurement<T> = {
  name: string;
  durationMs: number;
  result: T;
};

type ResolvedField = {
  id: string;
  name: string;
  type?: string;
};

type SeededSampleRecord = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
};

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
  routing: {
    requestedEngine: string;
    expectedXTeableV2: string;
    actualXTeableV2: string;
    routeMatched: boolean;
    xTeableV2Feature: string;
    xTeableV2Reason: string;
  };
};

type ReadPagedScanResult = {
  pages: ReadPageResult[];
  records: Array<{ id: string; fields: Record<string, unknown> }>;
};

type ReadPagedScanVerification = {
  scannedRecords: number;
  expectedRecords: number;
  pageSize: number;
  pageCount: number;
  fieldCount: number;
  projectionFieldCount: number;
  verifiedSamples: PageSampleVerification[];
};

const RECORD_READ_FIXTURE_VERSION = "record-read-v1";
const SOURCE_KEY_FIELD_NAME = "Source Key";
const HOST_LOOKUP_KEY_FIELD_NAME = "Lookup Source Key";
const BASE_NUMBER_FIELDS = ["A", "B", "C"] as const;

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sourceValueName = (index: number) => `Source Value ${index}`;
const hostTextName = (index: number) => `Text ${index}`;
const formulaName = (index: number) => `Formula ${index}`;
const lookupName = (index: number) => `Lookup Value ${index}`;

const getSourceValueNames = (config: RecordReadCaseConfig) =>
  Array.from({ length: config.lookupFieldCount }, (_, index) =>
    sourceValueName(index + 1),
  );

const getHostTextNames = (config: RecordReadCaseConfig) =>
  Array.from({ length: config.simpleTextFieldCount }, (_, index) =>
    hostTextName(index + 1),
  );

const getFormulaNames = (config: RecordReadCaseConfig) =>
  Array.from({ length: config.formulaFieldCount }, (_, index) =>
    formulaName(index + 1),
  );

const getLookupNames = (config: RecordReadCaseConfig) =>
  Array.from({ length: config.lookupFieldCount }, (_, index) =>
    lookupName(index + 1),
  );

const getSourceFieldNames = (config: RecordReadCaseConfig) => [
  SOURCE_KEY_FIELD_NAME,
  ...getSourceValueNames(config),
];

const getHostBaseFieldNames = (config: RecordReadCaseConfig) => [
  "Title",
  HOST_LOOKUP_KEY_FIELD_NAME,
  ...BASE_NUMBER_FIELDS,
  ...getHostTextNames(config),
];

const getProjectionFieldNames = (config: RecordReadCaseConfig) => [
  ...getHostBaseFieldNames(config),
  ...getFormulaNames(config),
  ...getLookupNames(config),
];

const gcd = (left: number, right: number): number =>
  right === 0 ? Math.abs(left) : gcd(right, left % right);

const assertConfigShape = (config: RecordReadCaseConfig) => {
  const projectionFieldCount = getProjectionFieldNames(config).length;
  if (projectionFieldCount !== 50) {
    throw new Error(
      `record-read case must project exactly 50 fields, got ${projectionFieldCount}`,
    );
  }
  if (config.pageSize > 1_000) {
    throw new Error(
      `record-read pageSize ${config.pageSize} exceeds the getRecords max of 1000`,
    );
  }
  if (config.rowCount % config.pageSize !== 0) {
    throw new Error(
      `record-read rowCount=${config.rowCount} must be divisible by pageSize=${config.pageSize}`,
    );
  }
  if (gcd(config.generator.permutation.multiplier, config.rowCount) !== 1) {
    throw new Error(
      `record-read permutation multiplier ${config.generator.permutation.multiplier} must be coprime with rowCount=${config.rowCount}`,
    );
  }
};

const getSourceRowNumberForHostRow = (
  hostRowNumber: number,
  config: RecordReadCaseConfig,
) =>
  (((hostRowNumber - 1) * config.generator.permutation.multiplier +
    config.generator.permutation.offset) %
    config.rowCount) +
  1;

const getSourceKey = (rowNumber: number, config: RecordReadCaseConfig) =>
  `${config.generator.sourceKeyPrefix}-${padRowNumber(rowNumber)}`;

const getSourceValue = (
  rowNumber: number,
  sourceValueIndex: number,
  config: RecordReadCaseConfig,
) =>
  `${config.generator.sourceValuePrefix}-${sourceValueIndex}-${padRowNumber(
    rowNumber,
  )}`;

const getHostTextValue = (
  rowNumber: number,
  textIndex: number,
  config: RecordReadCaseConfig,
) => `${config.generator.textPrefix}-${textIndex}-${padRowNumber(rowNumber)}`;

const getBaseNumberValue = (
  fieldName: (typeof BASE_NUMBER_FIELDS)[number],
  rowNumber: number,
) => {
  switch (fieldName) {
    case "A":
      return rowNumber;
    case "B":
      return ((rowNumber - 1) % 100) + 1;
    case "C":
      return ((rowNumber - 1) % 7) + 1;
  }
};

const getFormulaExpression = (formulaIndex: number) => {
  switch (formulaIndex) {
    case 1:
      return "{A} + {B} + {C}";
    case 2:
      return "({A} * {C}) + {B}";
    case 3:
      return "{A} + ({B} * {C})";
    case 4:
      return "({A} * 3) + ({B} * 5) + ({C} * 7)";
    case 5:
      return "({A} * {B}) + {C}";
    default:
      throw new Error(`Unsupported record-read formula index ${formulaIndex}`);
  }
};

const getFormulaExpectedValue = (formulaIndex: number, rowNumber: number) => {
  const A = getBaseNumberValue("A", rowNumber);
  const B = getBaseNumberValue("B", rowNumber);
  const C = getBaseNumberValue("C", rowNumber);
  switch (formulaIndex) {
    case 1:
      return A + B + C;
    case 2:
      return A * C + B;
    case 3:
      return A + B * C;
    case 4:
      return A * 3 + B * 5 + C * 7;
    case 5:
      return A * B + C;
    default:
      throw new Error(`Unsupported record-read formula index ${formulaIndex}`);
  }
};

const buildSourceRecordFields = (
  rowNumber: number,
  config: RecordReadCaseConfig,
) => {
  const fields: Record<string, unknown> = {
    [SOURCE_KEY_FIELD_NAME]: getSourceKey(rowNumber, config),
  };
  for (let index = 1; index <= config.lookupFieldCount; index += 1) {
    fields[sourceValueName(index)] = getSourceValue(rowNumber, index, config);
  }
  return fields;
};

const buildHostRecordFields = (
  rowNumber: number,
  config: RecordReadCaseConfig,
) => {
  const sourceRowNumber = getSourceRowNumberForHostRow(rowNumber, config);
  const fields: Record<string, unknown> = {
    Title: `${config.generator.titlePrefix}-${padRowNumber(rowNumber)}`,
    [HOST_LOOKUP_KEY_FIELD_NAME]: getSourceKey(sourceRowNumber, config),
  };
  for (const fieldName of BASE_NUMBER_FIELDS) {
    fields[fieldName] = getBaseNumberValue(fieldName, rowNumber);
  }
  for (let index = 1; index <= config.simpleTextFieldCount; index += 1) {
    fields[hostTextName(index)] = getHostTextValue(rowNumber, index, config);
  }
  return fields;
};

const getExpectedValue = (
  fieldName: string,
  rowNumber: number,
  config: RecordReadCaseConfig,
) => {
  if (fieldName === "Title") {
    return `${config.generator.titlePrefix}-${padRowNumber(rowNumber)}`;
  }
  if (fieldName === HOST_LOOKUP_KEY_FIELD_NAME) {
    return getSourceKey(
      getSourceRowNumberForHostRow(rowNumber, config),
      config,
    );
  }
  if ((BASE_NUMBER_FIELDS as readonly string[]).includes(fieldName)) {
    return getBaseNumberValue(
      fieldName as (typeof BASE_NUMBER_FIELDS)[number],
      rowNumber,
    );
  }
  const textMatch = fieldName.match(/^Text (\d+)$/);
  if (textMatch) {
    return getHostTextValue(rowNumber, Number(textMatch[1]), config);
  }
  const formulaMatch = fieldName.match(/^Formula (\d+)$/);
  if (formulaMatch) {
    return getFormulaExpectedValue(Number(formulaMatch[1]), rowNumber);
  }
  const lookupMatch = fieldName.match(/^Lookup Value (\d+)$/);
  if (lookupMatch) {
    const sourceRowNumber = getSourceRowNumberForHostRow(rowNumber, config);
    return [getSourceValue(sourceRowNumber, Number(lookupMatch[1]), config)];
  }
  throw new Error(`No expected value rule for record-read field ${fieldName}`);
};

const valuesMatch = (expected: unknown, actual: unknown) => {
  if (typeof expected === "number") {
    return Number(actual) === expected;
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
};

const parseRowNumberFromTitle = (
  value: unknown,
  config: RecordReadCaseConfig,
) => {
  if (typeof value !== "string") {
    throw new Error(`Expected string title value, got ${String(value)}`);
  }
  const prefix = `${config.generator.titlePrefix}-`;
  if (!value.startsWith(prefix)) {
    throw new Error(`Unexpected title value ${value}`);
  }
  const rowNumber = Number(value.slice(prefix.length));
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error(`Could not parse row number from title ${value}`);
  }
  return rowNumber;
};

const resolveFieldIds = (
  fields: Array<{ id: string; name: string; type?: string }>,
  requiredNames: string[],
  tableId: string,
) => {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  const missing = requiredNames.filter((name) => !fieldByName.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Missing fields on ${tableId}: ${missing.join(
        ", ",
      )}; available=${fields.map((field) => field.name).join(", ")}`,
    );
  }
  return new Map(
    requiredNames.map((name) => {
      const field = fieldByName.get(name)!;
      return [name, field.id];
    }),
  );
};

const compileExpression = (
  expression: string,
  fieldIdByName: Map<string, string>,
) =>
  expression.replace(/\{([^}]+)\}/g, (match, fieldName: string) => {
    const fieldId = fieldIdByName.get(fieldName);
    return fieldId ? `{${fieldId}}` : match;
  });

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

const assertExpectedRouting = (
  context: PerfRunContext,
  responseHeaders: Record<string, string>,
) => {
  const expectedXTeableV2 = context.engine === "v2" ? "true" : "false";
  const actualXTeableV2 = responseHeaders["x-teable-v2"];
  if (actualXTeableV2 !== expectedXTeableV2) {
    throw new Error(
      `getRecords did not use expected ${context.engine.toUpperCase()} route; expected x-teable-v2=${expectedXTeableV2}, got ${actualXTeableV2}; headers=${JSON.stringify(
        responseHeaders,
      )}`,
    );
  }

  return {
    requestedEngine: context.engine,
    expectedXTeableV2,
    actualXTeableV2,
    routeMatched: true,
    xTeableV2Feature: responseHeaders["x-teable-v2-feature"],
    xTeableV2Reason: responseHeaders["x-teable-v2-reason"],
  };
};

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
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
};

const buildSourceFields = (config: RecordReadCaseConfig) =>
  getSourceFieldNames(config).map((name) => ({
    name,
    type: FieldType.SingleLineText,
  }));

const buildHostBaseFields = (config: RecordReadCaseConfig) => [
  { name: "Title", type: FieldType.SingleLineText },
  { name: HOST_LOOKUP_KEY_FIELD_NAME, type: FieldType.SingleLineText },
  ...BASE_NUMBER_FIELDS.map((name) => ({ name, type: FieldType.Number })),
  ...getHostTextNames(config).map((name) => ({
    name,
    type: FieldType.SingleLineText,
  })),
];

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
        batchMeasurement.result.records.forEach((record, index) => {
          const input = batch[index];
          if (input && wantedSampleOffsets.has(input.rowOffset)) {
            sampleByOffset.set(input.rowOffset, {
              rowOffset: input.rowOffset,
              rowNumber: input.rowNumber,
              recordId: record.id,
            });
          }
        });
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
        `seedBuild:createFormulaField:${index}`,
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
        `seedBuild:createLookupField:${index}`,
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

const waitForProjectionFullScan = async (
  fixture: Pick<
    RecordReadFixture,
    "tableId" | "viewId" | "fields" | "projection"
  >,
  config: RecordReadCaseConfig,
) => {
  const startedAt = Date.now();
  const timeoutMs = config.verify.timeoutMs ?? 120_000;
  const pollIntervalMs = config.verify.pollIntervalMs ?? 1_000;
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await assertProjectionFullScan(fixture, config);
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for record-read projection after ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

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
            fields: buildSourceFields(config),
            records: [],
          });
          createdTableIds.push(sourceTable.id);
          const hostTable = await createTable(baseId, {
            name: tableName,
            fields: buildHostBaseFields(config),
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

const prepareFixture = async (
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
): Promise<ReadPageResult> => {
  const response = await apiGetRecords(fixture.tableId, {
    viewId: fixture.viewId,
    fieldKeyType: FieldKeyType.Id,
    projection: fixture.projection,
    skip,
    take: config.pageSize,
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
): Promise<ReadPagedScanResult> => {
  const pages: ReadPageResult[] = [];

  for (
    let skip = config.skip;
    skip < config.rowCount;
    skip += config.pageSize
  ) {
    pages.push(await readPage(fixture, context, config, skip));
  }

  return {
    pages,
    records: pages.flatMap((page) => page.records),
  };
};

const verifyReadPagedScan = (
  fixture: RecordReadFixture,
  config: RecordReadCaseConfig,
  readResult: ReadPagedScanResult,
): ReadPagedScanVerification => {
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
    if (page.records.length !== config.pageSize) {
      throw new Error(
        `Expected getRecords page ${pageIndex + 1} to return ${config.pageSize} records, got ${page.records.length}`,
      );
    }
  });

  const verifiedSamples = verifyRecords(
    readResult.records,
    fixture.fields,
    config,
    config.rowCount,
    config.verify.sampleRows,
  );
  return {
    scannedRecords: readResult.records.length,
    expectedRecords: config.rowCount,
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
  error,
}: {
  config: RecordReadCaseConfig;
  fixture?: RecordReadFixture;
  prepareMeasurement?: Measurement<RecordReadFixture>;
  seedReadyMeasurement?: Measurement<ProjectionScanVerification>;
  readMeasurement?: Measurement<ReadPagedScanResult>;
  verifyMeasurement?: Measurement<ReadPagedScanVerification>;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    ...(prepareMeasurement ? { prepareMs: prepareMeasurement.durationMs } : {}),
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
    ...(readMeasurement
      ? {
          [config.threshold.metric]: readMeasurement.durationMs,
          returnedRecords: readMeasurement.result.records.length,
          requestCount: readMeasurement.result.pages.length,
          responseStatus: readMeasurement.result.pages.at(-1)?.status ?? 0,
        }
      : {}),
    ...(verifyMeasurement
      ? { verifyReadPagesMs: verifyMeasurement.durationMs }
      : {}),
  },
  thresholds: readMeasurement
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
    ...(readMeasurement
      ? [
          {
            name: readMeasurement.name,
            durationMs: readMeasurement.durationMs,
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
          readyFullScan: seedReadyMeasurement?.result
            ? {
                scannedRecords: seedReadyMeasurement.result.scannedRecords,
                pageSize: seedReadyMeasurement.result.pageSize,
                pageCount: seedReadyMeasurement.result.pageCount,
              }
            : undefined,
        }
      : undefined,
    responseHeaders: readMeasurement?.result.pages.map(
      (page) => page.responseHeaders,
    ),
    routing: readMeasurement?.result.pages.map((page) => page.routing),
    readPages: verifyMeasurement?.result,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
          }
        : undefined,
  },
});

export const runRecordReadCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as RecordReadCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  let fixture: RecordReadFixture | undefined;
  let prepareMeasurement: Measurement<RecordReadFixture> | undefined;
  let seedReadyMeasurement: Measurement<ProjectionScanVerification> | undefined;
  let readMeasurement: Measurement<ReadPagedScanResult> | undefined;
  let verifyMeasurement: Measurement<ReadPagedScanVerification> | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareFixture(perfCase, context, config),
    );
    fixture = prepareMeasurement.result;
    seedReadyMeasurement = await measureAsync("seedReady", () =>
      waitForProjectionFullScan(fixture!, config),
    );

    try {
      readMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        config.threshold.metric,
        () =>
          measureAsync(config.threshold.metric, () =>
            readPagedScan(fixture!, context, config),
          ),
      );
      verifyMeasurement = await measureAsync("verifyReadPages", () =>
        Promise.resolve(
          verifyReadPagedScan(fixture!, config, readMeasurement!.result),
        ),
      );
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildRecordReadResult({
          config,
          fixture,
          prepareMeasurement,
          seedReadyMeasurement,
          readMeasurement,
          verifyMeasurement,
          error,
        }),
      );
    }

    return buildRecordReadResult({
      config,
      fixture,
      prepareMeasurement,
      seedReadyMeasurement,
      readMeasurement,
      verifyMeasurement,
    });
  } finally {
    if (fixture && !fixture.reusableSeed && !isExecuteDbIsolated()) {
      await deleteTables(baseId, [fixture.tableId, fixture.sourceTableId]);
    }
  }
};

export const seedRecordReadCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as RecordReadCaseConfig;
  const prepareMeasurement = await measureAsync("prepare", () =>
    prepareFixture(perfCase, context, config),
  );
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    waitForProjectionFullScan(prepareMeasurement.result, config),
  );

  return buildRecordReadResult({
    config,
    fixture: prepareMeasurement.result,
    prepareMeasurement,
    seedReadyMeasurement,
  });
};
