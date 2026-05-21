import { FieldKeyType, FieldType } from "@teable/core";
import {
  createField,
  createRecords,
  createTable,
  getFields,
  getRecord,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs } from "../env";
import { measureAsync, roundMetric } from "../metrics";
import type {
  FormulaTableCaseConfig,
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

type NamedField = { id: string; name: string };

type SourceFields = {
  Title: NamedField;
  A: NamedField;
  B: NamedField;
  C: NamedField;
};

type SeedRecordInput = {
  rowOffset: number;
  rowNumber: number;
  record: {
    fields: {
      Title: string | number;
      A: string | number;
      B: string | number;
      C: string | number;
    };
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

const sourceFieldNames = ["Title", "A", "B", "C"] as const;

const resolveSourceFields = (fields: NamedField[]): SourceFields => {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  const missingFields = sourceFieldNames.filter(
    (fieldName) => !fieldByName.has(fieldName),
  );

  if (missingFields.length > 0) {
    throw new Error(
      `Missing formula source fields: ${missingFields.join(
        ", ",
      )}; available fields: ${fields.map((field) => field.name).join(", ")}`,
    );
  }

  return {
    Title: fieldByName.get("Title")!,
    A: fieldByName.get("A")!,
    B: fieldByName.get("B")!,
    C: fieldByName.get("C")!,
  };
};

const getExpectedRow = (
  rowNumber: number,
  titlePrefix: string,
): Record<keyof SourceFields | "Total", string | number> => {
  const a = rowNumber;
  const b = (rowNumber % 97) + 1;
  const c = rowNumber % 13;

  return {
    Title: `${titlePrefix} ${rowNumber}`,
    A: a,
    B: b,
    C: c,
    Total: a * b + c,
  };
};

const buildNumericSequenceRecords = (
  config: FormulaTableCaseConfig,
): SeedRecordInput[] =>
  Array.from({ length: config.recordCount }, (_, index) => {
    const rowNumber = index + 1;
    const expected = getExpectedRow(rowNumber, config.generator.titlePrefix);
    return {
      rowOffset: index,
      rowNumber,
      record: {
        fields: {
          Title: expected.Title,
          A: expected.A,
          B: expected.B,
          C: expected.C,
        },
      },
    };
  });

const compileFormulaExpression = (
  expression: string,
  fields: Array<FormulaTableCaseConfig["fields"][number] & { id: string }>,
) => {
  const fieldIdByName = new Map(fields.map((field) => [field.name, field.id]));
  return expression.replace(/\{([^}]+)\}/g, (match, fieldName: string) => {
    const fieldId = fieldIdByName.get(fieldName);
    return fieldId ? `{${fieldId}}` : match;
  });
};

const getRequiredSampleRecords = (
  config: FormulaTableCaseConfig,
  seededSampleRecordByOffset: Map<number, SeededSampleRecord>,
) =>
  config.verify.sampleRows.map((rowOffset) => {
    const sampleRecord = seededSampleRecordByOffset.get(rowOffset);
    if (!sampleRecord) {
      throw new Error(
        `Missing seeded sample record for row offset ${rowOffset}. recordCount=${config.recordCount}`,
      );
    }
    return sampleRecord;
  });

const assertSourceSamples = async (
  tableId: string,
  sourceFields: SourceFields,
  config: FormulaTableCaseConfig,
  sampleRecords: SeededSampleRecord[],
) => {
  const verifiedSamples = [];

  for (const sampleRecord of sampleRecords) {
    const record = await getRecord(tableId, sampleRecord.recordId);
    if (!record) {
      throw new Error(
        `Missing source sample record ${sampleRecord.recordId} at row ${sampleRecord.rowNumber}`,
      );
    }

    const expected = getExpectedRow(
      sampleRecord.rowNumber,
      config.generator.titlePrefix,
    );
    const actual = {
      Title: record.fields[sourceFields.Title.id],
      A: record.fields[sourceFields.A.id],
      B: record.fields[sourceFields.B.id],
      C: record.fields[sourceFields.C.id],
    };

    for (const fieldName of sourceFieldNames) {
      if (actual[fieldName] !== expected[fieldName]) {
        throw new Error(
          `Source sample mismatch at row ${sampleRecord.rowNumber}.${fieldName}: expected ${String(
            expected[fieldName],
          )}, actual ${String(actual[fieldName])}; row=${JSON.stringify(
            actual,
          )}`,
        );
      }
    }

    verifiedSamples.push({
      rowOffset: sampleRecord.rowOffset,
      rowNumber: sampleRecord.rowNumber,
      recordId: sampleRecord.recordId,
      actual,
      expected: {
        Title: expected.Title,
        A: expected.A,
        B: expected.B,
        C: expected.C,
      },
    });
  }

  return verifiedSamples;
};

const waitForSourceSamples = async (
  tableId: string,
  sourceFields: SourceFields,
  config: FormulaTableCaseConfig,
  sampleRecords: SeededSampleRecord[],
) => {
  const startedAt = Date.now();
  const timeoutMs = config.verify.timeoutMs ?? 30_000;
  const pollIntervalMs = config.verify.pollIntervalMs ?? 200;
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await assertSourceSamples(
        tableId,
        sourceFields,
        config,
        sampleRecords,
      );
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for source samples after ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

const assertFormulaSamples = async (
  tableId: string,
  formulaFieldId: string,
  sampleRecords: SeededSampleRecord[],
  config: FormulaTableCaseConfig,
) => {
  const verifiedSamples = [];

  for (const sampleRecord of sampleRecords) {
    const record = await getRecord(tableId, sampleRecord.recordId);
    if (!record) {
      throw new Error(
        `Missing sample record ${sampleRecord.recordId} at row ${sampleRecord.rowNumber}`,
      );
    }

    const expected = getExpectedRow(
      sampleRecord.rowNumber,
      config.generator.titlePrefix,
    ).Total;
    const actual = record.fields[formulaFieldId];
    if (actual !== expected) {
      throw new Error(
        `Formula sample mismatch at row ${sampleRecord.rowNumber}: expected ${expected}, actual ${String(
          actual,
        )}`,
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

const waitForFormulaSamples = async (
  tableId: string,
  formulaFieldId: string,
  sampleRecords: SeededSampleRecord[],
  config: FormulaTableCaseConfig,
  {
    timeoutMs = 30_000,
    pollIntervalMs = 200,
  }: { timeoutMs?: number; pollIntervalMs?: number } = {},
) => {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await assertFormulaSamples(
        tableId,
        formulaFieldId,
        sampleRecords,
        config,
      );
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for formula samples after ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

const buildFormulaCaseResult = ({
  config,
  tableId,
  tableName,
  batches,
  batchDurations,
  sampleRecords,
  createTableMeasurement,
  seedMeasurement,
  sourceReadyMeasurement,
  sourceFields,
  compiledExpression,
  formulaField,
  verifiedFormulaSamples,
  error,
}: {
  config: FormulaTableCaseConfig;
  tableId: string;
  tableName: string;
  batches: unknown[][];
  batchDurations: number[];
  sampleRecords: SeededSampleRecord[];
  createTableMeasurement: Measurement<unknown>;
  seedMeasurement: Measurement<unknown>;
  sourceReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof waitForSourceSamples>>
  >;
  sourceFields: SourceFields;
  compiledExpression: string;
  formulaField?: { id: string };
  verifiedFormulaSamples?: Awaited<ReturnType<typeof waitForFormulaSamples>>;
  error?: unknown;
}): PerfRunResult => {
  const metrics = {
    createTableMs: createTableMeasurement.durationMs,
    seedRecordsMs: seedMeasurement.durationMs,
    ...(sourceReadyMeasurement
      ? { sourceReadyMs: sourceReadyMeasurement.durationMs }
      : {}),
    ...(verifiedFormulaSamples
      ? { formulaReadyMs: sourceReadyMeasurement?.durationMs ?? 0 }
      : {}),
    maxSeedBatchMs: roundMetric(Math.max(...batchDurations)),
  };

  const phases = [
    {
      name: createTableMeasurement.name,
      durationMs: createTableMeasurement.durationMs,
    },
    { name: seedMeasurement.name, durationMs: seedMeasurement.durationMs },
    ...(sourceReadyMeasurement
      ? [
          {
            name: sourceReadyMeasurement.name,
            durationMs: sourceReadyMeasurement.durationMs,
          },
        ]
      : []),
  ];

  return {
    metrics,
    thresholds: verifiedFormulaSamples
      ? [
          {
            metric: config.threshold.metric,
            max: getPrimaryThresholdMs(config.threshold.maxMs),
            unit: "ms",
          },
        ]
      : [],
    phases,
    details: {
      tableId,
      tableName,
      recordCount: config.recordCount,
      batchSize: config.batchSize,
      batchCount: batches.length,
      fields: sourceFieldNames.map((fieldName) => ({
        name: sourceFields[fieldName].name,
        id: sourceFields[fieldName].id,
      })),
      sampleRecords,
      verifiedSourceSamples: sourceReadyMeasurement?.result,
      formula: {
        fieldId: formulaField?.id,
        name: config.formula.name,
        expression: config.formula.expression,
        compiledExpression,
      },
      verifiedSamples: verifiedFormulaSamples,
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

export const runFormulaTableCase = async (
  perfCase: PerfCase,
  _context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FormulaTableCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  let tableId = "";

  try {
    const createTableMeasurement = await measureAsync("createTable", () =>
      createTable(baseId, {
        name: tableName,
        fields: config.fields,
        records: [],
      }),
    );
    tableId = createTableMeasurement.result.id;

    const tableFields = await getFields(tableId);
    const sourceFields = resolveSourceFields(tableFields);
    const records = buildNumericSequenceRecords(config);
    const batches = chunk(records, config.batchSize);
    const batchDurations: number[] = [];
    const wantedSampleOffsets = new Set(config.verify.sampleRows);
    const seededSampleRecordByOffset = new Map<number, SeededSampleRecord>();

    const seedMeasurement = await measureAsync("seedRecords", async () => {
      for (const [batchIndex, batch] of batches.entries()) {
        const batchMeasurement = await measureAsync(
          `seedBatch:${batchIndex + 1}`,
          () =>
            createRecords(tableId, {
              fieldKeyType: FieldKeyType.Name,
              records: batch.map((item) => item.record),
            }),
        );
        batchDurations.push(batchMeasurement.durationMs);
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
    });

    const sampleRecords = getRequiredSampleRecords(
      config,
      seededSampleRecordByOffset,
    );
    const compiledExpression = compileFormulaExpression(
      config.formula.expression,
      tableFields,
    );
    let sourceReadyMeasurement: Awaited<
      ReturnType<
        typeof measureAsync<Awaited<ReturnType<typeof waitForSourceSamples>>>
      >
    >;

    try {
      sourceReadyMeasurement = await measureAsync("sourceReady", () =>
        waitForSourceSamples(tableId, sourceFields, config, sampleRecords),
      );
    } catch (error) {
      const diagnosticResult = buildFormulaCaseResult({
        config,
        tableId,
        tableName,
        batches,
        batchDurations,
        sampleRecords,
        createTableMeasurement,
        seedMeasurement,
        sourceFields,
        compiledExpression,
        error,
      });

      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        diagnosticResult,
      );
    }

    let formulaReadyMeasurement: Awaited<
      ReturnType<
        typeof measureAsync<{
          formulaField: { id: string };
          verifiedSamples: Awaited<ReturnType<typeof waitForFormulaSamples>>;
        }>
      >
    >;
    let createdFormulaField: { id: string } | undefined;

    try {
      formulaReadyMeasurement = await measureAsync("formulaReady", async () => {
        const formulaField = await createField(tableId, {
          type: FieldType.Formula,
          name: config.formula.name,
          options: {
            expression: compiledExpression,
          },
        });
        createdFormulaField = formulaField;
        const verifiedSamples = await waitForFormulaSamples(
          tableId,
          formulaField.id,
          sampleRecords,
          config,
          {
            timeoutMs: config.verify.timeoutMs,
            pollIntervalMs: config.verify.pollIntervalMs,
          },
        );
        return {
          formulaField,
          verifiedSamples,
        };
      });
    } catch (error) {
      const diagnosticResult = buildFormulaCaseResult({
        config,
        tableId,
        tableName,
        batches,
        batchDurations,
        sampleRecords,
        createTableMeasurement,
        seedMeasurement,
        sourceReadyMeasurement,
        sourceFields,
        compiledExpression,
        formulaField: createdFormulaField,
        error,
      });

      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        diagnosticResult,
      );
    }

    const result = buildFormulaCaseResult({
      config,
      tableId,
      tableName,
      batches,
      batchDurations,
      sampleRecords,
      createTableMeasurement,
      seedMeasurement,
      sourceReadyMeasurement,
      sourceFields,
      compiledExpression,
      formulaField: formulaReadyMeasurement.result.formulaField,
      verifiedFormulaSamples: formulaReadyMeasurement.result.verifiedSamples,
    });

    return {
      ...result,
      metrics: {
        ...result.metrics,
        formulaReadyMs: formulaReadyMeasurement.durationMs,
      },
      phases: [
        ...(result.phases ?? []),
        {
          name: formulaReadyMeasurement.name,
          durationMs: formulaReadyMeasurement.durationMs,
        },
      ],
    };
  } finally {
    if (tableId) {
      try {
        await permanentDeleteTable(baseId, tableId);
      } catch (error) {
        console.warn(`Failed to cleanup perf table ${tableId}`, error);
      }
    }
  }
};
