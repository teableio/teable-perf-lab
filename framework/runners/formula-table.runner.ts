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
import { chunk } from "../chunk";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, type Measurement, roundMetric } from "../metrics";
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
  FormulaFieldCaseConfig,
  FormulaExpectedKind,
  FormulaTableCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  runFieldAddLifecycle,
  seedFieldAddLifecycle,
  type FieldAddLifecycleSpec,
} from "./field-add-lifecycle";

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
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 30_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 200,
      description: "source samples",
    },
    async () =>
      assertSourceSamples(tableId, sourceFields, config, sampleRecords),
  );

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
) =>
  pollUntilReady(
    {
      timeoutMs,
      pollIntervalMs,
      description: `formula ${formula.name} samples`,
    },
    async () => assertFormulaSamples(tableId, formula, sampleRecords, config),
  );

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
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.recordCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(tableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: [
            sourceFields.Title.id,
            ...formulas.map((formula) => formula.id),
          ],
          skip,
          take,
        }),
    },
    (record) => {
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
    },
  );

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
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 30_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 200,
      description: "full formula scan",
    },
    async () => assertFormulaFullScan(tableId, formulas, config, sourceFields),
  );

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
        collectSampleRecords(
          seededSampleRecordByOffset,
          wantedSampleOffsets,
          batch,
          batchMeasurement.result.records,
        );
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

const buildFormulaSeedCache = (
  perfCase: PerfCase,
  config: FormulaTableCaseConfig,
) =>
  buildSeedCacheInfo({
    perfCase,
    runner: "formula-table",
    fixtureVersion: "formula-table-v1",
    seedConfig: getFormulaSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });

const sourceFieldsArray = (sourceFields: SourceFields) =>
  sourceFieldNames.map((fieldName) => sourceFields[fieldName]);

type FormulaLifecycleFixture = FormulaSeedFixture & {
  // The source-readiness phase the legacy runner names differently per mode:
  // "seedReady" on the seed (prepare-DB) path, "sourceReady" on the measured
  // execute path. The driver always measures it as "seedReady"; the runner
  // relabels the emitted phase from this, keeping the shared driver byte-stable.
  sourceReadyName: string;
  // Compiled (no-id) formulas for the seed / diagnostic details.formulas, where
  // the formula fields have not been created yet. Compiled from the source
  // Title/A/B/C ids, which is exactly what the formula expressions reference, so
  // it matches the legacy seed path's buildCompiledFormulas(getFields()) output.
  compiledFormulas: CompiledFormula[];
  // Created formula field ids, pushed as runPrimary creates each field and read
  // by cleanup to restore a reusable seed (delete the added formula fields).
  createdFormulaFieldIds: string[];
};

type FormulaSourceReadyResult = Awaited<
  ReturnType<typeof waitForSourceSamples>
>;

type FormulaPrimary = {
  formulasReadyMeasurement: Measurement<FormulaRunResult[]>;
  fullFormulaScanReadyMeasurement: Measurement<
    Awaited<ReturnType<typeof waitForFormulaFullScan>>
  >;
};

// formula-table rides the field-add lifecycle as the fourth member, with the
// widest primary in the family: seed a numeric source table, wait for the source
// rows to be readable, create N formula fields (each its own trace step) and
// wait for each to backfill its sampled values, full-scan every computed value,
// then restore the seed by deleting the added formula fields. Like field-create,
// its prepare carries its own createTable/seedRecords measurements so the driver
// emits no "prepare" phase. Its source-readiness phase is named "sourceReady" on
// execute vs "seedReady" on the seed path, and its primary metric is a computed
// sum (formulasReady + fullScan) with a trailing appended formulaReady phase —
// all expressed in the spec, leaving field-add-lifecycle byte-stable.
const formulaTableFieldAddSpec: FieldAddLifecycleSpec<
  FormulaTableCaseConfig,
  FormulaLifecycleFixture,
  FormulaSourceReadyResult,
  FormulaPrimary
> = {
  prepareFixture: async ({ perfCase, context, baseId, config, seedMode }) => {
    const seedCacheInfo = await buildFormulaSeedCache(perfCase, config);
    const tableName = seedMode
      ? `${config.tableNamePrefix}-seed-${Date.now()}`
      : `${config.tableNamePrefix}-${Date.now()}`;
    const seedFixture = await buildFormulaSeedFixture(
      perfCase,
      context,
      baseId,
      tableName,
      config,
      seedCacheInfo,
    );
    return Object.assign(seedFixture, {
      sourceReadyName: seedMode ? "seedReady" : "sourceReady",
      compiledFormulas: buildCompiledFormulas(
        config,
        sourceFieldsArray(seedFixture.sourceFields),
      ),
      createdFormulaFieldIds: [] as string[],
    });
  },
  assertSeedReady: ({ fixture, config }) =>
    waitForSourceSamples(
      fixture.tableId,
      fixture.sourceFields,
      config,
      fixture.sampleRecords,
    ),
  runPrimary: async ({ perfCase, context, fixture, config }) => {
    const formulasReadyMeasurement = await measureAsync("formulasReady", () =>
      createFormulaFieldsAndWaitForSamples(
        context,
        perfCase,
        fixture.tableId,
        fixture.compiledFormulas,
        fixture.sampleRecords,
        config,
        (createdFormula) => {
          fixture.createdFormulaFieldIds.push(createdFormula.id);
        },
      ),
    );
    const fullFormulaScanReadyMeasurement = await measureAsync(
      "fullFormulaScanReady",
      () =>
        waitForFormulaFullScan(
          fixture.tableId,
          formulasReadyMeasurement.result.map(({ formula }) => formula),
          config,
          fixture.sourceFields,
        ),
    );
    return { formulasReadyMeasurement, fullFormulaScanReadyMeasurement };
  },
  buildResult: ({ config, fixture, seedReadyMeasurement, primary, error }) => {
    if (!fixture) {
      // Unreachable in the driver's flow (a fixture always exists before
      // seedReady/runPrimary run), kept only to satisfy the optional-fixture
      // type without crashing on the source-field accesses below.
      return {
        metrics: {},
        thresholds: [],
        phases: [],
        details: {
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : undefined,
        },
      };
    }
    const sourceReadyMeasurement = seedReadyMeasurement
      ? {
          name: fixture.sourceReadyName,
          durationMs: seedReadyMeasurement.durationMs,
          result: seedReadyMeasurement.result,
        }
      : undefined;
    const formulas = primary
      ? primary.formulasReadyMeasurement.result.map(({ formula }) => formula)
      : fixture.compiledFormulas;
    const result = buildFormulaCaseResult({
      config,
      tableId: fixture.tableId,
      tableName: fixture.tableName,
      batches: fixture.batches,
      batchDurations: fixture.batchDurations,
      sampleRecords: fixture.sampleRecords,
      createTableMeasurement: fixture.createTableMeasurement,
      seedMeasurement: fixture.seedMeasurement,
      sourceReadyMeasurement,
      seedCacheInfo: fixture.seedCacheInfo,
      seedCacheHit: fixture.seedCacheHit,
      reusableSeed: fixture.reusable,
      sourceFields: fixture.sourceFields,
      formulas,
      formulasReadyMeasurement: primary?.formulasReadyMeasurement,
      fullFormulaScanReadyMeasurement: primary?.fullFormulaScanReadyMeasurement,
      error,
    });
    if (!primary) {
      return result;
    }
    // The legacy execute path appends the formula-ready phase AFTER
    // fullFormulaScanReady (matching its original phase order), so reproduce it
    // here verbatim instead of folding it into buildFormulaCaseResult.
    return {
      ...result,
      phases: [
        ...(result.phases ?? []),
        {
          name:
            primary.formulasReadyMeasurement.result.length === 1
              ? "formulaReady"
              : primary.formulasReadyMeasurement.name,
          durationMs: primary.formulasReadyMeasurement.durationMs,
        },
      ],
    };
  },
  cleanup: async ({ baseId, fixture }) => {
    // CI execute jobs run on a disposable restored DB copy; cleanup that only
    // tidies the durable database is skipped there.
    if (isExecuteDbIsolated() || !fixture) {
      return;
    }
    if (fixture.reusable) {
      // Restore the reusable seed by deleting the added formula fields (the same
      // source-fields-only invariant the seed asserts). Reverse so dependent
      // fields drop before their dependencies; idempotent and a no-op when the
      // create made nothing.
      for (const fieldId of [...fixture.createdFormulaFieldIds].reverse()) {
        try {
          await deleteField(fixture.tableId, fieldId);
        } catch (error) {
          console.warn(
            `Failed to cleanup perf formula field ${fieldId}`,
            error,
          );
        }
      }
      return;
    }
    try {
      await permanentDeleteTable(baseId, fixture.tableId);
    } catch (error) {
      console.warn(`Failed to cleanup perf table ${fixture.tableId}`, error);
    }
  },
};

export const seedFormulaTableCase = (
  perfCase: PerfCaseFor<"formula-table">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedFieldAddLifecycle(perfCase, context, formulaTableFieldAddSpec);

export const runFormulaTableCase = (
  perfCase: PerfCaseFor<"formula-table">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runFieldAddLifecycle(perfCase, context, formulaTableFieldAddSpec);
