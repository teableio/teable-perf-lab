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
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { withPerfTraceStep } from "../trace-collector";
import type {
  FormulaFieldCaseConfig,
  FormulaExpectedKind,
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

type FormulaRunResult = {
  formula: FormulaFieldCaseConfig & {
    id: string;
    compiledExpression: string;
  };
  durationMs: number;
  verifiedSamples: Awaited<ReturnType<typeof waitForFormulaSamples>>;
};

type FormulaSeedFixture = {
  tableId: string;
  tableName: string;
  sourceFields: SourceFields;
  sampleRecords: SeededSampleRecord[];
  batches: unknown[][];
  batchDurations: number[];
  createTableMeasurement: Measurement<unknown>;
  seedMeasurement: Measurement<unknown>;
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusable: boolean;
};

type CompiledFormula = FormulaFieldCaseConfig & {
  compiledExpression: string;
  id?: string;
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
): Record<keyof SourceFields, string | number> & {
  formulaValues: Record<FormulaExpectedKind, number>;
} => {
  const a = rowNumber;
  const b = (rowNumber % 97) + 1;
  const c = rowNumber % 13;

  return {
    Title: `${titlePrefix} ${rowNumber}`,
    A: a,
    B: b,
    C: c,
    formulaValues: {
      aTimesBPlusC: a * b + c,
      aPlusBPlusC: a + b + c,
      aTimesCPlusB: a * c + b,
      aPlusBTimesC: a + b * c,
      weightedABC: a * 3 + b * 5 + c * 7,
    },
  };
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

const resolveFormulas = (
  config: FormulaTableCaseConfig,
): FormulaFieldCaseConfig[] => {
  const formulas = config.formulas ?? (config.formula ? [config.formula] : []);
  if (formulas.length === 0) {
    throw new Error("Formula table case must define formula or formulas");
  }
  return formulas.map((formula) => ({
    expected: "aTimesBPlusC",
    ...formula,
  }));
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

const buildCompiledFormulas = (
  config: FormulaTableCaseConfig,
  fields: Array<FormulaTableCaseConfig["fields"][number] & { id: string }>,
) =>
  resolveFormulas(config).map((formula) => ({
    ...formula,
    compiledExpression: compileFormulaExpression(formula.expression, fields),
  }));

const getFormulaSeedConfig = (config: FormulaTableCaseConfig) => ({
  baseId: config.baseId,
  tableNamePrefix: config.tableNamePrefix,
  recordCount: config.recordCount,
  batchSize: config.batchSize,
  fields: config.fields,
  generator: config.generator,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: "formula-table-v1",
});

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

const getCachedSampleRecords = async (
  tableId: string,
  sourceFields: SourceFields,
  config: FormulaTableCaseConfig,
): Promise<SeededSampleRecord[]> => {
  const sampleRecords = [];
  for (const rowOffset of config.verify.sampleRows) {
    const expectedRowNumber = rowOffset + 1;
    const result = await getRecords(tableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [sourceFields.Title.id],
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(
        `Missing cached seed sample at row offset ${rowOffset}; recordCount=${config.recordCount}`,
      );
    }
    const rowNumber = parseTitleRowNumber(
      record.fields[sourceFields.Title.id],
      config.generator.titlePrefix,
    );
    if (rowNumber !== expectedRowNumber) {
      throw new Error(
        `Cached seed sample row mismatch: expected row ${expectedRowNumber}, got ${rowNumber}`,
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

const cleanupCachedFormulaFields = async (
  tableId: string,
  fields: NamedField[],
) => {
  const sourceFieldNameSet = new Set<string>(sourceFieldNames);
  const extraFields = fields.filter(
    (field) => !sourceFieldNameSet.has(field.name),
  );
  for (const field of extraFields) {
    await deleteField(tableId, field.id);
  }
};

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

  const lastPage = await getRecords(tableId, {
    fieldKeyType: FieldKeyType.Id,
    projection: [sourceFields.Title.id],
    skip: config.recordCount - 1,
    take: 1,
  });
  const lastRecord = lastPage.records[0];
  if (!lastRecord) {
    throw new Error(
      `Missing final source seed row at offset ${config.recordCount - 1}`,
    );
  }

  const lastRowNumber = parseTitleRowNumber(
    lastRecord.fields[sourceFields.Title.id],
    config.generator.titlePrefix,
  );
  if (lastRowNumber !== config.recordCount) {
    throw new Error(
      `Final source seed row mismatch: expected row ${config.recordCount}, got ${lastRowNumber}`,
    );
  }

  const beyondLastPage = await getRecords(tableId, {
    fieldKeyType: FieldKeyType.Id,
    projection: [sourceFields.Title.id],
    skip: config.recordCount,
    take: 1,
  });
  if (beyondLastPage.records.length !== 0) {
    throw new Error(
      `Source seed has extra rows after expected recordCount=${config.recordCount}`,
    );
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
  formula: FormulaFieldCaseConfig & { id: string },
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

    const expectedKind = formula.expected ?? "aTimesBPlusC";
    const expected = getExpectedRow(
      sampleRecord.rowNumber,
      config.generator.titlePrefix,
    ).formulaValues[expectedKind];
    const actual = record.fields[formula.id];
    if (actual !== expected) {
      throw new Error(
        `Formula ${formula.name} sample mismatch at row ${sampleRecord.rowNumber}: expected ${expected}, actual ${String(
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
  formula: FormulaFieldCaseConfig & { id: string },
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
        formula,
        sampleRecords,
        config,
      );
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for formula ${formula.name} samples after ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

const assertFormulaFullScan = async (
  tableId: string,
  formulas: Array<FormulaFieldCaseConfig & { id: string }>,
  config: FormulaTableCaseConfig,
  sourceFields: SourceFields,
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
        sourceFields.Title.id,
        ...formulas.map((formula) => formula.id),
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
      const rowNumber = parseTitleRowNumber(
        record.fields[sourceFields.Title.id],
        config.generator.titlePrefix,
      );
      if (seenRowNumbers.has(rowNumber)) {
        throw new Error(
          `Duplicate formula row number in full scan: ${rowNumber}`,
        );
      }
      seenRowNumbers.add(rowNumber);

      const expectedRow = getExpectedRow(
        rowNumber,
        config.generator.titlePrefix,
      );
      const verifiedFormulaValues = [];

      for (const formula of formulas) {
        const expectedKind = formula.expected ?? "aTimesBPlusC";
        const expected = expectedRow.formulaValues[expectedKind];
        const actual = record.fields[formula.id];
        if (actual !== expected) {
          throw new Error(
            `Formula ${formula.name} full scan mismatch at row ${rowNumber}: expected ${expected}, actual ${String(
              actual,
            )}`,
          );
        }

        verifiedFormulaValues.push({
          name: formula.name,
          fieldId: formula.id,
          actual,
          expected,
        });
      }

      const rowOffset = rowNumber - 1;
      if (sampleRowOffsets.has(rowOffset)) {
        verifiedSamples.push({
          rowOffset,
          rowNumber,
          recordId: record.id,
          formulas: verifiedFormulaValues,
        });
      }
      scannedRecords += 1;
    }
  }

  if (scannedRecords !== config.recordCount) {
    throw new Error(
      `Full formula scan record count mismatch: expected ${config.recordCount}, scanned ${scannedRecords}`,
    );
  }

  if (seenRowNumbers.size !== config.recordCount) {
    throw new Error(
      `Full formula scan unique row mismatch: expected ${config.recordCount}, got ${seenRowNumbers.size}`,
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

const waitForFormulaFullScan = async (
  tableId: string,
  formulas: Array<FormulaFieldCaseConfig & { id: string }>,
  config: FormulaTableCaseConfig,
  sourceFields: SourceFields,
) => {
  const startedAt = Date.now();
  const timeoutMs = config.verify.timeoutMs ?? 30_000;
  const pollIntervalMs = config.verify.pollIntervalMs ?? 200;
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await assertFormulaFullScan(
        tableId,
        formulas,
        config,
        sourceFields,
      );
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for full formula scan after ${timeoutMs}ms: ${
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
  formulas,
  formulasReadyMeasurement,
  fullFormulaScanReadyMeasurement,
  seedCacheInfo,
  seedCacheHit,
  reusableSeed,
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
  formulas: Array<
    FormulaFieldCaseConfig & { compiledExpression: string; id?: string }
  >;
  formulasReadyMeasurement?: Measurement<FormulaRunResult[]>;
  fullFormulaScanReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof waitForFormulaFullScan>>
  >;
  seedCacheInfo?: SeedCacheInfo;
  seedCacheHit?: boolean;
  reusableSeed?: boolean;
  error?: unknown;
}): PerfRunResult => {
  const formulaResults = formulasReadyMeasurement?.result;
  const fullReadyMs =
    formulasReadyMeasurement && fullFormulaScanReadyMeasurement
      ? roundMetric(
          formulasReadyMeasurement.durationMs +
            fullFormulaScanReadyMeasurement.durationMs,
        )
      : undefined;
  const metrics = {
    ...(seedCacheInfo
      ? {
          seedCacheHit: seedCacheHit ? 1 : 0,
          seedCacheEnabled: seedCacheInfo.enabled ? 1 : 0,
          ...(seedCacheHit
            ? { seedRestoreMs: createTableMeasurement.durationMs }
            : seedCacheInfo.enabled
              ? {
                  seedBuildMs: roundMetric(
                    createTableMeasurement.durationMs +
                      seedMeasurement.durationMs,
                  ),
                }
              : {}),
        }
      : {}),
    createTableMs: createTableMeasurement.durationMs,
    seedRecordsMs: seedMeasurement.durationMs,
    ...(sourceReadyMeasurement
      ? {
          sourceReadyMs: sourceReadyMeasurement.durationMs,
          seedReadyMs: sourceReadyMeasurement.durationMs,
        }
      : {}),
    ...(formulaResults?.length === 1
      ? { formulaReadyMs: formulasReadyMeasurement.durationMs }
      : {}),
    ...(formulaResults && formulaResults.length > 1
      ? { formulasReadyMs: formulasReadyMeasurement.durationMs }
      : {}),
    ...(fullFormulaScanReadyMeasurement
      ? { fullFormulaScanReadyMs: fullFormulaScanReadyMeasurement.durationMs }
      : {}),
    ...(formulaResults?.length === 1 && fullReadyMs !== undefined
      ? { formulaFullReadyMs: fullReadyMs }
      : {}),
    ...(formulaResults && formulaResults.length > 1 && fullReadyMs !== undefined
      ? { formulasFullReadyMs: fullReadyMs }
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
    ...(fullFormulaScanReadyMeasurement
      ? [
          {
            name: fullFormulaScanReadyMeasurement.name,
            durationMs: fullFormulaScanReadyMeasurement.durationMs,
          },
        ]
      : []),
  ];

  return {
    metrics,
    thresholds: formulaResults
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
      seed: seedCacheInfo
        ? {
            enabled: seedCacheInfo.enabled,
            seedHash: seedCacheInfo.seedHash,
            seedHashShort: seedCacheInfo.seedHashShort,
            seedNamePrefix: seedCacheInfo.seedNamePrefix,
            seedTableName: seedCacheInfo.seedTableName,
            schemaSignature: seedCacheInfo.schemaSignature,
            cacheHit: Boolean(seedCacheHit),
            reusable: Boolean(reusableSeed),
          }
        : undefined,
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
      formulas: formulas.map((formula) => ({
        fieldId: formula.id,
        name: formula.name,
        expression: formula.expression,
        compiledExpression: formula.compiledExpression,
        expected: formula.expected,
      })),
      formulaResults: formulaResults?.map((result) => ({
        name: result.formula.name,
        fieldId: result.formula.id,
        durationMs: result.durationMs,
        verifiedSamples: result.verifiedSamples,
      })),
      fullScan: fullFormulaScanReadyMeasurement?.result
        ? {
            scannedRecords:
              fullFormulaScanReadyMeasurement.result.scannedRecords,
            pageSize: fullFormulaScanReadyMeasurement.result.pageSize,
            pageCount: fullFormulaScanReadyMeasurement.result.pageCount,
          }
        : undefined,
      verifiedFullScanSamples:
        fullFormulaScanReadyMeasurement?.result.verifiedSamples,
      formula:
        formulas.length === 1
          ? {
              fieldId: formulas[0].id,
              name: formulas[0].name,
              expression: formulas[0].expression,
              compiledExpression: formulas[0].compiledExpression,
            }
          : undefined,
      verifiedSamples:
        formulaResults?.length === 1
          ? formulaResults[0].verifiedSamples
          : undefined,
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

const createEmptyMeasurement = <T>(
  name: string,
  result: T,
): Measurement<T> => ({
  name,
  durationMs: 0,
  result,
});

const createFormulaFieldsAndWaitForSamples = async (
  context: PerfRunContext,
  perfCase: PerfCase,
  tableId: string,
  formulas: CompiledFormula[],
  sampleRecords: SeededSampleRecord[],
  config: FormulaTableCaseConfig,
  onCreated: (formula: CompiledFormula & { id: string }) => void,
) => {
  const createdFormulas: Array<CompiledFormula & { id: string }> = [];

  for (const formula of formulas) {
    const formulaField = await withPerfTraceStep(
      context,
      perfCase,
      `createFormulaField:${formula.name}`,
      () =>
        measureAsync(formula.name, () =>
          createField(tableId, {
            type: FieldType.Formula,
            name: formula.name,
            options: {
              expression: formula.compiledExpression,
            },
          }),
        ),
    );
    const createdFormula = {
      ...formula,
      id: formulaField.result.id,
    };
    createdFormulas.push(createdFormula);
    onCreated(createdFormula);
  }

  return Promise.all(
    createdFormulas.map(async (formula) => {
      const measurement = await measureAsync(formula.name, async () => ({
        formula,
        verifiedSamples: await waitForFormulaSamples(
          tableId,
          formula,
          sampleRecords,
          config,
          {
            timeoutMs: config.verify.timeoutMs,
            pollIntervalMs: config.verify.pollIntervalMs,
          },
        ),
      }));

      return {
        ...measurement.result,
        durationMs: measurement.durationMs,
      };
    }),
  );
};

const buildFormulaSeedFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  tableName: string,
  config: FormulaTableCaseConfig,
  seedCacheInfo: SeedCacheInfo,
): Promise<FormulaSeedFixture> => {
  const cachedTable =
    seedCacheInfo.enabled &&
    (await findSeedTable(baseId, seedCacheInfo.seedTableName));

  if (cachedTable) {
    try {
      const tableFields = await getFields(cachedTable.id);
      await cleanupCachedFormulaFields(cachedTable.id, tableFields);
      const cleanedTableFields = await getFields(cachedTable.id);
      const sourceFields = resolveSourceFields(cleanedTableFields);
      const sampleRecords = await getCachedSampleRecords(
        cachedTable.id,
        sourceFields,
        config,
      );
      await assertSourceSamples(
        cachedTable.id,
        sourceFields,
        config,
        sampleRecords,
      );
      return {
        tableId: cachedTable.id,
        tableName: cachedTable.name,
        sourceFields,
        sampleRecords,
        batches: [],
        batchDurations: [0],
        createTableMeasurement: createEmptyMeasurement("seedRestore", {
          id: cachedTable.id,
        }),
        seedMeasurement: createEmptyMeasurement("seedBuildSkipped", undefined),
        seedCacheInfo,
        seedCacheHit: true,
        reusable: true,
      };
    } catch (error) {
      console.warn(
        `Invalid cached formula seed ${seedCacheInfo.seedTableName}; rebuilding`,
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
    const tableFields = await getFields(createdTableId);
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
            withPerfTraceStep(
              context,
              perfCase,
              `seedBatch:${batchIndex + 1}`,
              () =>
                createRecords(createdTableId, {
                  fieldKeyType: FieldKeyType.Name,
                  records: batch.map((item) => item.record),
                }),
            ),
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

    return {
      tableId: createdTableId,
      tableName: actualTableName,
      sourceFields,
      sampleRecords: getRequiredSampleRecords(
        config,
        seededSampleRecordByOffset,
      ),
      batches,
      batchDurations,
      createTableMeasurement,
      seedMeasurement,
      seedCacheInfo,
      seedCacheHit: false,
      reusable: seedCacheInfo.enabled,
    };
  } catch (error) {
    if (createdTableId) {
      try {
        await permanentDeleteTable(baseId, createdTableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup incomplete formula seed ${createdTableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

export const seedFormulaTableCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FormulaTableCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "formula-table",
    fixtureVersion: "formula-table-v1",
    seedConfig: getFormulaSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
  const seedFixture = await buildFormulaSeedFixture(
    perfCase,
    context,
    baseId,
    tableName,
    config,
    seedCacheInfo,
  );
  const sourceReadyMeasurement = await measureAsync("seedReady", () =>
    waitForSourceSamples(
      seedFixture.tableId,
      seedFixture.sourceFields,
      config,
      seedFixture.sampleRecords,
    ),
  );

  return buildFormulaCaseResult({
    config,
    tableId: seedFixture.tableId,
    tableName: seedFixture.tableName,
    batches: seedFixture.batches,
    batchDurations: seedFixture.batchDurations,
    sampleRecords: seedFixture.sampleRecords,
    createTableMeasurement: seedFixture.createTableMeasurement,
    seedMeasurement: seedFixture.seedMeasurement,
    sourceReadyMeasurement,
    seedCacheInfo,
    seedCacheHit: seedFixture.seedCacheHit,
    reusableSeed: seedFixture.reusable,
    sourceFields: seedFixture.sourceFields,
    formulas: buildCompiledFormulas(
      config,
      await getFields(seedFixture.tableId),
    ),
  });
};

export const runFormulaTableCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FormulaTableCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "formula-table",
    fixtureVersion: "formula-table-v1",
    seedConfig: getFormulaSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
  let tableId = "";
  let reusableSeed = false;
  const createdFormulaFieldIds: string[] = [];

  try {
    const seedFixture = await buildFormulaSeedFixture(
      perfCase,
      context,
      baseId,
      tableName,
      config,
      seedCacheInfo,
    );
    tableId = seedFixture.tableId;
    reusableSeed = seedFixture.reusable;
    const {
      tableName: seedTableName,
      sourceFields,
      sampleRecords,
      batches,
      batchDurations,
      createTableMeasurement,
      seedMeasurement,
      seedCacheHit,
    } = seedFixture;
    const tableFields = await getFields(tableId);
    const formulas = buildCompiledFormulas(config, tableFields);
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
        tableName: seedTableName,
        batches,
        batchDurations,
        sampleRecords,
        createTableMeasurement,
        seedMeasurement,
        seedCacheInfo,
        seedCacheHit,
        reusableSeed,
        sourceFields,
        formulas,
        error,
      });

      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        diagnosticResult,
      );
    }

    let formulasReadyMeasurement: Measurement<FormulaRunResult[]>;
    let fullFormulaScanReadyMeasurement: Measurement<
      Awaited<ReturnType<typeof waitForFormulaFullScan>>
    >;
    const createdFormulaFields = new Map<
      string,
      FormulaFieldCaseConfig & { id: string; compiledExpression: string }
    >();

    try {
      formulasReadyMeasurement = await measureAsync("formulasReady", () =>
        createFormulaFieldsAndWaitForSamples(
          context,
          perfCase,
          tableId,
          formulas,
          sampleRecords,
          config,
          (createdFormula) => {
            createdFormulaFieldIds.push(createdFormula.id);
            createdFormulaFields.set(createdFormula.name, createdFormula);
          },
        ),
      );
      fullFormulaScanReadyMeasurement = await measureAsync(
        "fullFormulaScanReady",
        () =>
          waitForFormulaFullScan(
            tableId,
            formulasReadyMeasurement.result.map(({ formula }) => formula),
            config,
            sourceFields,
          ),
      );
    } catch (error) {
      const formulasWithCreatedIds = formulas.map((formula) => {
        const createdFormula = createdFormulaFields.get(formula.name);
        return createdFormula ?? formula;
      });
      const diagnosticResult = buildFormulaCaseResult({
        config,
        tableId,
        tableName: seedTableName,
        batches,
        batchDurations,
        sampleRecords,
        createTableMeasurement,
        seedMeasurement,
        sourceReadyMeasurement,
        seedCacheInfo,
        seedCacheHit,
        reusableSeed,
        sourceFields,
        formulas: formulasWithCreatedIds,
        formulasReadyMeasurement,
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
      tableName: seedTableName,
      batches,
      batchDurations,
      sampleRecords,
      createTableMeasurement,
      seedMeasurement,
      sourceReadyMeasurement,
      seedCacheInfo,
      seedCacheHit,
      reusableSeed,
      sourceFields,
      formulas: formulasReadyMeasurement.result.map(({ formula }) => formula),
      formulasReadyMeasurement,
      fullFormulaScanReadyMeasurement,
    });

    return {
      ...result,
      phases: [
        ...(result.phases ?? []),
        {
          name:
            formulasReadyMeasurement.result.length === 1
              ? "formulaReady"
              : formulasReadyMeasurement.name,
          durationMs: formulasReadyMeasurement.durationMs,
        },
      ],
    };
  } finally {
    if (reusableSeed) {
      for (const fieldId of createdFormulaFieldIds.reverse()) {
        try {
          await deleteField(tableId, fieldId);
        } catch (error) {
          console.warn(
            `Failed to cleanup perf formula field ${fieldId}`,
            error,
          );
        }
      }
    } else if (tableId) {
      try {
        await permanentDeleteTable(baseId, tableId);
      } catch (error) {
        console.warn(`Failed to cleanup perf table ${tableId}`, error);
      }
    }
  }
};
