import { FieldKeyType, FieldType, generateFieldId } from "@teable/core";
import {
  createField,
  createRecords,
  createTable,
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

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const buildNumericSequenceRecords = (config: FormulaTableCaseConfig) =>
  Array.from({ length: config.recordCount }, (_, index) => {
    const rowNumber = index + 1;
    return {
      fields: {
        Title: `${config.generator.titlePrefix} ${rowNumber}`,
        A: rowNumber,
        B: (rowNumber % 97) + 1,
        C: rowNumber % 13,
      },
    };
  });

const ensureFieldIds = (fields: FormulaTableCaseConfig["fields"]) =>
  fields.map((field) => ({
    ...field,
    id: field.id ?? generateFieldId(),
  }));

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

const assertFormulaSamples = async (
  tableId: string,
  formulaName: string,
  sampleRows: number[],
) => {
  const verifiedSamples = [];

  for (const sampleRow of sampleRows) {
    const page = await getRecords(tableId, {
      fieldKeyType: FieldKeyType.Name,
      skip: sampleRow,
      take: 1,
    });
    const record = page.records[0];
    expect(record).toBeTruthy();

    const rowNumber = sampleRow + 1;
    const expected = rowNumber * ((rowNumber % 97) + 1) + (rowNumber % 13);
    expect(record.fields[formulaName]).toBe(expected);

    verifiedSamples.push({
      rowOffset: sampleRow,
      rowNumber,
      recordId: record.id,
      actual: record.fields[formulaName],
      expected,
    });
  }

  return verifiedSamples;
};

export const runFormulaTableCase = async (
  perfCase: PerfCase,
  _context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FormulaTableCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const fields = ensureFieldIds(config.fields);
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  let tableId = "";

  try {
    const createTableMeasurement = await measureAsync("createTable", () =>
      createTable(baseId, {
        name: tableName,
        fields,
      }),
    );
    tableId = createTableMeasurement.result.id;

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

    const compiledExpression = compileFormulaExpression(
      config.formula.expression,
      fields,
    );
    const formulaReadyMeasurement = await measureAsync(
      "formulaReady",
      async () => {
        const formulaField = await createField(tableId, {
          type: FieldType.Formula,
          name: config.formula.name,
          options: {
            expression: compiledExpression,
          },
        });
        const verifiedSamples = await assertFormulaSamples(
          tableId,
          config.formula.name,
          config.verify.sampleRows,
        );
        return {
          formulaField,
          verifiedSamples,
        };
      },
    );

    const metrics = {
      createTableMs: createTableMeasurement.durationMs,
      seedRecordsMs: seedMeasurement.durationMs,
      formulaReadyMs: formulaReadyMeasurement.durationMs,
      maxSeedBatchMs: roundMetric(Math.max(...batchDurations)),
    };

    return {
      metrics,
      thresholds: [
        {
          metric: config.threshold.metric,
          max: getPrimaryThresholdMs(config.threshold.maxMs),
          unit: "ms",
        },
      ],
      phases: [
        {
          name: createTableMeasurement.name,
          durationMs: createTableMeasurement.durationMs,
        },
        { name: seedMeasurement.name, durationMs: seedMeasurement.durationMs },
        {
          name: formulaReadyMeasurement.name,
          durationMs: formulaReadyMeasurement.durationMs,
        },
      ],
      details: {
        tableId,
        tableName,
        recordCount: config.recordCount,
        batchSize: config.batchSize,
        batchCount: batches.length,
        formula: {
          fieldId: formulaReadyMeasurement.result.formulaField.id,
          name: config.formula.name,
          expression: config.formula.expression,
          compiledExpression,
        },
        verifiedSamples: formulaReadyMeasurement.result.verifiedSamples,
      },
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
