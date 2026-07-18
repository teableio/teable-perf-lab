import { FieldKeyType, FieldType, type IFieldRo } from "@teable/core";
import { duplicateField } from "@teable/openapi";
import {
  createField,
  deleteField,
  getFields,
  getRecords,
  permanentDeleteTable,
} from "../../../utils/init-app";
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
  buildSeedCacheInfo,
  buildSeedTableName,
  type SeedCacheInfo,
} from "../seed-cache";
import { withPerfTraceStep } from "../trace-collector";
import type {
  ComputedFieldDuplicateCaseConfig,
  ConditionalRollupFieldDuplicateCaseConfig,
  FormulaFieldDuplicateCaseConfig,
  FormulaTableCaseConfig,
  ConditionalRollupCaseConfig,
  PerfCase,
  PerfCaseFor,
  PerfPhase,
  PerfRunContext,
  PerfRunResult,
  RollupFieldDuplicateCaseConfig,
} from "../types";
import {
  assertConditionalLookupSeedReady,
  buildConditionalLookupSeedFixture,
  getExpectedValue,
  getSourceRowNumberForHostRow,
  parseConditionalSeedRowNumber,
  type ConditionalLookupSeedFixture,
} from "./conditional-lookup.runner";
import {
  buildConditionalRollupFieldInput,
  waitForConditionalRollupFullScan,
} from "./conditional-rollup.runner";
import {
  runFieldAddLifecycle,
  seedFieldAddLifecycle,
  type FieldAddLifecycleSpec,
} from "./field-add-lifecycle";
import {
  buildCompiledFormulas,
  buildFormulaSeedFixture,
  getExpectedFormulaRow,
  waitForFormulaFullScan,
  waitForFormulaSourceSamples,
} from "./formula-table.runner";
import {
  assertLinkCellSamples,
  expectedForeignNumber,
  foreignRowForMainRow,
  prepareTableLinkFixture,
  type TableLinkFixture,
} from "./table-lifecycle-link.shared";

const COMPUTED_DUPLICATE_FIXTURE_VERSION = "field-duplicate-computed-v1";

type NamedComputedField = {
  id: string;
  name: string;
  type?: string;
  isPrimary?: boolean;
  options?: Record<string, unknown>;
  lookupOptions?: Record<string, unknown>;
};

type ComputedDuplicateOperation = {
  field: NamedComputedField;
  status: number;
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
};

type ComputedDuplicateVerification = {
  scannedRecords: number;
  pageSize: number;
  pageCount: number;
  sourceField: NamedComputedField;
  duplicatedField: NamedComputedField;
  fieldIds: string[];
  verifiedSamples: Array<{
    rowOffset: number;
    rowNumber: number;
    recordId: string;
    sourceValue: unknown;
    duplicatedValue: unknown;
    expected: unknown;
  }>;
};

type ComputedDuplicateFixture = {
  kind: ComputedFieldDuplicateCaseConfig["computed"]["kind"];
  tableId: string;
  tableName: string;
  relatedTableIds: string[];
  sourceFieldId: string;
  sourceFieldName: string;
  sourceFieldType: FieldType;
  baselineFieldIds: string[];
  preparePhase: PerfPhase;
  preparePhases: PerfPhase[];
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusable: boolean;
  seedDetails: Record<string, unknown>;
  assertSourceReady: () => Promise<unknown>;
  verifyDuplicate: (
    duplicatedFieldId: string,
  ) => Promise<ComputedDuplicateVerification>;
  completedDuplicateFieldMeasurement?: Measurement<ComputedDuplicateOperation>;
  verificationProgress?: ComputedDuplicateVerification;
};

type ComputedDuplicatePrimary = {
  duplicateFieldMeasurement: Measurement<ComputedDuplicateOperation>;
  duplicatedComputedScanReadyMeasurement: Measurement<ComputedDuplicateVerification>;
};

const asFormulaTableConfig = (
  config: FormulaFieldDuplicateCaseConfig,
): FormulaTableCaseConfig => ({
  baseId: config.baseId,
  tableNamePrefix: config.tableNamePrefix,
  recordCount: config.recordCount,
  batchSize: config.batchSize,
  fields: config.fields,
  generator: config.generator,
  formula: config.formula,
  verify: config.verify,
  threshold: { metric: "formulaFullReadyMs", maxMs: config.threshold.maxMs },
});

const asConditionalRollupConfig = (
  config: ConditionalRollupFieldDuplicateCaseConfig,
): ConditionalRollupCaseConfig => ({
  baseId: config.baseId,
  sourceTableNamePrefix: config.sourceTableNamePrefix,
  hostTableNamePrefix: config.hostTableNamePrefix,
  recordCount: config.recordCount,
  batchSize: config.batchSize,
  generator: config.generator,
  rollup: config.rollup,
  verify: config.verify,
  threshold: {
    metric: "conditionalRollupReadyMs",
    maxMs: config.threshold.maxMs,
  },
});

const getNamedFields = (tableId: string) =>
  getFields(tableId) as Promise<NamedComputedField[]>;

const assertExpectedRouting = (
  context: PerfRunContext,
  responseHeaders: Record<string, string>,
) =>
  assertEngineRouting(context, responseHeaders, {
    feature: "duplicateField",
    operation: "Computed field duplicate",
  });

const sameMetadata = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});

const assertComputedMetadata = (
  fixture: Omit<ComputedDuplicateFixture, "preparePhase">,
  config: ComputedFieldDuplicateCaseConfig,
  fields: NamedComputedField[],
  duplicatedFieldId: string,
) => {
  const sourceField = fields.find(
    (field) => field.id === fixture.sourceFieldId,
  );
  const duplicatedField = fields.find(
    (field) => field.id === duplicatedFieldId,
  );
  if (!sourceField || !duplicatedField) {
    throw new Error(
      `Computed duplicate metadata missing; source=${Boolean(sourceField)}, copy=${Boolean(
        duplicatedField,
      )}`,
    );
  }
  expect(sourceField.name).toBe(fixture.sourceFieldName);
  expect(sourceField.type).toBe(fixture.sourceFieldType);
  expect(duplicatedField.name).toBe(config.duplicate.name);
  expect(duplicatedField.type).toBe(fixture.sourceFieldType);
  expect(duplicatedField.isPrimary).not.toBe(true);
  expect(sameMetadata(duplicatedField.options, sourceField.options)).toBe(true);
  if (fixture.kind === "rollup") {
    expect(
      sameMetadata(duplicatedField.lookupOptions, sourceField.lookupOptions),
    ).toBe(true);
  }

  const fieldIds = fields.map((field) => field.id).sort();
  expect(fieldIds).toEqual(
    [...fixture.baselineFieldIds, duplicatedFieldId].sort(),
  );
  return { sourceField, duplicatedField, fieldIds };
};

const parseFormulaRowNumber = (value: unknown, titlePrefix: string) => {
  if (typeof value !== "string") {
    throw new Error(`Expected formula Title string, got ${String(value)}`);
  }
  const prefix = `${titlePrefix} `;
  const rowNumber = Number(value.slice(prefix.length));
  if (!value.startsWith(prefix) || !Number.isInteger(rowNumber)) {
    throw new Error(`Expected ${value} to match "${prefix}<rowNumber>"`);
  }
  return rowNumber;
};

const parseReplayRowNumber = (value: unknown, titlePrefix: string) => {
  if (typeof value !== "string") {
    throw new Error(`Expected replay Title string, got ${String(value)}`);
  }
  const prefix = `${titlePrefix} `;
  const rowNumber = Number(value.slice(prefix.length));
  if (!value.startsWith(prefix) || !Number.isInteger(rowNumber)) {
    throw new Error(`Expected ${value} to match "${prefix}<padded-row>"`);
  }
  return rowNumber;
};

const prepareFormulaFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  config: FormulaFieldDuplicateCaseConfig,
  seedMode: boolean,
): Promise<Omit<ComputedDuplicateFixture, "preparePhase">> => {
  const formulaConfig = asFormulaTableConfig(config);
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "field-duplicate",
    fixtureVersion: `${COMPUTED_DUPLICATE_FIXTURE_VERSION}-formula`,
    seedConfig: {
      baseId: config.baseId,
      tableNamePrefix: config.tableNamePrefix,
      recordCount: config.recordCount,
      batchSize: config.batchSize,
      fields: config.fields,
      generator: config.generator,
      formula: {
        name: config.formula.name,
        expression: config.formula.expression,
        expected: config.formula.expected,
      },
      duplicate: { name: config.duplicate.name },
      verifySampleRows: config.verify.sampleRows,
    },
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("./formula-table.runner.ts", import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
  const tableName = `${config.tableNamePrefix}-${seedMode ? "seed-" : ""}${Date.now()}`;
  const seed = await buildFormulaSeedFixture(
    perfCase,
    context,
    baseId,
    tableName,
    formulaConfig,
    seedCacheInfo,
    { preserveComputedFieldNames: [config.formula.name] },
  );
  const fieldsForCompile = config.fields.map((field) => {
    const named =
      seed.sourceFields[field.name as keyof typeof seed.sourceFields];
    if (!named) {
      throw new Error(`Formula source field ${field.name} was not resolved`);
    }
    return { ...field, id: named.id };
  });
  const compiledFormula = buildCompiledFormulas(
    formulaConfig,
    fieldsForCompile,
  )[0];
  if (!compiledFormula) {
    throw new Error("Computed duplicate Formula config produced no formula");
  }
  let fields = await getNamedFields(seed.tableId);
  let sourceField = fields.find((field) => field.name === config.formula.name);
  let sourceCreated = false;
  if (!sourceField) {
    const created = await createField(seed.tableId, {
      name: config.formula.name,
      type: FieldType.Formula,
      options: { expression: compiledFormula.compiledExpression },
    });
    sourceField = { ...created, type: FieldType.Formula };
    sourceCreated = true;
  }
  await waitForFormulaFullScan(
    seed.tableId,
    [{ ...compiledFormula, id: sourceField.id }],
    formulaConfig,
    seed.sourceFields,
  );
  fields = await getNamedFields(seed.tableId);
  sourceField = fields.find((field) => field.id === sourceField!.id);
  if (!sourceField || sourceField.type !== FieldType.Formula) {
    throw new Error(`Ready Formula source ${config.formula.name} is missing`);
  }

  let fixture: Omit<ComputedDuplicateFixture, "preparePhase">;
  const verifyDuplicate = async (duplicatedFieldId: string) => {
    const latestFields = await getNamedFields(seed.tableId);
    const metadata = assertComputedMetadata(
      fixture,
      config,
      latestFields,
      duplicatedFieldId,
    );
    const pageSize = config.verify.fullScanPageSize ?? 1_000;
    const sampleOffsets = new Set(config.verify.sampleRows);
    const progress: ComputedDuplicateVerification = {
      scannedRecords: 0,
      pageSize,
      pageCount: 0,
      ...metadata,
      verifiedSamples: [],
    };
    fixture.verificationProgress = progress;
    const { scannedRecords, pageCount } = await forEachRecordPage(
      {
        totalRows: config.recordCount,
        pageSize,
        fetchPage: (skip, take) =>
          getRecords(seed.tableId, {
            fieldKeyType: FieldKeyType.Id,
            projection: [
              seed.sourceFields.Title.id,
              sourceField!.id,
              duplicatedFieldId,
            ],
            skip,
            take,
          }),
      },
      (record) => {
        const rowNumber = parseFormulaRowNumber(
          record.fields[seed.sourceFields.Title.id],
          config.generator.titlePrefix,
        );
        const expectedKind = config.formula.expected ?? "aTimesBPlusC";
        const expected = getExpectedFormulaRow(
          rowNumber,
          config.generator.titlePrefix,
        ).formulaValues[expectedKind];
        const sourceValue = record.fields[sourceField!.id];
        const duplicatedValue = record.fields[duplicatedFieldId];
        if (sourceValue !== expected || duplicatedValue !== expected) {
          throw new Error(
            `Formula duplicate mismatch at row ${rowNumber}: expected ${expected}, source ${String(
              sourceValue,
            )}, copy ${String(duplicatedValue)}`,
          );
        }
        const rowOffset = rowNumber - 1;
        if (sampleOffsets.has(rowOffset)) {
          progress.verifiedSamples.push({
            rowOffset,
            rowNumber,
            recordId: record.id,
            sourceValue,
            duplicatedValue,
            expected,
          });
        }
        progress.scannedRecords += 1;
        progress.pageCount = Math.ceil(progress.scannedRecords / pageSize);
      },
    );
    progress.scannedRecords = scannedRecords;
    progress.pageCount = pageCount;
    expect(progress.verifiedSamples).toHaveLength(
      config.verify.sampleRows.length,
    );
    return progress;
  };

  fixture = {
    kind: "formula" as const,
    tableId: seed.tableId,
    tableName: seed.tableName,
    relatedTableIds: [],
    sourceFieldId: sourceField.id,
    sourceFieldName: sourceField.name,
    sourceFieldType: FieldType.Formula,
    baselineFieldIds: fields.map((field) => field.id),
    preparePhases: [
      {
        name: seed.createTableMeasurement.name,
        durationMs: seed.createTableMeasurement.durationMs,
      },
      {
        name: seed.seedMeasurement.name,
        durationMs: seed.seedMeasurement.durationMs,
      },
    ],
    seedCacheInfo,
    seedCacheHit: seed.seedCacheHit,
    reusable: seed.reusable,
    seedDetails: {
      sourceCreated,
      sourceFields: seed.sourceFields,
      sampleRecords: seed.sampleRecords,
      formula: {
        name: config.formula.name,
        expression: config.formula.expression,
        compiledExpression: compiledFormula.compiledExpression,
      },
    },
    assertSourceReady: async () => ({
      sourceSamples: await waitForFormulaSourceSamples(
        seed.tableId,
        seed.sourceFields,
        formulaConfig,
        seed.sampleRecords,
      ),
      computed: await waitForFormulaFullScan(
        seed.tableId,
        [{ ...compiledFormula, id: sourceField!.id }],
        formulaConfig,
        seed.sourceFields,
      ),
    }),
    verifyDuplicate,
  } satisfies Omit<ComputedDuplicateFixture, "preparePhase">;
  return fixture;
};

const prepareConditionalRollupFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  config: ConditionalRollupFieldDuplicateCaseConfig,
): Promise<Omit<ComputedDuplicateFixture, "preparePhase">> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "field-duplicate",
    fixtureVersion: `${COMPUTED_DUPLICATE_FIXTURE_VERSION}-conditional-rollup`,
    seedConfig: {
      baseId: config.baseId,
      sourceTableNamePrefix: config.sourceTableNamePrefix,
      hostTableNamePrefix: config.hostTableNamePrefix,
      recordCount: config.recordCount,
      batchSize: config.batchSize,
      generator: config.generator,
      rollup: config.rollup,
      duplicate: config.duplicate,
      verifySampleRows: config.verify.sampleRows,
    },
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("./conditional-lookup.runner.ts", import.meta.url),
      new URL("./conditional-rollup.runner.ts", import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
  const sourceTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "source")
    : `${config.sourceTableNamePrefix}-${Date.now()}`;
  const hostTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "host")
    : `${config.hostTableNamePrefix}-${Date.now()}`;
  const seed = await buildConditionalLookupSeedFixture(
    perfCase,
    context,
    baseId,
    sourceTableName,
    hostTableName,
    config,
    seedCacheInfo,
    { cleanupHostLookupFields: false },
  );
  const rollupConfig = asConditionalRollupConfig(config);
  let fields = await getNamedFields(seed.hostTableId);
  for (const field of fields) {
    const isSeedField = Object.values(seed.hostFields).includes(field.id);
    if (
      !isSeedField &&
      field.name !== config.rollup.name &&
      field.name !== config.duplicate.name
    ) {
      await deleteField(seed.hostTableId, field.id);
    }
    if (field.name === config.duplicate.name) {
      await deleteField(seed.hostTableId, field.id);
    }
  }
  fields = await getNamedFields(seed.hostTableId);
  let sourceField = fields.find((field) => field.name === config.rollup.name);
  let sourceCreated = false;
  if (!sourceField) {
    const created = await createField(
      seed.hostTableId,
      buildConditionalRollupFieldInput(seed, rollupConfig),
    );
    sourceField = { ...created, type: FieldType.ConditionalRollup };
    sourceCreated = true;
  }
  await waitForConditionalRollupFullScan(seed, sourceField.id, rollupConfig);
  fields = await getNamedFields(seed.hostTableId);
  sourceField = fields.find((field) => field.id === sourceField!.id);
  if (!sourceField || sourceField.type !== FieldType.ConditionalRollup) {
    throw new Error(
      `Ready Conditional Rollup ${config.rollup.name} is missing`,
    );
  }

  let fixture: Omit<ComputedDuplicateFixture, "preparePhase">;
  const verifyDuplicate = (duplicatedFieldId: string) =>
    verifyConditionalRollupDuplicate(
      fixture,
      seed,
      config,
      sourceField!.id,
      duplicatedFieldId,
    );
  fixture = {
    kind: "conditionalRollup" as const,
    tableId: seed.hostTableId,
    tableName: seed.hostTableName,
    relatedTableIds: [seed.sourceTableId],
    sourceFieldId: sourceField.id,
    sourceFieldName: sourceField.name,
    sourceFieldType: FieldType.ConditionalRollup,
    baselineFieldIds: fields.map((field) => field.id),
    preparePhases: [
      {
        name: seed.createTablesMeasurement.name,
        durationMs: seed.createTablesMeasurement.durationMs,
      },
      {
        name: seed.seedSourceMeasurement.name,
        durationMs: seed.seedSourceMeasurement.durationMs,
      },
      {
        name: seed.seedHostMeasurement.name,
        durationMs: seed.seedHostMeasurement.durationMs,
      },
    ],
    seedCacheInfo,
    seedCacheHit: seed.seedCacheHit,
    reusable: seed.reusable,
    seedDetails: {
      sourceCreated,
      sourceTableId: seed.sourceTableId,
      sourceTableName: seed.sourceTableName,
      sourceFields: seed.sourceFields,
      hostFields: seed.hostFields,
      sampleRecords: seed.sampleRecords,
      rollup: config.rollup,
    },
    assertSourceReady: async () => ({
      seed: await assertConditionalLookupSeedReady(
        seed.sourceTableId,
        seed.hostTableId,
        seed.sourceFields,
        seed.hostFields,
        config,
        seed.sampleRecords,
      ),
      computed: await waitForConditionalRollupFullScan(
        seed,
        sourceField!.id,
        rollupConfig,
      ),
    }),
    verifyDuplicate,
  } satisfies Omit<ComputedDuplicateFixture, "preparePhase">;
  return fixture;
};

const verifyConditionalRollupDuplicate = async (
  fixture: Omit<ComputedDuplicateFixture, "preparePhase">,
  seed: ConditionalLookupSeedFixture,
  config: ConditionalRollupFieldDuplicateCaseConfig,
  sourceFieldId: string,
  duplicatedFieldId: string,
) => {
  const fields = await getNamedFields(seed.hostTableId);
  const metadata = assertComputedMetadata(
    fixture,
    config,
    fields,
    duplicatedFieldId,
  );
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleOffsets = new Set(config.verify.sampleRows);
  const progress: ComputedDuplicateVerification = {
    scannedRecords: 0,
    pageSize,
    pageCount: 0,
    ...metadata,
    verifiedSamples: [],
  };
  fixture.verificationProgress = progress;
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.recordCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(seed.hostTableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: [
            seed.hostFields.keyFieldId,
            sourceFieldId,
            duplicatedFieldId,
          ],
          skip,
          take,
        }),
    },
    (record) => {
      const rowNumber = parseConditionalSeedRowNumber(
        record.fields[seed.hostFields.keyFieldId],
        config.generator.hostKeyPrefix,
      );
      const sourceRowNumber = getSourceRowNumberForHostRow(rowNumber, config);
      const expected = getExpectedValue(sourceRowNumber, config);
      const sourceValue = record.fields[sourceFieldId];
      const duplicatedValue = record.fields[duplicatedFieldId];
      if (sourceValue !== expected || duplicatedValue !== expected) {
        throw new Error(
          `Conditional Rollup duplicate mismatch at row ${rowNumber}: expected ${JSON.stringify(
            expected,
          )}, source ${JSON.stringify(sourceValue)}, copy ${JSON.stringify(
            duplicatedValue,
          )}`,
        );
      }
      const rowOffset = rowNumber - 1;
      if (sampleOffsets.has(rowOffset)) {
        progress.verifiedSamples.push({
          rowOffset,
          rowNumber,
          recordId: record.id,
          sourceValue,
          duplicatedValue,
          expected,
        });
      }
      progress.scannedRecords += 1;
      progress.pageCount = Math.ceil(progress.scannedRecords / pageSize);
    },
  );
  progress.scannedRecords = scannedRecords;
  progress.pageCount = pageCount;
  expect(progress.verifiedSamples).toHaveLength(
    config.verify.sampleRows.length,
  );
  return progress;
};

const prepareRollupFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  config: RollupFieldDuplicateCaseConfig,
  seedMode: boolean,
): Promise<Omit<ComputedDuplicateFixture, "preparePhase">> => {
  const tableName = `${config.tableNamePrefix}-${seedMode ? "seed-" : ""}${Date.now()}`;
  const seed = await prepareTableLinkFixture(
    baseId,
    tableName,
    config,
    perfCase,
    "field-duplicate",
    {
      computedKind: config.computed.kind,
      sourceFieldName: config.computed.sourceFieldName,
      expression: config.computed.expression,
    },
    { seedCodeFiles: [new URL(import.meta.url)] },
  );
  if (!seed.link.foreignValueFieldId) {
    throw new Error("Rollup duplicate fixture is missing foreign Amount field");
  }
  let fields = await getNamedFields(seed.tableId);
  for (const field of fields) {
    const isBaseline =
      seed.fields.some((seedField) => seedField.id === field.id) ||
      field.id === seed.link.fieldId;
    if (
      !isBaseline &&
      field.name !== config.computed.sourceFieldName &&
      field.name !== config.duplicate.name
    ) {
      await deleteField(seed.tableId, field.id);
    }
    if (field.name === config.duplicate.name) {
      await deleteField(seed.tableId, field.id);
    }
  }
  fields = await getNamedFields(seed.tableId);
  let sourceField = fields.find(
    (field) => field.name === config.computed.sourceFieldName,
  );
  let sourceCreated = false;
  if (!sourceField) {
    const input: IFieldRo = {
      name: config.computed.sourceFieldName,
      type: FieldType.Rollup,
      options: { expression: config.computed.expression },
      lookupOptions: {
        foreignTableId: seed.link.foreignTableId,
        linkFieldId: seed.link.fieldId,
        lookupFieldId: seed.link.foreignValueFieldId,
      },
    };
    const created = await createField(seed.tableId, input);
    sourceField = { ...created, type: FieldType.Rollup };
    sourceCreated = true;
  }
  await waitForRollupValues(seed, config, sourceField.id);
  fields = await getNamedFields(seed.tableId);
  sourceField = fields.find((field) => field.id === sourceField!.id);
  if (!sourceField || sourceField.type !== FieldType.Rollup) {
    throw new Error(
      `Ready Rollup ${config.computed.sourceFieldName} is missing`,
    );
  }
  const titleField = seed.fields.find((field) => field.name === "Title");
  if (!titleField) {
    throw new Error("Rollup duplicate fixture is missing host Title field");
  }

  let fixture: Omit<ComputedDuplicateFixture, "preparePhase">;
  const verifyDuplicate = (duplicatedFieldId: string) =>
    verifyRollupDuplicate(
      fixture,
      seed,
      config,
      titleField.id,
      sourceField!.id,
      duplicatedFieldId,
    );
  fixture = {
    kind: "rollup" as const,
    tableId: seed.tableId,
    tableName: seed.tableName,
    relatedTableIds: [seed.link.foreignTableId],
    sourceFieldId: sourceField.id,
    sourceFieldName: sourceField.name,
    sourceFieldType: FieldType.Rollup,
    baselineFieldIds: fields.map((field) => field.id),
    preparePhases: [],
    seedCacheInfo: seed.seedCacheInfo,
    seedCacheHit: seed.seedCacheHit,
    reusable: seed.reusableSeed,
    seedDetails: {
      sourceCreated,
      viewId: seed.viewId,
      link: seed.link,
      seedBatchDurations: seed.seedBatchDurations,
    },
    assertSourceReady: async () => ({
      links: await assertLinkCellSamples(seed, config),
      computed: await waitForRollupValues(seed, config, sourceField!.id),
    }),
    verifyDuplicate,
  } satisfies Omit<ComputedDuplicateFixture, "preparePhase">;
  return fixture;
};

const waitForRollupValues = (
  seed: TableLinkFixture,
  config: RollupFieldDuplicateCaseConfig,
  sourceFieldId: string,
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 120_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 500,
      description: "source Rollup full scan",
    },
    async () => {
      const titleField = seed.fields.find((field) => field.name === "Title");
      if (!titleField) {
        throw new Error("Rollup duplicate fixture is missing host Title field");
      }
      const pageSize = config.verify.fullScanPageSize ?? 1_000;
      const { scannedRecords, pageCount } = await forEachRecordPage(
        {
          totalRows: config.rowCount,
          pageSize,
          fetchPage: (skip, take) =>
            getRecords(seed.tableId, {
              viewId: seed.viewId,
              fieldKeyType: FieldKeyType.Id,
              projection: [titleField.id, sourceFieldId],
              skip,
              take,
            }),
        },
        (record) => {
          const rowNumber = parseReplayRowNumber(
            record.fields[titleField.id],
            config.generator.titlePrefix,
          );
          const expected = expectedForeignNumber(
            foreignRowForMainRow(rowNumber, config),
            config,
          );
          if (record.fields[sourceFieldId] !== expected) {
            throw new Error(
              `Rollup source mismatch at row ${rowNumber}: expected ${expected}, actual ${String(
                record.fields[sourceFieldId],
              )}`,
            );
          }
        },
      );
      return { scannedRecords, pageCount, pageSize };
    },
  );

const verifyRollupDuplicate = async (
  fixture: Omit<ComputedDuplicateFixture, "preparePhase">,
  seed: TableLinkFixture,
  config: RollupFieldDuplicateCaseConfig,
  titleFieldId: string,
  sourceFieldId: string,
  duplicatedFieldId: string,
) => {
  const fields = await getNamedFields(seed.tableId);
  const metadata = assertComputedMetadata(
    fixture,
    config,
    fields,
    duplicatedFieldId,
  );
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleOffsets = new Set(config.verify.sampleRows);
  const progress: ComputedDuplicateVerification = {
    scannedRecords: 0,
    pageSize,
    pageCount: 0,
    ...metadata,
    verifiedSamples: [],
  };
  fixture.verificationProgress = progress;
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.rowCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(seed.tableId, {
          viewId: seed.viewId,
          fieldKeyType: FieldKeyType.Id,
          projection: [titleFieldId, sourceFieldId, duplicatedFieldId],
          skip,
          take,
        }),
    },
    (record) => {
      const rowNumber = parseReplayRowNumber(
        record.fields[titleFieldId],
        config.generator.titlePrefix,
      );
      const expected = expectedForeignNumber(
        foreignRowForMainRow(rowNumber, config),
        config,
      );
      const sourceValue = record.fields[sourceFieldId];
      const duplicatedValue = record.fields[duplicatedFieldId];
      if (sourceValue !== expected || duplicatedValue !== expected) {
        throw new Error(
          `Rollup duplicate mismatch at row ${rowNumber}: expected ${expected}, source ${String(
            sourceValue,
          )}, copy ${String(duplicatedValue)}`,
        );
      }
      const rowOffset = rowNumber - 1;
      if (sampleOffsets.has(rowOffset)) {
        progress.verifiedSamples.push({
          rowOffset,
          rowNumber,
          recordId: record.id,
          sourceValue,
          duplicatedValue,
          expected,
        });
      }
      progress.scannedRecords += 1;
      progress.pageCount = Math.ceil(progress.scannedRecords / pageSize);
    },
  );
  progress.scannedRecords = scannedRecords;
  progress.pageCount = pageCount;
  expect(progress.verifiedSamples).toHaveLength(
    config.verify.sampleRows.length,
  );
  return progress;
};

const prepareComputedDuplicateFixture = async ({
  perfCase,
  context,
  baseId,
  config,
  seedMode,
}: {
  perfCase: PerfCase;
  context: PerfRunContext;
  baseId: string;
  config: ComputedFieldDuplicateCaseConfig;
  seedMode: boolean;
}): Promise<ComputedDuplicateFixture> => {
  const prepareMeasurement = await measureAsync("prepare", async () => {
    switch (config.computed.kind) {
      case "formula":
        return prepareFormulaFixture(
          perfCase,
          context,
          baseId,
          config as FormulaFieldDuplicateCaseConfig,
          seedMode,
        );
      case "conditionalRollup":
        return prepareConditionalRollupFixture(
          perfCase,
          context,
          baseId,
          config as ConditionalRollupFieldDuplicateCaseConfig,
        );
      case "rollup":
        return prepareRollupFixture(
          perfCase,
          context,
          baseId,
          config as RollupFieldDuplicateCaseConfig,
          seedMode,
        );
    }
  });
  return {
    ...prepareMeasurement.result,
    preparePhase: {
      name: prepareMeasurement.name,
      durationMs: prepareMeasurement.durationMs,
    },
  };
};

const buildComputedDuplicateResult = ({
  config,
  fixture,
  seedReadyMeasurement,
  primary,
  error,
}: {
  config: ComputedFieldDuplicateCaseConfig;
  fixture: ComputedDuplicateFixture;
  seedReadyMeasurement?: Measurement<unknown>;
  primary?: ComputedDuplicatePrimary;
  error?: unknown;
}): PerfRunResult => {
  const duplicateFieldMeasurement =
    primary?.duplicateFieldMeasurement ??
    fixture.completedDuplicateFieldMeasurement;
  const verification =
    primary?.duplicatedComputedScanReadyMeasurement.result ??
    fixture.verificationProgress;
  const duplicateReadyMs = primary
    ? roundMetric(
        primary.duplicateFieldMeasurement.durationMs +
          primary.duplicatedComputedScanReadyMeasurement.durationMs,
      )
    : undefined;
  return {
    metrics: {
      prepareMs: fixture.preparePhase.durationMs,
      seedCacheHit: fixture.seedCacheHit ? 1 : 0,
      seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
      ...(fixture.seedCacheHit
        ? { seedRestoreMs: fixture.preparePhase.durationMs }
        : fixture.seedCacheInfo.enabled
          ? { seedBuildMs: fixture.preparePhase.durationMs }
          : {}),
      ...(seedReadyMeasurement
        ? { seedReadyMs: seedReadyMeasurement.durationMs }
        : {}),
      ...(duplicateFieldMeasurement
        ? { duplicateFieldMs: duplicateFieldMeasurement.durationMs }
        : {}),
      ...(primary
        ? {
            duplicatedComputedScanReadyMs:
              primary.duplicatedComputedScanReadyMeasurement.durationMs,
            computedFieldDuplicateReadyMs: duplicateReadyMs!,
          }
        : {}),
    },
    thresholds: primary
      ? [
          {
            metric: config.threshold.metric,
            max: getPrimaryThresholdMs(config.threshold.maxMs),
            unit: "ms",
          },
        ]
      : [],
    phases: [
      fixture.preparePhase,
      ...fixture.preparePhases,
      ...(seedReadyMeasurement
        ? [
            {
              name: seedReadyMeasurement.name,
              durationMs: seedReadyMeasurement.durationMs,
            },
          ]
        : []),
      ...(duplicateFieldMeasurement
        ? [
            {
              name: duplicateFieldMeasurement.name,
              durationMs: duplicateFieldMeasurement.durationMs,
            },
          ]
        : []),
      ...(primary
        ? [
            {
              name: primary.duplicatedComputedScanReadyMeasurement.name,
              durationMs:
                primary.duplicatedComputedScanReadyMeasurement.durationMs,
            },
          ]
        : []),
    ],
    details: {
      operation: "field-duplicate-computed",
      computedKind: fixture.kind,
      tableId: fixture.tableId,
      tableName: fixture.tableName,
      relatedTableIds: fixture.relatedTableIds,
      sourceFieldId: fixture.sourceFieldId,
      sourceFieldName: fixture.sourceFieldName,
      duplicateFieldName: config.duplicate.name,
      seed: {
        enabled: fixture.seedCacheInfo.enabled,
        cacheHit: fixture.seedCacheHit,
        reusable: fixture.reusable,
        seedHash: fixture.seedCacheInfo.seedHash,
        seedHashShort: fixture.seedCacheInfo.seedHashShort,
        seedTableName: fixture.seedCacheInfo.seedTableName,
        schemaSignature: fixture.seedCacheInfo.schemaSignature,
        ready: seedReadyMeasurement?.result,
        ...fixture.seedDetails,
      },
      response: duplicateFieldMeasurement
        ? {
            status: duplicateFieldMeasurement.result.status,
            headers: duplicateFieldMeasurement.result.responseHeaders,
            routing: duplicateFieldMeasurement.result.routing,
          }
        : undefined,
      sourceField: verification?.sourceField,
      duplicatedField: verification?.duplicatedField,
      fullScan: verification
        ? {
            scannedRecords: verification.scannedRecords,
            pageSize: verification.pageSize,
            pageCount: verification.pageCount,
            complete: Boolean(primary),
          }
        : undefined,
      verifiedSamples: verification?.verifiedSamples,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : undefined,
    },
  };
};

const computedDuplicateSpec: FieldAddLifecycleSpec<
  ComputedFieldDuplicateCaseConfig,
  ComputedDuplicateFixture,
  unknown,
  ComputedDuplicatePrimary
> = {
  prepareFixture: prepareComputedDuplicateFixture,
  assertSeedReady: ({ fixture }) => fixture.assertSourceReady(),
  runPrimary: async ({ perfCase, context, fixture, config }) => {
    const duplicateFieldMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      "duplicateField",
      () =>
        measureAsync("duplicateField", async () => {
          const response = await duplicateField(
            fixture.tableId,
            fixture.sourceFieldId,
            { name: config.duplicate.name },
          );
          expect([200, 201]).toContain(response.status);
          const responseHeaders = pickRoutingResponseHeaders(
            response.headers as Record<string, unknown>,
          );
          return {
            field: response.data as NamedComputedField,
            status: response.status,
            responseHeaders,
            routing: assertExpectedRouting(context, responseHeaders),
          };
        }),
    );
    fixture.completedDuplicateFieldMeasurement = duplicateFieldMeasurement;
    const duplicatedComputedScanReadyMeasurement = await measureAsync(
      "duplicatedComputedScanReady",
      () =>
        pollUntilReady(
          {
            timeoutMs: config.verify.timeoutMs ?? 120_000,
            pollIntervalMs: config.verify.pollIntervalMs ?? 500,
            description: `${fixture.kind} duplicated field full scan`,
          },
          () =>
            fixture.verifyDuplicate(duplicateFieldMeasurement.result.field.id),
        ),
    );
    return {
      duplicateFieldMeasurement,
      duplicatedComputedScanReadyMeasurement,
    };
  },
  buildResult: ({ config, fixture, seedReadyMeasurement, primary, error }) => {
    if (!fixture) {
      throw new Error(
        "computed field-duplicate buildResult invoked without a fixture",
      );
    }
    return buildComputedDuplicateResult({
      config,
      fixture,
      seedReadyMeasurement,
      primary,
      error,
    });
  },
  cleanup: async ({ baseId, fixture, config }) => {
    if (isExecuteDbIsolated() || !fixture) {
      return;
    }
    if (fixture.reusable) {
      try {
        const duplicatedField = (await getNamedFields(fixture.tableId)).find(
          (field) => field.name === config.duplicate.name,
        );
        if (duplicatedField) {
          await deleteField(fixture.tableId, duplicatedField.id);
        }
      } catch (error) {
        console.warn(
          `Failed to cleanup duplicated computed field on ${fixture.tableId}`,
          error,
        );
      }
      return;
    }
    if (fixture.kind === "rollup") {
      for (const tableId of [fixture.tableId, ...fixture.relatedTableIds]) {
        try {
          await permanentDeleteTable(baseId, tableId);
        } catch (error) {
          console.warn(
            `Failed to cleanup Rollup duplicate fixture table ${tableId}`,
            error,
          );
        }
      }
      return;
    }
    for (const tableId of [fixture.tableId, ...fixture.relatedTableIds]) {
      try {
        await permanentDeleteTable(baseId, tableId);
      } catch (error) {
        console.warn(
          `Failed to cleanup computed fixture table ${tableId}`,
          error,
        );
      }
    }
  },
};

export const seedComputedFieldDuplicateCase = (
  perfCase: PerfCaseFor<"field-duplicate">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedFieldAddLifecycle(perfCase, context, computedDuplicateSpec);

export const runComputedFieldDuplicateCase = (
  perfCase: PerfCaseFor<"field-duplicate">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runFieldAddLifecycle(perfCase, context, computedDuplicateSpec);
