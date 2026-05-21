import { FieldKeyType, FieldType } from "@teable/core";
import {
  createField,
  createRecords,
  createTable,
  getRecord,
  getRecords,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs } from "../env";
import { measureAsync, roundMetric } from "../metrics";
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

type HostFields = {
  keyFieldId: string;
  lookupKeyFieldId: string;
};

const SOURCE_KEY_FIELD_NAME = "A Key";
const SOURCE_VALUE_FIELD_NAME = "A Value";
const HOST_KEY_FIELD_NAME = "B Key";
const HOST_LOOKUP_KEY_FIELD_NAME = "Lookup A Key";

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
  createLookupFieldMeasurement,
  fullLookupScanReadyMeasurement,
  lookupField,
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
  createLookupFieldMeasurement?: Measurement<{ id: string }>;
  fullLookupScanReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof waitForLookupFullScan>>
  >;
  lookupField?: { id: string };
  sourceFields: {
    keyFieldId: string;
    valueFieldId: string;
  };
  hostFields: HostFields;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    createTablesMs: createTablesMeasurement.durationMs,
    seedSourceRecordsMs: seedSourceMeasurement.durationMs,
    seedHostRecordsMs: seedHostMeasurement.durationMs,
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
    sourceTableId,
    sourceTableName,
    hostTableId,
    hostTableName,
    recordCount: config.recordCount,
    batchSize: config.batchSize,
    sourceFields,
    hostFields,
    sampleRecords,
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

export const runConditionalLookupCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as ConditionalLookupCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const timestamp = Date.now();
  const sourceTableName = `${config.sourceTableNamePrefix}-${timestamp}`;
  const hostTableName = `${config.hostTableNamePrefix}-${timestamp}`;
  let sourceTableId = "";
  let hostTableId = "";

  try {
    assertPermutationConfig(config);

    const createTablesMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      "createTables",
      () =>
        measureAsync("createTables", async () => {
          const sourceTable = await createTable(baseId, {
            name: sourceTableName,
            fields: [
              { name: SOURCE_KEY_FIELD_NAME, type: FieldType.SingleLineText },
              { name: SOURCE_VALUE_FIELD_NAME, type: FieldType.SingleLineText },
            ],
            records: [],
          });
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
          return { sourceTable, hostTable };
        }),
    );
    sourceTableId = createTablesMeasurement.result.sourceTable.id;
    hostTableId = createTablesMeasurement.result.hostTable.id;

    const sourceFields = {
      keyFieldId: createTablesMeasurement.result.sourceTable.fields[0].id,
      valueFieldId: createTablesMeasurement.result.sourceTable.fields[1].id,
    };
    const hostFields = {
      keyFieldId: createTablesMeasurement.result.hostTable.fields[0].id,
      lookupKeyFieldId: createTablesMeasurement.result.hostTable.fields[1].id,
    };
    const sourceRecords = buildSourceRecords(config);
    const hostRecords = buildHostRecords(config);
    const sourceBatches = chunk(sourceRecords, config.batchSize);
    const hostBatches = chunk(hostRecords, config.batchSize);
    const sourceBatchDurations: number[] = [];
    const hostBatchDurations: number[] = [];
    const wantedSampleOffsets = new Set(config.verify.sampleRows);
    const seededSampleRecordByOffset = new Map<number, SeededSampleRecord>();

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

    const sampleRecords = getRequiredSampleRecords(
      config,
      seededSampleRecordByOffset,
    );
    let createdLookupField: { id: string } | undefined;

    try {
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
        sourceTableName,
        hostTableId,
        hostTableName,
        sourceBatchDurations,
        hostBatchDurations,
        sampleRecords,
        createTablesMeasurement,
        seedSourceMeasurement,
        seedHostMeasurement,
        createLookupFieldMeasurement,
        fullLookupScanReadyMeasurement,
        lookupField: createdLookupField,
        sourceFields,
        hostFields,
      });
    } catch (error) {
      const diagnosticResult = buildConditionalLookupCaseResult({
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
        lookupField: createdLookupField,
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
};
