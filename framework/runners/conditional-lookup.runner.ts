import { FieldKeyType, FieldType } from "@teable/core";
import {
  createField,
  createRecords,
  createTable,
  getRecord,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs } from "../env";
import { measureAsync, roundMetric } from "../metrics";
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
  fields: {
    Key: string;
    Value?: string;
  };
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

const getExpectedKey = (
  rowNumber: number,
  config: ConditionalLookupCaseConfig,
) => `${config.generator.keyPrefix}-${rowNumber}`;

const getExpectedValue = (
  rowNumber: number,
  config: ConditionalLookupCaseConfig,
) => `${config.generator.sourceValuePrefix}-${rowNumber}`;

const buildSourceRecords = (
  config: ConditionalLookupCaseConfig,
): SeedRecordInput[] =>
  Array.from({ length: config.recordCount }, (_, index) => {
    const rowNumber = index + 1;
    return {
      rowOffset: index,
      rowNumber,
      fields: {
        Key: getExpectedKey(rowNumber, config),
        Value: getExpectedValue(rowNumber, config),
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
        Key: getExpectedKey(rowNumber, config),
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
    const expected = [getExpectedValue(sampleRecord.rowNumber, config)];

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
  conditionalLookupReadyMeasurement,
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
  conditionalLookupReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof waitForLookupSamples>>
  >;
  lookupField?: { id: string };
  sourceFields: {
    keyFieldId: string;
    valueFieldId: string;
  };
  hostFields: {
    keyFieldId: string;
  };
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    createTablesMs: createTablesMeasurement.durationMs,
    seedSourceRecordsMs: seedSourceMeasurement.durationMs,
    seedHostRecordsMs: seedHostMeasurement.durationMs,
    ...(conditionalLookupReadyMeasurement
      ? {
          conditionalLookupReadyMs:
            conditionalLookupReadyMeasurement.durationMs,
        }
      : {}),
    maxSeedBatchMs: roundMetric(
      Math.max(...sourceBatchDurations, ...hostBatchDurations),
    ),
  },
  thresholds: conditionalLookupReadyMeasurement
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
    ...(conditionalLookupReadyMeasurement
      ? [
          {
            name: conditionalLookupReadyMeasurement.name,
            durationMs: conditionalLookupReadyMeasurement.durationMs,
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
    verifiedSamples: conditionalLookupReadyMeasurement?.result,
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
  _context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as ConditionalLookupCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const timestamp = Date.now();
  const sourceTableName = `${config.sourceTableNamePrefix}-${timestamp}`;
  const hostTableName = `${config.hostTableNamePrefix}-${timestamp}`;
  let sourceTableId = "";
  let hostTableId = "";

  try {
    const createTablesMeasurement = await measureAsync(
      "createTables",
      async () => {
        const sourceTable = await createTable(baseId, {
          name: sourceTableName,
          fields: [
            { name: "Key", type: FieldType.SingleLineText },
            { name: "Value", type: FieldType.SingleLineText },
          ],
          records: [],
        });
        const hostTable = await createTable(baseId, {
          name: hostTableName,
          fields: [{ name: "Key", type: FieldType.SingleLineText }],
          records: [],
        });
        return { sourceTable, hostTable };
      },
    );
    sourceTableId = createTablesMeasurement.result.sourceTable.id;
    hostTableId = createTablesMeasurement.result.hostTable.id;

    const sourceFields = {
      keyFieldId: createTablesMeasurement.result.sourceTable.fields[0].id,
      valueFieldId: createTablesMeasurement.result.sourceTable.fields[1].id,
    };
    const hostFields = {
      keyFieldId: createTablesMeasurement.result.hostTable.fields[0].id,
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
      const conditionalLookupReadyMeasurement = await measureAsync(
        "conditionalLookupReady",
        async () => {
          const lookupField = await createField(hostTableId, {
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
                    value: { type: "field", fieldId: hostFields.keyFieldId },
                  },
                ],
              },
              limit: config.lookup.limit,
            },
          });
          createdLookupField = lookupField;
          return waitForLookupSamples(
            hostTableId,
            lookupField.id,
            config,
            sampleRecords,
          );
        },
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
        conditionalLookupReadyMeasurement,
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
