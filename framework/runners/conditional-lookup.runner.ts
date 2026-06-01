import { FieldKeyType, FieldType } from "@teable/core";
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
import { getPrimaryThresholdMs } from "../env";
import { measureAsync, roundMetric } from "../metrics";
import {
  buildSeedCacheInfo,
  buildSeedTableName,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { withPerfTraceStep } from "../trace-collector";
import type {
  ConditionalLookupCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import { PerfRunDiagnosticError } from "../types";

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type SeedRecordInput = {
  rowOffset: number;
  rowNumber: number;
  fields: Record<string, string>;
};

type SeededSampleRecord = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
};

type Measurement<T> = {
  name: string;
  durationMs: number;
  result: T;
};

type SourceFields = {
  keyFieldId: string;
  valueFieldId: string;
};

type HostFields = {
  keyFieldId: string;
  lookupKeyFieldId: string;
};

type ConditionalLookupSeedFixture = {
  sourceTableId: string;
  sourceTableName: string;
  hostTableId: string;
  hostTableName: string;
  sourceFields: SourceFields;
  hostFields: HostFields;
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

const assertPermutationConfig = (config: ConditionalLookupCaseConfig) => {
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

const getSourceRowNumberForHostRow = (
  hostRowNumber: number,
  config: ConditionalLookupCaseConfig,
) => {
  const { multiplier, offset } = config.generator.permutation;
  const hostRowOffset = hostRowNumber - 1;
  return ((hostRowOffset * multiplier + offset) % config.recordCount) + 1;
};

const getSourceKey = (rowNumber: number, config: ConditionalLookupCaseConfig) =>
  `${config.generator.sourceKeyPrefix}-${rowNumber}`;

const getHostKey = (rowNumber: number, config: ConditionalLookupCaseConfig) =>
  `${config.generator.hostKeyPrefix}-${rowNumber}`;

const getExpectedValue = (
  sourceRowNumber: number,
  config: ConditionalLookupCaseConfig,
) => `${config.generator.sourceValuePrefix}-${sourceRowNumber}`;

const parseRowNumber = (value: unknown, prefix: string) => {
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
  config: ConditionalLookupCaseConfig,
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

const buildHostRecords = (config: ConditionalLookupCaseConfig) =>
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
  config: ConditionalLookupCaseConfig,
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
  fixtureVersion: "conditional-lookup-v1",
});

const getRequiredSampleRecords = (
  config: ConditionalLookupCaseConfig,
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
): SourceFields => {
  const fieldByName = resolveNamedFieldIds(fields, sourceFieldNames, tableId);
  return {
    keyFieldId: fieldByName.get(SOURCE_KEY_FIELD_NAME)!,
    valueFieldId: fieldByName.get(SOURCE_VALUE_FIELD_NAME)!,
  };
};

const resolveHostFields = (
  tableId: string,
  fields: Array<{ id: string; name: string }>,
): HostFields => {
  const fieldByName = resolveNamedFieldIds(fields, hostSeedFieldNames, tableId);
  return {
    keyFieldId: fieldByName.get(HOST_KEY_FIELD_NAME)!,
    lookupKeyFieldId: fieldByName.get(HOST_LOOKUP_KEY_FIELD_NAME)!,
  };
};

const cleanupHostLookupFields = async (
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

const getCachedHostSampleRecords = async (
  tableId: string,
  hostFields: HostFields,
  config: ConditionalLookupCaseConfig,
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

    const rowNumber = parseRowNumber(
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
  config: ConditionalLookupCaseConfig,
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

const waitForLookupSamples = async (
  tableId: string,
  lookupFieldId: string,
  config: ConditionalLookupCaseConfig,
  sampleRecords: SeededSampleRecord[],
) => {
  const startedAt = Date.now();
  const timeoutMs = config.verify.timeoutMs ?? 60_000;
  const pollIntervalMs = config.verify.pollIntervalMs ?? 500;
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await assertLookupSamples(
        tableId,
        lookupFieldId,
        config,
        sampleRecords,
      );
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for conditional lookup samples after ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

const assertLookupFullScan = async (
  tableId: string,
  lookupFieldId: string,
  config: ConditionalLookupCaseConfig,
  hostFields: HostFields,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleRowOffsets = new Set(config.verify.sampleRows);
  const verifiedSamples = [];
  const seenRowNumbers = new Set<number>();
  let scannedRecords = 0;
  let pageCount = 0;

  for (let skip = 0; skip < config.recordCount; skip += pageSize) {
    const expectedTake = Math.min(pageSize, config.recordCount - skip);
    const result = await getRecords(tableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [
        hostFields.keyFieldId,
        hostFields.lookupKeyFieldId,
        lookupFieldId,
      ],
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
      const hostRowNumber = parseRowNumber(
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
        verifiedSamples.push({
          rowOffset,
          rowNumber: hostRowNumber,
          sourceRowNumber,
          recordId: record.id,
          actual,
          expected,
        });
      }
      scannedRecords += 1;
    }
  }

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

  return {
    scannedRecords,
    pageSize,
    pageCount,
    verifiedSamples: verifiedSamples.sort(
      (left, right) => left.rowOffset - right.rowOffset,
    ),
  };
};

const waitForLookupFullScan = async (
  tableId: string,
  lookupFieldId: string,
  config: ConditionalLookupCaseConfig,
  hostFields: HostFields,
) => {
  const startedAt = Date.now();
  const timeoutMs = config.verify.timeoutMs ?? 60_000;
  const pollIntervalMs = config.verify.pollIntervalMs ?? 500;
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await assertLookupFullScan(
        tableId,
        lookupFieldId,
        config,
        hostFields,
      );
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for full conditional lookup scan after ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

const assertConditionalLookupSeedReady = async (
  sourceTableId: string,
  hostTableId: string,
  sourceFields: SourceFields,
  hostFields: HostFields,
  config: ConditionalLookupCaseConfig,
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

  const lastHostRowNumber = parseRowNumber(
    lastHostRecord.fields[hostFields.keyFieldId],
    config.generator.hostKeyPrefix,
  );
  const lastSourceRowNumber = parseRowNumber(
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
  config: ConditionalLookupCaseConfig,
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
            withPerfTraceStep(
              context,
              perfCase,
              `seedSourceBatch:${batchIndex + 1}`,
              () =>
                createRecords(sourceTableId, {
                  fieldKeyType: FieldKeyType.Name,
                  records: batch.map(({ fields }) => ({ fields })),
                }),
            ),
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
  config: ConditionalLookupCaseConfig,
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
            withPerfTraceStep(
              context,
              perfCase,
              `seedHostBatch:${batchIndex + 1}`,
              () =>
                createRecords(hostTableId, {
                  fieldKeyType: FieldKeyType.Name,
                  records: batch.map(({ fields }) => ({ fields })),
                }),
            ),
        );
        hostBatchDurations.push(batchMeasurement.durationMs);
        expect(batchMeasurement.result.records).toHaveLength(batch.length);
        batchMeasurement.result.records.forEach((record, index) => {
          const input = batch[index];
          if (input && wantedSampleOffsets.has(input.rowOffset)) {
            seededSampleRecordByOffset.set(input.rowOffset, {
              rowOffset: input.rowOffset,
              rowNumber: input.rowNumber,
              recordId: record.id,
            });
          }
        });
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
  config: ConditionalLookupCaseConfig,
  seedCacheInfo: SeedCacheInfo,
): Promise<ConditionalLookupSeedFixture> => {
  const createdTableIds: string[] = [];

  try {
    const createTablesMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      seedCacheInfo.enabled ? "seedBuild:createTables" : "createTables",
      () =>
        measureAsync(
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
        ),
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
  config: ConditionalLookupCaseConfig,
  seedCacheInfo: SeedCacheInfo,
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
    await cleanupHostLookupFields(hostTable.id, hostTableFields);
    const cleanedHostTableFields = await getFields(hostTable.id);
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

const buildConditionalLookupSeedFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  sourceTableName: string,
  hostTableName: string,
  config: ConditionalLookupCaseConfig,
  seedCacheInfo: SeedCacheInfo,
) =>
  (await restoreConditionalLookupSeedFixture(
    baseId,
    sourceTableName,
    hostTableName,
    config,
    seedCacheInfo,
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
  createLookupFieldMeasurement?: Measurement<{ id: string }>;
  fullLookupScanReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof waitForLookupFullScan>>
  >;
  lookupField?: { id: string };
  seedCacheInfo?: SeedCacheInfo;
  seedCacheHit?: boolean;
  reusableSeed?: boolean;
  sourceFields: SourceFields;
  hostFields: HostFields;
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

export const seedConditionalLookupCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as ConditionalLookupCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const timestamp = Date.now();
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "conditional-lookup",
    fixtureVersion: "conditional-lookup-v1",
    seedConfig: getConditionalLookupSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
  const sourceTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "source")
    : `${config.sourceTableNamePrefix}-seed-${timestamp}`;
  const hostTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "host")
    : `${config.hostTableNamePrefix}-seed-${timestamp}`;

  assertPermutationConfig(config);
  const seedFixture = await buildConditionalLookupSeedFixture(
    perfCase,
    context,
    baseId,
    sourceTableName,
    hostTableName,
    config,
    seedCacheInfo,
  );
  const seedReadyMeasurement = await withPerfTraceStep(
    context,
    perfCase,
    "seedReady",
    () =>
      measureAsync("seedReady", () =>
        assertConditionalLookupSeedReady(
          seedFixture.sourceTableId,
          seedFixture.hostTableId,
          seedFixture.sourceFields,
          seedFixture.hostFields,
          config,
          seedFixture.sampleRecords,
        ),
      ),
  );

  return buildConditionalLookupCaseResult({
    config,
    sourceTableId: seedFixture.sourceTableId,
    sourceTableName: seedFixture.sourceTableName,
    hostTableId: seedFixture.hostTableId,
    hostTableName: seedFixture.hostTableName,
    sourceBatchDurations: seedFixture.sourceBatchDurations,
    hostBatchDurations: seedFixture.hostBatchDurations,
    sampleRecords: seedFixture.sampleRecords,
    createTablesMeasurement: seedFixture.createTablesMeasurement,
    seedSourceMeasurement: seedFixture.seedSourceMeasurement,
    seedHostMeasurement: seedFixture.seedHostMeasurement,
    seedReadyMeasurement,
    seedCacheInfo,
    seedCacheHit: seedFixture.seedCacheHit,
    reusableSeed: seedFixture.reusable,
    sourceFields: seedFixture.sourceFields,
    hostFields: seedFixture.hostFields,
  });
};

export const runConditionalLookupCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as ConditionalLookupCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const timestamp = Date.now();
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "conditional-lookup",
    fixtureVersion: "conditional-lookup-v1",
    seedConfig: getConditionalLookupSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
  const sourceTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "source")
    : `${config.sourceTableNamePrefix}-${timestamp}`;
  const hostTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "host")
    : `${config.hostTableNamePrefix}-${timestamp}`;
  let sourceTableId = "";
  let hostTableId = "";
  let reusableSeed = false;
  let createdLookupFieldId = "";

  try {
    assertPermutationConfig(config);

    const seedFixture = await buildConditionalLookupSeedFixture(
      perfCase,
      context,
      baseId,
      sourceTableName,
      hostTableName,
      config,
      seedCacheInfo,
    );
    sourceTableId = seedFixture.sourceTableId;
    hostTableId = seedFixture.hostTableId;
    reusableSeed = seedFixture.reusable;
    const {
      sourceTableName: actualSourceTableName,
      hostTableName: actualHostTableName,
      sourceFields,
      hostFields,
      sampleRecords,
      sourceBatchDurations,
      hostBatchDurations,
      createTablesMeasurement,
      seedSourceMeasurement,
      seedHostMeasurement,
      seedCacheHit,
    } = seedFixture;
    let createdLookupField: { id: string } | undefined;
    let seedReadyMeasurement:
      | Measurement<
          Awaited<ReturnType<typeof assertConditionalLookupSeedReady>>
        >
      | undefined;

    try {
      seedReadyMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        "seedReady",
        () =>
          measureAsync("seedReady", () =>
            assertConditionalLookupSeedReady(
              sourceTableId,
              hostTableId,
              sourceFields,
              hostFields,
              config,
              sampleRecords,
            ),
          ),
      );

      const createLookupFieldMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        "createLookupField",
        () =>
          measureAsync("createLookupField", () =>
            createField(hostTableId, {
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
            }),
          ),
      );
      createdLookupField = createLookupFieldMeasurement.result;
      createdLookupFieldId = createdLookupField.id;

      const fullLookupScanReadyMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        "fullLookupScanReady",
        () =>
          measureAsync("fullLookupScanReady", () =>
            waitForLookupFullScan(
              hostTableId,
              createLookupFieldMeasurement.result.id,
              config,
              hostFields,
            ),
          ),
      );

      return buildConditionalLookupCaseResult({
        config,
        sourceTableId,
        sourceTableName: actualSourceTableName,
        hostTableId,
        hostTableName: actualHostTableName,
        sourceBatchDurations,
        hostBatchDurations,
        sampleRecords,
        createTablesMeasurement,
        seedSourceMeasurement,
        seedHostMeasurement,
        seedReadyMeasurement,
        createLookupFieldMeasurement,
        fullLookupScanReadyMeasurement,
        lookupField: createdLookupField,
        seedCacheInfo,
        seedCacheHit,
        reusableSeed,
        sourceFields,
        hostFields,
      });
    } catch (error) {
      const diagnosticResult = buildConditionalLookupCaseResult({
        config,
        sourceTableId,
        sourceTableName: actualSourceTableName,
        hostTableId,
        hostTableName: actualHostTableName,
        sourceBatchDurations,
        hostBatchDurations,
        sampleRecords,
        createTablesMeasurement,
        seedSourceMeasurement,
        seedHostMeasurement,
        seedReadyMeasurement,
        lookupField: createdLookupField,
        seedCacheInfo,
        seedCacheHit,
        reusableSeed,
        sourceFields,
        hostFields,
        error,
      });

      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        diagnosticResult,
      );
    }
  } finally {
    if (reusableSeed) {
      if (createdLookupFieldId) {
        try {
          await deleteField(hostTableId, createdLookupFieldId);
        } catch (error) {
          console.warn(
            `Failed to cleanup perf lookup field ${createdLookupFieldId}`,
            error,
          );
        }
      }
    } else {
      for (const tableId of [hostTableId, sourceTableId]) {
        if (tableId) {
          try {
            await permanentDeleteTable(baseId, tableId);
          } catch (error) {
            console.warn(`Failed to cleanup perf table ${tableId}`, error);
          }
        }
      }
    }
  }
};
