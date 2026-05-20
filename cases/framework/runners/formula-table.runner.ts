import { FieldKeyType, FieldType } from "@teable/core";
import {
  createField,
  createRecords,
  createTable,
  getFields,
  getRecords,
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

const buildNumericSequenceRecords = (config: FormulaTableCaseConfig) =>
  Array.from({ length: config.recordCount }, (_, index) => {
    const rowNumber = index + 1;
    const expected = getExpectedRow(rowNumber, config.generator.titlePrefix);
    return {
      fields: {
        Title: expected.Title,
        A: expected.A,
        B: expected.B,
        C: expected.C,
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

const assertSourceSamples = async (
  tableId: string,
  sourceFields: SourceFields,
  config: FormulaTableCaseConfig,
) => {
  const verifiedSamples = [];

  for (const sampleRow of config.verify.sampleRows) {
    const page = await getRecords(tableId, {
      fieldKeyType: FieldKeyType.Name,
      skip: sampleRow,
      take: 1,
    });
    const record = page.records[0];
    if (!record) {
      throw new Error(
        `Missing source sample record at row offset ${sampleRow}`,
      );
    }

    const rowNumber = sampleRow + 1;
    const expected = getExpectedRow(rowNumber, config.generator.titlePrefix);
    const actual = {
      Title: record.fields[sourceFields.Title.name],
      A: record.fields[sourceFields.A.name],
      B: record.fields[sourceFields.B.name],
      C: record.fields[sourceFields.C.name],
    };

    for (const fieldName of sourceFieldNames) {
      if (actual[fieldName] !== expected[fieldName]) {
        throw new Error(
          `Source sample mismatch at row ${rowNumber}.${fieldName}: expected ${String(
            expected[fieldName],
          )}, actual ${String(actual[fieldName])}; row=${JSON.stringify(
            actual,
          )}`,
        );
      }
    }

    verifiedSamples.push({
      rowOffset: sampleRow,
      rowNumber,
      recordId: record.id,
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
) => {
  const startedAt = Date.now();
  const timeoutMs = config.verify.timeoutMs ?? 30_000;
  const pollIntervalMs = config.verify.pollIntervalMs ?? 200;
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await assertSourceSamples(tableId, sourceFields, config);
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
  sampleRows: number[],
  config: FormulaTableCaseConfig,
) => {
  const verifiedSamples = [];

  for (const sampleRow of sampleRows) {
    const page = await getRecords(tableId, {
      fieldKeyType: FieldKeyType.Id,
      skip: sampleRow,
      take: 1,
    });
    const record = page.records[0];
    if (!record) {
      throw new Error(`Missing sample record at row offset ${sampleRow}`);
    }

    const rowNumber = sampleRow + 1;
    const expected = getExpectedRow(
      rowNumber,
      config.generator.titlePrefix,
    ).Total;
    const actual = record.fields[formulaFieldId];
    if (actual !== expected) {
      throw new Error(
        `Formula sample mismatch at row ${rowNumber}: expected ${expected}, actual ${String(
          actual,
        )}`,
      );
    }

    verifiedSamples.push({
      rowOffset: sampleRow,
      rowNumber,
      recordId: record.id,
      actual,
      expected,
    });
  }

  return verifiedSamples;
};

const waitForFormulaSamples = async (
  tableId: string,
  formulaFieldId: string,
  sampleRows: number[],
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
        sampleRows,
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
  createTableMeasurement: { name: string; durationMs: number };
  seedMeasurement: { name: string; durationMs: number };
  sourceReadyMeasurement: {
    name: string;
    durationMs: number;
    result: Awaited<ReturnType<typeof waitForSourceSamples>>;
  };
  sourceFields: SourceFields;
  compiledExpression: string;
  formulaField?: { id: string };
  verifiedFormulaSamples?: Awaited<ReturnType<typeof waitForFormulaSamples>>;
  error?: unknown;
}): PerfRunResult => {
  const metrics = {
    createTableMs: createTableMeasurement.durationMs,
    seedRecordsMs: seedMeasurement.durationMs,
    sourceReadyMs: sourceReadyMeasurement.durationMs,
    ...(verifiedFormulaSamples
      ? { formulaReadyMs: sourceReadyMeasurement.durationMs }
      : {}),
    maxSeedBatchMs: roundMetric(Math.max(...batchDurations)),
  };

  const phases = [
    {
      name: createTableMeasurement.name,
      durationMs: createTableMeasurement.durationMs,
    },
    { name: seedMeasurement.name, durationMs: seedMeasurement.durationMs },
    {
      name: sourceReadyMeasurement.name,
      durationMs: sourceReadyMeasurement.durationMs,
    },
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
      verifiedSourceSamples: sourceReadyMeasurement.result,
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
      }),
    );
    tableId = createTableMeasurement.result.id;

    const tableFields = await getFields(tableId);
    const sourceFields = resolveSourceFields(tableFields);
    const records = buildNumericSequenceRecords(config);
    const batches = chunk(records, config.batchSize);
    const batchDurations: number[] = [];

    const seedMeasurement = await measureAsync("seedRecords", async () => {
      for (const [batchIndex, batch] of batches.entries()) {
        const batchMeasurement = await measureAsync(
          `seedBatch:${batchIndex + 1}`,
          () =>
            createRecords(tableId, {
              fieldKeyType: FieldKeyType.Name,
              records: batch,
            }),
        );
        batchDurations.push(batchMeasurement.durationMs);
        expect(batchMeasurement.result.records).toHaveLength(batch.length);
      }
    });

    const sourceReadyMeasurement = await measureAsync("sourceReady", () =>
      waitForSourceSamples(tableId, sourceFields, config),
    );
    const compiledExpression = compileFormulaExpression(
      config.formula.expression,
      tableFields,
    );
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
          config.verify.sampleRows,
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
