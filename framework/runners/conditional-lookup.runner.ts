import { FieldKeyType, FieldType, type IFieldRo } from "@teable/core";
import { createField as apiCreateField } from "@teable/openapi";
import {
  createField,
  createRecords,
  createTable,
  deleteField,
  getFields,
  getRecord,
  getRecords,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { chunk } from "../chunk";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, roundMetric, type Measurement } from "../metrics";
import { pollUntilReady } from "../readiness";
import { forEachRecordPage } from "../record-page-scan";
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
  PerfCaseFor,
  ConditionalComputedSeedConfig,
  ConditionalLookupCaseConfig,
  ConditionalLookupSharedConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  runFieldAddLifecycle,
  seedFieldAddLifecycle,
  type FieldAddLifecycleSpec,
} from "./field-add-lifecycle";

type SeedRecordInput = {
  rowOffset: number;
  rowNumber: number;
  fields: Record<string, string>;
};

export type ConditionalLookupSourceFields = {
  keyFieldId: string;
  valueFieldId: string;
};

export type ConditionalLookupHostFields = {
  keyFieldId: string;
  lookupKeyFieldId: string;
};

export type ConditionalLookupSeedFixture = {
  sourceTableId: string;
  sourceTableName: string;
  hostTableId: string;
  hostTableName: string;
  sourceFields: ConditionalLookupSourceFields;
  hostFields: ConditionalLookupHostFields;
  sampleRecords: SeededSampleRecord[];
  sourceBatchDurations: number[];
  hostBatchDurations: number[];
  createTablesMeasurement: Measurement<unknown>;
  seedSourceMeasurement: Measurement<unknown>;
  seedHostMeasurement: Measurement<unknown>;
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusable: boolean;
};

const SOURCE_KEY_FIELD_NAME = "A Key";
const SOURCE_VALUE_FIELD_NAME = "A Value";
const HOST_KEY_FIELD_NAME = "B Key";
const HOST_LOOKUP_KEY_FIELD_NAME = "Lookup A Key";

const sourceFieldNames = [SOURCE_KEY_FIELD_NAME, SOURCE_VALUE_FIELD_NAME];
const hostSeedFieldNames = [HOST_KEY_FIELD_NAME, HOST_LOOKUP_KEY_FIELD_NAME];
const CONDITIONAL_COMPUTED_FIXTURE_VERSION = "conditional-computed-v1";
const SHARED_CONDITIONAL_COMPUTED_SEED_ID =
  "conditional-computed/shared-10k-seed";

const getGreatestCommonDivisor = (left: number, right: number): number => {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
};

const assertPermutationConfig = (config: ConditionalComputedSeedConfig) => {
  const { multiplier, offset } = config.generator.permutation;
  if (
    !Number.isInteger(multiplier) ||
    !Number.isInteger(offset) ||
    multiplier <= 0 ||
    offset < 0
  ) {
    throw new Error(
      `Invalid conditional lookup permutation config: multiplier=${multiplier}, offset=${offset}`,
    );
  }

  if (getGreatestCommonDivisor(multiplier, config.recordCount) !== 1) {
    throw new Error(
      `Permutation multiplier ${multiplier} must be coprime with recordCount ${config.recordCount}`,
    );
  }
};

export const getSourceRowNumberForHostRow = (
  hostRowNumber: number,
  config: ConditionalComputedSeedConfig,
) => {
  const { multiplier, offset } = config.generator.permutation;
  const hostRowOffset = hostRowNumber - 1;
  return ((hostRowOffset * multiplier + offset) % config.recordCount) + 1;
};

const getSourceKey = (
  rowNumber: number,
  config: ConditionalComputedSeedConfig,
) => `${config.generator.sourceKeyPrefix}-${rowNumber}`;

const getHostKey = (rowNumber: number, config: ConditionalComputedSeedConfig) =>
  `${config.generator.hostKeyPrefix}-${rowNumber}`;

export const getExpectedValue = (
  sourceRowNumber: number,
  config: ConditionalComputedSeedConfig,
) => `${config.generator.sourceValuePrefix}-${sourceRowNumber}`;

export const parseConditionalSeedRowNumber = (
  value: unknown,
  prefix: string,
) => {
  if (typeof value !== "string") {
    throw new Error(
      `Expected ${prefix} value to be a string, got ${String(value)}`,
    );
  }

  const rowNumber = Number(value.slice(`${prefix}-`.length));
  if (!value.startsWith(`${prefix}-`) || !Number.isInteger(rowNumber)) {
    throw new Error(`Expected ${value} to match ${prefix}-<rowNumber>`);
  }

  return rowNumber;
};

const buildSourceRecords = (
  config: ConditionalComputedSeedConfig,
): SeedRecordInput[] =>
  Array.from({ length: config.recordCount }, (_, index) => {
    const rowNumber = index + 1;
    return {
      rowOffset: index,
      rowNumber,
      fields: {
        [SOURCE_KEY_FIELD_NAME]: getSourceKey(rowNumber, config),
        [SOURCE_VALUE_FIELD_NAME]: getExpectedValue(rowNumber, config),
      },
    };
  });

const buildHostRecords = (config: ConditionalComputedSeedConfig) =>
  Array.from({ length: config.recordCount }, (_, index) => {
    const rowNumber = index + 1;
    return {
      rowOffset: index,
      rowNumber,
      fields: {
        [HOST_KEY_FIELD_NAME]: getHostKey(rowNumber, config),
        [HOST_LOOKUP_KEY_FIELD_NAME]: getSourceKey(
          getSourceRowNumberForHostRow(rowNumber, config),
          config,
        ),
      },
    };
  });

const getConditionalLookupSeedConfig = (
  config: ConditionalComputedSeedConfig,
) => ({
  baseId: config.baseId,
  sourceTableNamePrefix: config.sourceTableNamePrefix,
  hostTableNamePrefix: config.hostTableNamePrefix,
  recordCount: config.recordCount,
  batchSize: config.batchSize,
  generator: config.generator,
  sourceFields: sourceFieldNames,
  hostFields: hostSeedFieldNames,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: CONDITIONAL_COMPUTED_FIXTURE_VERSION,
});

const getRequiredSampleRecords = (
  config: ConditionalComputedSeedConfig,
  seededSampleRecordByOffset: Map<number, SeededSampleRecord>,
) =>
  config.verify.sampleRows.map((rowOffset) => {
    const sampleRecord = seededSampleRecordByOffset.get(rowOffset);
    if (!sampleRecord) {
      throw new Error(
        `Missing seeded host sample record for row offset ${rowOffset}. recordCount=${config.recordCount}`,
      );
    }
    return sampleRecord;
  });

const resolveNamedFieldIds = (
  fields: Array<{ id: string; name: string }>,
  requiredNames: string[],
  tableId: string,
) => {
  const fieldByName = new Map(fields.map((field) => [field.name, field.id]));
  const missingFields = requiredNames.filter(
    (fieldName) => !fieldByName.has(fieldName),
  );

  if (missingFields.length > 0) {
    throw new Error(
      `Missing seed fields on table ${tableId}: ${missingFields.join(
        ", ",
      )}; available fields: ${fields.map((field) => field.name).join(", ")}`,
    );
  }

  return fieldByName;
};

const resolveSourceFields = (
  tableId: string,
  fields: Array<{ id: string; name: string }>,
): ConditionalLookupSourceFields => {
  const fieldByName = resolveNamedFieldIds(fields, sourceFieldNames, tableId);
  return {
    keyFieldId: fieldByName.get(SOURCE_KEY_FIELD_NAME)!,
    valueFieldId: fieldByName.get(SOURCE_VALUE_FIELD_NAME)!,
  };
};

const resolveHostFields = (
  tableId: string,
  fields: Array<{ id: string; name: string }>,
): ConditionalLookupHostFields => {
  const fieldByName = resolveNamedFieldIds(fields, hostSeedFieldNames, tableId);
  return {
    keyFieldId: fieldByName.get(HOST_KEY_FIELD_NAME)!,
    lookupKeyFieldId: fieldByName.get(HOST_LOOKUP_KEY_FIELD_NAME)!,
  };
};

const buildConditionalLookupFieldInput = (
  sourceTableId: string,
  sourceFields: ConditionalLookupSourceFields,
  hostFields: ConditionalLookupHostFields,
  config: ConditionalLookupSharedConfig,
): IFieldRo => ({
  name: config.lookup.name,
  type: FieldType.SingleLineText,
  isLookup: true,
  isConditionalLookup: true,
  lookupOptions: {
    foreignTableId: sourceTableId,
    lookupFieldId: sourceFields.valueFieldId,
    filter: {
      conjunction: "and",
      filterSet: [
        {
          fieldId: sourceFields.keyFieldId,
          operator: "is",
          value: {
            type: "field",
            fieldId: hostFields.lookupKeyFieldId,
          },
        },
      ],
    },
    limit: config.lookup.limit,
  },
});

export const createConditionalLookupField = (
  hostTableId: string,
  sourceTableId: string,
  sourceFields: ConditionalLookupSourceFields,
  hostFields: ConditionalLookupHostFields,
  config: ConditionalLookupSharedConfig,
) =>
  createField(
    hostTableId,
    buildConditionalLookupFieldInput(
      sourceTableId,
      sourceFields,
      hostFields,
      config,
    ),
  );

export const createConditionalLookupFieldWithRouting = async (
  context: PerfRunContext,
  hostTableId: string,
  sourceTableId: string,
  sourceFields: ConditionalLookupSourceFields,
  hostFields: ConditionalLookupHostFields,
  config: ConditionalLookupSharedConfig,
) => {
  const response = await apiCreateField(
    hostTableId,
    buildConditionalLookupFieldInput(
      sourceTableId,
      sourceFields,
      hostFields,
      config,
    ),
  );
  expect(response.status).toBe(201);
  const responseHeaders = pickRoutingResponseHeaders(
    response.headers as Record<string, unknown>,
  );
  const routing = assertEngineRouting(context, responseHeaders, {
    feature: "createField",
    operation: "Conditional lookup field create",
  });
  return {
    field: response.data as { id: string },
    responseHeaders,
    routing,
  };
};

export const cleanupConditionalComputedFields = async (
  hostTableId: string,
  fields: Array<{ id: string; name: string }>,
) => {
  const seedFieldNameSet = new Set(hostSeedFieldNames);
  const lookupFields = fields.filter(
    (field) => !seedFieldNameSet.has(field.name),
  );
  for (const field of lookupFields) {
    await deleteField(hostTableId, field.id);
  }
};

const createEmptyMeasurement = <T>(
  name: string,
  result: T,
): Measurement<T> => ({
  name,
  durationMs: 0,
  result,
});

type ConditionalLookupFieldCreation = {
  field: { id: string };
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
};

const getCachedHostSampleRecords = async (
  tableId: string,
  hostFields: ConditionalLookupHostFields,
  config: ConditionalComputedSeedConfig,
): Promise<SeededSampleRecord[]> => {
  const sampleRecords = [];
  for (const rowOffset of config.verify.sampleRows) {
    const expectedRowNumber = rowOffset + 1;
    const result = await getRecords(tableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [hostFields.keyFieldId, hostFields.lookupKeyFieldId],
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(
        `Missing cached host seed sample at row offset ${rowOffset}; recordCount=${config.recordCount}`,
      );
    }

    const rowNumber = parseConditionalSeedRowNumber(
      record.fields[hostFields.keyFieldId],
      config.generator.hostKeyPrefix,
    );
    if (rowNumber !== expectedRowNumber) {
      throw new Error(
        `Cached host sample row mismatch: expected row ${expectedRowNumber}, got ${rowNumber}`,
      );
    }

    const sourceRowNumber = getSourceRowNumberForHostRow(rowNumber, config);
    const expectedLookupKey = getSourceKey(sourceRowNumber, config);
    const actualLookupKey = record.fields[hostFields.lookupKeyFieldId];
    if (actualLookupKey !== expectedLookupKey) {
      throw new Error(
        `Cached host lookup key mismatch at row ${rowNumber}: expected ${expectedLookupKey}, actual ${String(
          actualLookupKey,
        )}`,
      );
    }

    sampleRecords.push({
      rowOffset,
      rowNumber,
      recordId: record.id,
    });
  }
  return sampleRecords;
};

const assertLookupSamples = async (
  tableId: string,
  lookupFieldId: string,
  config: ConditionalComputedSeedConfig,
  sampleRecords: SeededSampleRecord[],
) => {
  const verifiedSamples = [];

  for (const sampleRecord of sampleRecords) {
    const record = await getRecord(tableId, sampleRecord.recordId);
    const actual = record.fields[lookupFieldId];
    const sourceRowNumber = getSourceRowNumberForHostRow(
      sampleRecord.rowNumber,
      config,
    );
    const expected = [getExpectedValue(sourceRowNumber, config)];

    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Conditional lookup mismatch at row ${sampleRecord.rowNumber}: expected ${JSON.stringify(
          expected,
        )}, actual ${JSON.stringify(actual)}`,
      );
    }

    verifiedSamples.push({
      rowOffset: sampleRecord.rowOffset,
      rowNumber: sampleRecord.rowNumber,
      sourceRowNumber,
      recordId: sampleRecord.recordId,
      actual,
      expected,
    });
  }

  return verifiedSamples;
};

const waitForLookupSamples = (
  tableId: string,
  lookupFieldId: string,
  config: ConditionalComputedSeedConfig,
  sampleRecords: SeededSampleRecord[],
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 60_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 500,
      description: "conditional lookup samples",
    },
    () => assertLookupSamples(tableId, lookupFieldId, config, sampleRecords),
  );

export type ConditionalLookupFullScan = {
  scannedRecords: number;
  pageSize: number;
  pageCount: number;
  verifiedSamples: Array<{
    rowOffset: number;
    rowNumber: number;
    sourceRowNumber: number;
    recordId: string;
    actual: unknown;
    expected: unknown;
  }>;
};

const assertLookupFullScan = async (
  tableId: string,
  lookupFieldId: string,
  config: ConditionalComputedSeedConfig,
  hostFields: ConditionalLookupHostFields,
  onProgress?: (progress: ConditionalLookupFullScan) => void,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleRowOffsets = new Set(config.verify.sampleRows);
  const seenRowNumbers = new Set<number>();
  const progress: ConditionalLookupFullScan = {
    scannedRecords: 0,
    pageSize,
    pageCount: 0,
    verifiedSamples: [],
  };
  onProgress?.(progress);

  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.recordCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(tableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: [
            hostFields.keyFieldId,
            hostFields.lookupKeyFieldId,
            lookupFieldId,
          ],
          skip,
          take,
        }),
    },
    (record) => {
      const hostRowNumber = parseConditionalSeedRowNumber(
        record.fields[hostFields.keyFieldId],
        config.generator.hostKeyPrefix,
      );
      const sourceRowNumber = getSourceRowNumberForHostRow(
        hostRowNumber,
        config,
      );
      const expectedLookupKey = getSourceKey(sourceRowNumber, config);
      const actualLookupKey = record.fields[hostFields.lookupKeyFieldId];
      const expected = [getExpectedValue(sourceRowNumber, config)];
      const actual = record.fields[lookupFieldId];

      if (seenRowNumbers.has(hostRowNumber)) {
        throw new Error(
          `Duplicate host row number in full scan: ${hostRowNumber}`,
        );
      }
      seenRowNumbers.add(hostRowNumber);

      if (actualLookupKey !== expectedLookupKey) {
        throw new Error(
          `Host row ${hostRowNumber} lookup key mismatch: expected ${expectedLookupKey}, actual ${String(
            actualLookupKey,
          )}`,
        );
      }

      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `Conditional lookup full scan mismatch at host row ${hostRowNumber}: expected ${JSON.stringify(
            expected,
          )}, actual ${JSON.stringify(actual)}`,
        );
      }

      const rowOffset = hostRowNumber - 1;
      if (sampleRowOffsets.has(rowOffset)) {
        progress.verifiedSamples.push({
          rowOffset,
          rowNumber: hostRowNumber,
          sourceRowNumber,
          recordId: record.id,
          actual,
          expected,
        });
      }
      progress.scannedRecords += 1;
      progress.pageCount = Math.ceil(progress.scannedRecords / pageSize);
    },
  );

  progress.scannedRecords = scannedRecords;
  progress.pageCount = pageCount;

  if (scannedRecords !== config.recordCount) {
    throw new Error(
      `Full scan record count mismatch: expected ${config.recordCount}, scanned ${scannedRecords}`,
    );
  }

  if (seenRowNumbers.size !== config.recordCount) {
    throw new Error(
      `Full scan unique row mismatch: expected ${config.recordCount}, got ${seenRowNumbers.size}`,
    );
  }

  progress.verifiedSamples.sort(
    (left, right) => left.rowOffset - right.rowOffset,
  );
  return progress;
};

export const waitForConditionalLookupFullScan = (
  tableId: string,
  lookupFieldId: string,
  config: ConditionalComputedSeedConfig,
  hostFields: ConditionalLookupHostFields,
  onProgress?: (progress: ConditionalLookupFullScan) => void,
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 60_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 500,
      description: "full conditional lookup scan",
    },
    () =>
      assertLookupFullScan(
        tableId,
        lookupFieldId,
        config,
        hostFields,
        onProgress,
      ),
  );

export const assertConditionalLookupSeedReady = async (
  sourceTableId: string,
  hostTableId: string,
  sourceFields: ConditionalLookupSourceFields,
  hostFields: ConditionalLookupHostFields,
  config: ConditionalComputedSeedConfig,
  sampleRecords: SeededSampleRecord[],
) => {
  const verifiedSamples = [];

  for (const sampleRecord of sampleRecords) {
    const hostRecord = await getRecord(hostTableId, sampleRecord.recordId);
    const sourceRowNumber = getSourceRowNumberForHostRow(
      sampleRecord.rowNumber,
      config,
    );
    const expectedHostKey = getHostKey(sampleRecord.rowNumber, config);
    const expectedSourceKey = getSourceKey(sourceRowNumber, config);
    const actualHostKey = hostRecord.fields[hostFields.keyFieldId];
    const actualLookupKey = hostRecord.fields[hostFields.lookupKeyFieldId];

    if (actualHostKey !== expectedHostKey) {
      throw new Error(
        `Host seed key mismatch at row ${sampleRecord.rowNumber}: expected ${expectedHostKey}, actual ${String(
          actualHostKey,
        )}`,
      );
    }

    if (actualLookupKey !== expectedSourceKey) {
      throw new Error(
        `Host seed lookup key mismatch at row ${sampleRecord.rowNumber}: expected ${expectedSourceKey}, actual ${String(
          actualLookupKey,
        )}`,
      );
    }

    const sourceResult = await getRecords(sourceTableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [sourceFields.keyFieldId, sourceFields.valueFieldId],
      skip: sourceRowNumber - 1,
      take: 1,
    });
    const sourceRecord = sourceResult.records[0];
    if (!sourceRecord) {
      throw new Error(
        `Missing source seed record at row ${sourceRowNumber}; recordCount=${config.recordCount}`,
      );
    }

    const actualSourceKey = sourceRecord.fields[sourceFields.keyFieldId];
    const actualSourceValue = sourceRecord.fields[sourceFields.valueFieldId];
    const expectedSourceValue = getExpectedValue(sourceRowNumber, config);

    if (actualSourceKey !== expectedSourceKey) {
      throw new Error(
        `Source seed key mismatch at row ${sourceRowNumber}: expected ${expectedSourceKey}, actual ${String(
          actualSourceKey,
        )}`,
      );
    }

    if (actualSourceValue !== expectedSourceValue) {
      throw new Error(
        `Source seed value mismatch at row ${sourceRowNumber}: expected ${expectedSourceValue}, actual ${String(
          actualSourceValue,
        )}`,
      );
    }

    verifiedSamples.push({
      hostRowOffset: sampleRecord.rowOffset,
      hostRowNumber: sampleRecord.rowNumber,
      hostRecordId: sampleRecord.recordId,
      sourceRowNumber,
      sourceRecordId: sourceRecord.id,
      actual: {
        hostKey: actualHostKey,
        lookupKey: actualLookupKey,
        sourceKey: actualSourceKey,
        sourceValue: actualSourceValue,
      },
      expected: {
        hostKey: expectedHostKey,
        lookupKey: expectedSourceKey,
        sourceKey: expectedSourceKey,
        sourceValue: expectedSourceValue,
      },
    });
  }

  const [
    lastHostPage,
    beyondLastHostPage,
    lastSourcePage,
    beyondLastSourcePage,
  ] = await Promise.all([
    getRecords(hostTableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [hostFields.keyFieldId, hostFields.lookupKeyFieldId],
      skip: config.recordCount - 1,
      take: 1,
    }),
    getRecords(hostTableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [hostFields.keyFieldId],
      skip: config.recordCount,
      take: 1,
    }),
    getRecords(sourceTableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [sourceFields.keyFieldId, sourceFields.valueFieldId],
      skip: config.recordCount - 1,
      take: 1,
    }),
    getRecords(sourceTableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [sourceFields.keyFieldId],
      skip: config.recordCount,
      take: 1,
    }),
  ]);

  const lastHostRecord = lastHostPage.records[0];
  const lastSourceRecord = lastSourcePage.records[0];

  if (!lastHostRecord || !lastSourceRecord) {
    throw new Error(
      `Missing final seed row; host=${Boolean(lastHostRecord)}, source=${Boolean(
        lastSourceRecord,
      )}, recordCount=${config.recordCount}`,
    );
  }

  const lastHostRowNumber = parseConditionalSeedRowNumber(
    lastHostRecord.fields[hostFields.keyFieldId],
    config.generator.hostKeyPrefix,
  );
  const lastSourceRowNumber = parseConditionalSeedRowNumber(
    lastSourceRecord.fields[sourceFields.keyFieldId],
    config.generator.sourceKeyPrefix,
  );

  if (
    lastHostRowNumber !== config.recordCount ||
    lastSourceRowNumber !== config.recordCount
  ) {
    throw new Error(
      `Final seed row mismatch: expected ${config.recordCount}, host=${lastHostRowNumber}, source=${lastSourceRowNumber}`,
    );
  }

  if (
    beyondLastHostPage.records.length !== 0 ||
    beyondLastSourcePage.records.length !== 0
  ) {
    throw new Error(
      `Seed has extra rows after expected recordCount=${config.recordCount}; hostExtra=${beyondLastHostPage.records.length}, sourceExtra=${beyondLastSourcePage.records.length}`,
    );
  }

  return {
    verifiedSamples,
  };
};

const seedSourceTable = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  sourceTableId: string,
  config: ConditionalComputedSeedConfig,
) => {
  const sourceBatches = chunk(buildSourceRecords(config), config.batchSize);
  const sourceBatchDurations: number[] = [];

  const seedSourceMeasurement = await measureAsync(
    "seedSourceRecords",
    async () => {
      for (const [batchIndex, batch] of sourceBatches.entries()) {
        const batchMeasurement = await measureAsync(
          `seedSourceBatch:${batchIndex + 1}`,
          () =>
            createRecords(sourceTableId, {
              fieldKeyType: FieldKeyType.Name,
              records: batch.map(({ fields }) => ({ fields })),
            }),
        );
        sourceBatchDurations.push(batchMeasurement.durationMs);
        expect(batchMeasurement.result.records).toHaveLength(batch.length);
      }
    },
  );

  return { seedSourceMeasurement, sourceBatchDurations };
};

const seedHostTable = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  hostTableId: string,
  config: ConditionalComputedSeedConfig,
) => {
  const hostBatches = chunk(buildHostRecords(config), config.batchSize);
  const hostBatchDurations: number[] = [];
  const wantedSampleOffsets = new Set(config.verify.sampleRows);
  const seededSampleRecordByOffset = new Map<number, SeededSampleRecord>();

  const seedHostMeasurement = await measureAsync(
    "seedHostRecords",
    async () => {
      for (const [batchIndex, batch] of hostBatches.entries()) {
        const batchMeasurement = await measureAsync(
          `seedHostBatch:${batchIndex + 1}`,
          () =>
            createRecords(hostTableId, {
              fieldKeyType: FieldKeyType.Name,
              records: batch.map(({ fields }) => ({ fields })),
            }),
        );
        hostBatchDurations.push(batchMeasurement.durationMs);
        expect(batchMeasurement.result.records).toHaveLength(batch.length);
        collectSampleRecords(
          seededSampleRecordByOffset,
          wantedSampleOffsets,
          batch,
          batchMeasurement.result.records,
        );
      }
    },
  );

  return {
    seedHostMeasurement,
    hostBatchDurations,
    sampleRecords: getRequiredSampleRecords(config, seededSampleRecordByOffset),
  };
};

const createConditionalLookupSeedFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  sourceTableName: string,
  hostTableName: string,
  config: ConditionalComputedSeedConfig,
  seedCacheInfo: SeedCacheInfo,
): Promise<ConditionalLookupSeedFixture> => {
  const createdTableIds: string[] = [];

  try {
    const createTablesMeasurement = await measureAsync(
      seedCacheInfo.enabled ? "seedBuild" : "createTables",
      async () => {
        const sourceTable = await createTable(baseId, {
          name: sourceTableName,
          fields: [
            { name: SOURCE_KEY_FIELD_NAME, type: FieldType.SingleLineText },
            {
              name: SOURCE_VALUE_FIELD_NAME,
              type: FieldType.SingleLineText,
            },
          ],
          records: [],
        });
        createdTableIds.push(sourceTable.id);
        const hostTable = await createTable(baseId, {
          name: hostTableName,
          fields: [
            { name: HOST_KEY_FIELD_NAME, type: FieldType.SingleLineText },
            {
              name: HOST_LOOKUP_KEY_FIELD_NAME,
              type: FieldType.SingleLineText,
            },
          ],
          records: [],
        });
        createdTableIds.push(hostTable.id);
        return { sourceTable, hostTable };
      },
    );
    const sourceTableId = createTablesMeasurement.result.sourceTable.id;
    const hostTableId = createTablesMeasurement.result.hostTable.id;
    const sourceFields = resolveSourceFields(
      sourceTableId,
      createTablesMeasurement.result.sourceTable.fields,
    );
    const hostFields = resolveHostFields(
      hostTableId,
      createTablesMeasurement.result.hostTable.fields,
    );
    const { seedSourceMeasurement, sourceBatchDurations } =
      await seedSourceTable(perfCase, context, sourceTableId, config);
    const { seedHostMeasurement, hostBatchDurations, sampleRecords } =
      await seedHostTable(perfCase, context, hostTableId, config);

    return {
      sourceTableId,
      sourceTableName,
      hostTableId,
      hostTableName,
      sourceFields,
      hostFields,
      sampleRecords,
      sourceBatchDurations,
      hostBatchDurations,
      createTablesMeasurement,
      seedSourceMeasurement,
      seedHostMeasurement,
      seedCacheInfo,
      seedCacheHit: false,
      reusable: seedCacheInfo.enabled,
    };
  } catch (error) {
    for (const tableId of createdTableIds.reverse()) {
      try {
        await permanentDeleteTable(baseId, tableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup incomplete conditional lookup seed ${tableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const restoreConditionalLookupSeedFixture = async (
  baseId: string,
  sourceTableName: string,
  hostTableName: string,
  config: ConditionalComputedSeedConfig,
  seedCacheInfo: SeedCacheInfo,
  options: { cleanupHostLookupFields?: boolean } = {},
): Promise<ConditionalLookupSeedFixture | undefined> => {
  if (!seedCacheInfo.enabled) {
    return;
  }

  const [sourceTable, hostTable] = await Promise.all([
    findSeedTable(baseId, sourceTableName),
    findSeedTable(baseId, hostTableName),
  ]);

  if (!sourceTable || !hostTable) {
    for (const table of [hostTable, sourceTable]) {
      if (table) {
        await permanentDeleteTable(baseId, table.id);
      }
    }
    return;
  }

  try {
    const [sourceTableFields, hostTableFields] = await Promise.all([
      getFields(sourceTable.id),
      getFields(hostTable.id),
    ]);
    const shouldCleanupHostLookupFields =
      options.cleanupHostLookupFields ?? true;
    if (shouldCleanupHostLookupFields) {
      await cleanupConditionalComputedFields(hostTable.id, hostTableFields);
    }
    const cleanedHostTableFields = shouldCleanupHostLookupFields
      ? await getFields(hostTable.id)
      : hostTableFields;
    const sourceFields = resolveSourceFields(sourceTable.id, sourceTableFields);
    const hostFields = resolveHostFields(hostTable.id, cleanedHostTableFields);
    const sampleRecords = await getCachedHostSampleRecords(
      hostTable.id,
      hostFields,
      config,
    );
    await assertConditionalLookupSeedReady(
      sourceTable.id,
      hostTable.id,
      sourceFields,
      hostFields,
      config,
      sampleRecords,
    );

    return {
      sourceTableId: sourceTable.id,
      sourceTableName: sourceTable.name,
      hostTableId: hostTable.id,
      hostTableName: hostTable.name,
      sourceFields,
      hostFields,
      sampleRecords,
      sourceBatchDurations: [0],
      hostBatchDurations: [0],
      createTablesMeasurement: createEmptyMeasurement("seedRestore", {
        sourceTableId: sourceTable.id,
        hostTableId: hostTable.id,
      }),
      seedSourceMeasurement: createEmptyMeasurement(
        "seedSourceBuildSkipped",
        undefined,
      ),
      seedHostMeasurement: createEmptyMeasurement(
        "seedHostBuildSkipped",
        undefined,
      ),
      seedCacheInfo,
      seedCacheHit: true,
      reusable: true,
    };
  } catch (error) {
    console.warn(
      `Invalid cached conditional lookup seed ${seedCacheInfo.seedHashShort}; rebuilding`,
      error,
    );
    for (const tableId of [hostTable.id, sourceTable.id]) {
      await permanentDeleteTable(baseId, tableId);
    }
    return;
  }
};

export const buildConditionalLookupSeedFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  sourceTableName: string,
  hostTableName: string,
  config: ConditionalComputedSeedConfig,
  seedCacheInfo: SeedCacheInfo,
  options?: { cleanupHostLookupFields?: boolean },
) =>
  (await restoreConditionalLookupSeedFixture(
    baseId,
    sourceTableName,
    hostTableName,
    config,
    seedCacheInfo,
    options,
  )) ??
  createConditionalLookupSeedFixture(
    perfCase,
    context,
    baseId,
    sourceTableName,
    hostTableName,
    config,
    seedCacheInfo,
  );

export const prepareConditionalComputedSeedFixture = async ({
  perfCase,
  context,
  baseId,
  config,
  seedMode,
}: {
  perfCase: PerfCase;
  context: PerfRunContext;
  baseId: string;
  config: ConditionalComputedSeedConfig;
  seedMode: boolean;
}) => {
  const timestamp = Date.now();
  const seedPerfCase = {
    ...perfCase,
    id: SHARED_CONDITIONAL_COMPUTED_SEED_ID,
  };
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase: seedPerfCase,
    runner: "conditional-lookup",
    fixtureVersion: CONDITIONAL_COMPUTED_FIXTURE_VERSION,
    seedConfig: getConditionalLookupSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
  const suffix = seedMode ? "-seed-" : "-";
  const sourceTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "source")
    : `${config.sourceTableNamePrefix}${suffix}${timestamp}`;
  const hostTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "host")
    : `${config.hostTableNamePrefix}${suffix}${timestamp}`;

  assertPermutationConfig(config);
  return buildConditionalLookupSeedFixture(
    perfCase,
    context,
    baseId,
    sourceTableName,
    hostTableName,
    config,
    seedCacheInfo,
  );
};

const buildConditionalLookupCaseResult = ({
  config,
  sourceTableId,
  sourceTableName,
  hostTableId,
  hostTableName,
  sourceBatchDurations,
  hostBatchDurations,
  sampleRecords,
  createTablesMeasurement,
  seedSourceMeasurement,
  seedHostMeasurement,
  seedReadyMeasurement,
  createLookupFieldMeasurement,
  fullLookupScanReadyMeasurement,
  lookupField,
  seedCacheInfo,
  seedCacheHit,
  reusableSeed,
  sourceFields,
  hostFields,
  error,
}: {
  config: ConditionalLookupCaseConfig;
  sourceTableId: string;
  sourceTableName: string;
  hostTableId: string;
  hostTableName: string;
  sourceBatchDurations: number[];
  hostBatchDurations: number[];
  sampleRecords: SeededSampleRecord[];
  createTablesMeasurement: Measurement<unknown>;
  seedSourceMeasurement: Measurement<unknown>;
  seedHostMeasurement: Measurement<unknown>;
  seedReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertConditionalLookupSeedReady>>
  >;
  createLookupFieldMeasurement?: Measurement<ConditionalLookupFieldCreation>;
  fullLookupScanReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof waitForConditionalLookupFullScan>>
  >;
  lookupField?: { id: string };
  seedCacheInfo?: SeedCacheInfo;
  seedCacheHit?: boolean;
  reusableSeed?: boolean;
  sourceFields: ConditionalLookupSourceFields;
  hostFields: ConditionalLookupHostFields;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    ...(seedCacheInfo
      ? {
          seedCacheHit: seedCacheHit ? 1 : 0,
          seedCacheEnabled: seedCacheInfo.enabled ? 1 : 0,
          ...(seedCacheHit
            ? { seedRestoreMs: createTablesMeasurement.durationMs }
            : seedCacheInfo.enabled
              ? {
                  seedBuildMs: roundMetric(
                    createTablesMeasurement.durationMs +
                      seedSourceMeasurement.durationMs +
                      seedHostMeasurement.durationMs,
                  ),
                }
              : {}),
        }
      : {}),
    createTablesMs: createTablesMeasurement.durationMs,
    seedSourceRecordsMs: seedSourceMeasurement.durationMs,
    seedHostRecordsMs: seedHostMeasurement.durationMs,
    ...(seedReadyMeasurement
      ? { seedReadyMs: seedReadyMeasurement.durationMs }
      : {}),
    ...(createLookupFieldMeasurement
      ? {
          createLookupFieldMs: createLookupFieldMeasurement.durationMs,
        }
      : {}),
    ...(fullLookupScanReadyMeasurement
      ? {
          fullLookupScanReadyMs: fullLookupScanReadyMeasurement.durationMs,
          conditionalLookupReadyMs: roundMetric(
            (createLookupFieldMeasurement?.durationMs ?? 0) +
              fullLookupScanReadyMeasurement.durationMs,
          ),
        }
      : {}),
    maxSeedBatchMs: roundMetric(
      Math.max(...sourceBatchDurations, ...hostBatchDurations),
    ),
  },
  thresholds: fullLookupScanReadyMeasurement
    ? [
        {
          metric: config.threshold.metric,
          max: getPrimaryThresholdMs(config.threshold.maxMs),
          unit: "ms",
        },
      ]
    : [],
  phases: [
    {
      name: createTablesMeasurement.name,
      durationMs: createTablesMeasurement.durationMs,
    },
    {
      name: seedSourceMeasurement.name,
      durationMs: seedSourceMeasurement.durationMs,
    },
    {
      name: seedHostMeasurement.name,
      durationMs: seedHostMeasurement.durationMs,
    },
    ...(seedReadyMeasurement
      ? [
          {
            name: seedReadyMeasurement.name,
            durationMs: seedReadyMeasurement.durationMs,
          },
        ]
      : []),
    ...(createLookupFieldMeasurement
      ? [
          {
            name: createLookupFieldMeasurement.name,
            durationMs: createLookupFieldMeasurement.durationMs,
          },
        ]
      : []),
    ...(fullLookupScanReadyMeasurement
      ? [
          {
            name: fullLookupScanReadyMeasurement.name,
            durationMs: fullLookupScanReadyMeasurement.durationMs,
          },
        ]
      : []),
  ],
  details: {
    seed: seedCacheInfo
      ? {
          enabled: seedCacheInfo.enabled,
          seedHash: seedCacheInfo.seedHash,
          seedHashShort: seedCacheInfo.seedHashShort,
          seedNamePrefix: seedCacheInfo.seedNamePrefix,
          sourceTableName,
          hostTableName,
          schemaSignature: seedCacheInfo.schemaSignature,
          cacheHit: Boolean(seedCacheHit),
          reusable: Boolean(reusableSeed),
        }
      : undefined,
    sourceTableId,
    sourceTableName,
    hostTableId,
    hostTableName,
    recordCount: config.recordCount,
    batchSize: config.batchSize,
    sourceFields,
    hostFields,
    sampleRecords,
    verifiedSeedSamples: seedReadyMeasurement?.result.verifiedSamples,
    lookup: {
      fieldId: lookupField?.id,
      name: config.lookup.name,
      limit: config.lookup.limit,
      responseHeaders: createLookupFieldMeasurement?.result.responseHeaders,
      routing: createLookupFieldMeasurement?.result.routing,
    },
    fullScan: fullLookupScanReadyMeasurement?.result
      ? {
          scannedRecords: fullLookupScanReadyMeasurement.result.scannedRecords,
          pageSize: fullLookupScanReadyMeasurement.result.pageSize,
          pageCount: fullLookupScanReadyMeasurement.result.pageCount,
        }
      : undefined,
    verifiedSamples: fullLookupScanReadyMeasurement?.result.verifiedSamples,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
          }
        : undefined,
  },
});

type ConditionalLookupSeedReadyResult = Awaited<
  ReturnType<typeof assertConditionalLookupSeedReady>
>;

type ConditionalLookupPrimary = {
  createLookupFieldMeasurement: Measurement<ConditionalLookupFieldCreation>;
  fullLookupScanReadyMeasurement: Measurement<
    Awaited<ReturnType<typeof waitForConditionalLookupFullScan>>
  >;
  lookupField: { id: string };
};

// conditional-lookup rides the field-add lifecycle: seed a source + host table
// pair, assert the seed, add one conditional lookup field on the host and wait
// for it to backfill across all rows, then restore the seed by deleting that
// lookup field (or drop both tables when the fixture is not reusable). The
// driver owns the seedReady phase, the diagnostic wrapping, and the cleanup
// invocation; everything below is the conditional-lookup-specific difference.
const conditionalLookupFieldAddSpec: FieldAddLifecycleSpec<
  ConditionalLookupCaseConfig,
  ConditionalLookupSeedFixture,
  ConditionalLookupSeedReadyResult,
  ConditionalLookupPrimary
> = {
  prepareFixture: prepareConditionalComputedSeedFixture,
  assertSeedReady: ({ fixture, config }) =>
    assertConditionalLookupSeedReady(
      fixture.sourceTableId,
      fixture.hostTableId,
      fixture.sourceFields,
      fixture.hostFields,
      config,
      fixture.sampleRecords,
    ),
  runPrimary: async ({ perfCase, context, fixture, config }) => {
    const createLookupFieldMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      "createLookupField",
      () =>
        measureAsync("createLookupField", () =>
          createConditionalLookupFieldWithRouting(
            context,
            fixture.hostTableId,
            fixture.sourceTableId,
            fixture.sourceFields,
            fixture.hostFields,
            config,
          ),
        ),
    );
    const fullLookupScanReadyMeasurement = await measureAsync(
      "fullLookupScanReady",
      () =>
        waitForConditionalLookupFullScan(
          fixture.hostTableId,
          createLookupFieldMeasurement.result.field.id,
          config,
          fixture.hostFields,
        ),
    );
    return {
      createLookupFieldMeasurement,
      fullLookupScanReadyMeasurement,
      lookupField: createLookupFieldMeasurement.result.field,
    };
  },
  buildResult: ({ config, fixture, seedReadyMeasurement, primary, error }) =>
    buildConditionalLookupCaseResult({
      config,
      sourceTableId: fixture?.sourceTableId ?? "",
      sourceTableName: fixture?.sourceTableName ?? "",
      hostTableId: fixture?.hostTableId ?? "",
      hostTableName: fixture?.hostTableName ?? "",
      sourceBatchDurations: fixture?.sourceBatchDurations ?? [0],
      hostBatchDurations: fixture?.hostBatchDurations ?? [0],
      sampleRecords: fixture?.sampleRecords ?? [],
      createTablesMeasurement:
        fixture?.createTablesMeasurement ??
        createEmptyMeasurement("seedBuildSkipped", undefined),
      seedSourceMeasurement:
        fixture?.seedSourceMeasurement ??
        createEmptyMeasurement("seedSourceBuildSkipped", undefined),
      seedHostMeasurement:
        fixture?.seedHostMeasurement ??
        createEmptyMeasurement("seedHostBuildSkipped", undefined),
      seedReadyMeasurement,
      createLookupFieldMeasurement: primary?.createLookupFieldMeasurement,
      fullLookupScanReadyMeasurement: primary?.fullLookupScanReadyMeasurement,
      lookupField: primary?.lookupField,
      seedCacheInfo: fixture?.seedCacheInfo,
      seedCacheHit: fixture?.seedCacheHit,
      reusableSeed: fixture?.reusable,
      sourceFields: fixture?.sourceFields ?? {
        keyFieldId: "",
        valueFieldId: "",
      },
      hostFields: fixture?.hostFields ?? {
        keyFieldId: "",
        lookupKeyFieldId: "",
      },
      error,
    }),
  cleanup: async ({ baseId, fixture }) => {
    // CI execute jobs run on a disposable restored DB copy; cleanup that only
    // tidies the durable database is skipped there. A missing fixture means
    // prepare failed before any table existed (it self-cleans on the way out).
    if (isExecuteDbIsolated() || !fixture) {
      return;
    }
    if (fixture.reusable) {
      // Restore the reusable seed by removing the added lookup field. Re-resolve
      // the host fields and drop every non-seed field — idempotent, and a no-op
      // when the field-add failed before creating anything.
      try {
        await cleanupConditionalComputedFields(
          fixture.hostTableId,
          await getFields(fixture.hostTableId),
        );
      } catch (error) {
        console.warn(
          `Failed to cleanup perf lookup field on ${fixture.hostTableId}`,
          error,
        );
      }
      return;
    }
    for (const tableId of [fixture.hostTableId, fixture.sourceTableId]) {
      if (tableId) {
        try {
          await permanentDeleteTable(baseId, tableId);
        } catch (error) {
          console.warn(`Failed to cleanup perf table ${tableId}`, error);
        }
      }
    }
  },
};

export const seedConditionalLookupCase = (
  perfCase: PerfCaseFor<"conditional-lookup">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedFieldAddLifecycle(perfCase, context, conditionalLookupFieldAddSpec);

export const runConditionalLookupCase = (
  perfCase: PerfCaseFor<"conditional-lookup">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runFieldAddLifecycle(perfCase, context, conditionalLookupFieldAddSpec);
