import { FieldKeyType, FieldType } from "@teable/core";
import { PrismaService } from "@teable/db-main-prisma";
import { createField as apiCreateField } from "@teable/openapi";
import {
  createRecords,
  createTable,
  deleteField,
  getFields,
  getRecords,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { chunk } from "../chunk";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, type Measurement } from "../metrics";
import { pollUntilReady } from "../readiness";
import { forEachRecordPage } from "../record-page-scan";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import {
  buildSeedCacheInfo,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { queryPerfDb } from "../sql";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  FieldCreateCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  runFieldAddLifecycle,
  seedFieldAddLifecycle,
  type FieldAddLifecycleSpec,
} from "./field-add-lifecycle";

type FieldCreateFixture = {
  tableId: string;
  tableName: string;
  dbTableName?: string;
  viewId?: string;
  seedRecordCount?: number;
  seedBatchDurations?: number[];
  seedCacheInfo?: SeedCacheInfo;
  seedCacheHit?: boolean;
  reusableSeed?: boolean;
};

type SelectChoice = {
  id?: string;
  name: string;
  color?: string;
};

type SelectOptions = {
  choices?: SelectChoice[];
};

type FormulaOptions = {
  expression?: string;
};

type FieldOptions = Record<string, unknown>;

type CreatedField = {
  id: string;
  name: string;
  type: FieldType;
  options?: FieldOptions & SelectOptions & FormulaOptions;
};

type FieldCreateInput = FieldCreateCaseConfig["fields"][number];

type FieldCreatePrimaryResult = {
  fieldIds: string[];
  fields: Array<{
    id: string;
    name: string;
    type: FieldType;
    optionCount?: number;
    responseHeaders: Record<string, string>;
    routing: FieldCreateRouting;
  }>;
};

type FieldCreateVerification = {
  verifiedFields: Array<{
    name: string;
    type: FieldType;
    optionCount?: number;
    expression?: string;
  }>;
  verifiedOptions?: Array<{
    index: number;
    name: string;
    color?: string;
  }>;
  emptyCreatedValues?: {
    scannedRecords: number;
    checkedFieldCount: number;
    checkedCellCount: number;
  };
};

type FieldCreateReadyVerification = {
  metric: "computedBackfillReadyMs";
  startedAfterMetric: string;
  attempts: number;
  totalRows: number;
  expectedRows: number;
  dbTableName: string;
  dependencyFields: Array<
    FieldStorageMeta & { role: "title" | "A" | "B" | "C" }
  >;
  computedFields: Array<
    FieldStorageMeta & { expectedKind: FormulaExpectedKind }
  >;
  checks: ComputedBackfillCheck[];
  sampleRows: ComputedBackfillSampleRow[];
};

type FieldCreateRouting = EngineRouting;

type FieldStorageMeta = {
  id: string;
  name: string;
  dbFieldName: string;
  dbFieldType: string;
};

type FormulaExpectedKind =
  | "aTimesBPlusC"
  | "aPlusBPlusC"
  | "aTimesCPlusB"
  | "aPlusBTimesC"
  | "weightedABC";

type ComputedBackfillCheck = {
  name: string;
  fieldId: string;
  dbFieldName: string;
  dbFieldType: string;
  nulls: number;
  mismatches: number;
};

type ComputedBackfillSqlRow = Record<string, string | number | null>;

type ComputedBackfillSampleRow = {
  a: number;
  b: number;
  c: number;
  formulas: Array<{
    name: string;
    fieldId: string;
    actual: number | null;
    expected: number | null;
  }>;
};

const FIELD_CREATE_FIXTURE_VERSION = "field-create-v1";

const assertSingleSelectOptions = (
  field: CreatedField | undefined,
  config: FieldCreateCaseConfig,
) => {
  if (!config.field) {
    throw new Error("Single select verification requires config.field");
  }
  if (!field) {
    throw new Error(`Missing created field ${config.field.name}`);
  }
  if (field.type !== FieldType.SingleSelect) {
    throw new Error(
      `Created field ${field.name} has type ${field.type}, expected ${FieldType.SingleSelect}`,
    );
  }

  const expectedChoices = (config.field.options as SelectOptions | undefined)
    ?.choices;
  const actualChoices = field.options?.choices;
  if (!expectedChoices?.length) {
    throw new Error(`Case field ${config.field.name} has no expected choices`);
  }
  if (!actualChoices) {
    throw new Error(`Created field ${field.name} has no choices`);
  }
  if (actualChoices.length !== config.verify.optionCount) {
    throw new Error(
      `Created field ${field.name} choice count mismatch: expected ${config.verify.optionCount}, got ${actualChoices.length}`,
    );
  }

  return (config.verify.sampleOptionIndexes ?? []).map((index) => {
    const expected = expectedChoices[index];
    const actual = actualChoices[index];
    if (!expected || !actual) {
      throw new Error(`Missing option sample at index ${index}`);
    }
    if (expected.name !== actual.name || expected.color !== actual.color) {
      throw new Error(
        `Option ${index} mismatch: expected ${JSON.stringify(
          expected,
        )}, got ${JSON.stringify(actual)}`,
      );
    }
    return {
      index,
      name: actual.name,
      color: actual.color,
    };
  });
};

const assertExpectedOptionSubset = (
  actual: unknown,
  expected: unknown,
  path: string,
) => {
  if (
    path.endsWith(".formatting.timeZone") &&
    typeof actual === "string" &&
    typeof expected === "string" &&
    actual.toLowerCase() === expected.toLowerCase()
  ) {
    return;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      throw new Error(`${path} expected array, got ${JSON.stringify(actual)}`);
    }
    if (actual.length !== expected.length) {
      throw new Error(
        `${path} length mismatch: expected ${expected.length}, got ${actual.length}`,
      );
    }
    expected.forEach((expectedItem, index) =>
      assertExpectedOptionSubset(
        actual[index],
        expectedItem,
        `${path}[${index}]`,
      ),
    );
    return;
  }

  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") {
      throw new Error(`${path} expected object, got ${JSON.stringify(actual)}`);
    }
    for (const [key, expectedValue] of Object.entries(
      expected as Record<string, unknown>,
    )) {
      assertExpectedOptionSubset(
        (actual as Record<string, unknown>)[key],
        expectedValue,
        `${path}.${key}`,
      );
    }
    return;
  }

  if (actual !== expected) {
    throw new Error(
      `${path} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(
        actual,
      )}`,
    );
  }
};

const getCreateFields = (config: FieldCreateCaseConfig) => {
  const fields = config.fields ?? (config.field ? [config.field] : []);
  if (fields.length === 0) {
    throw new Error("Field create case must define field or fields");
  }
  return fields;
};

const getPrimaryField = (config: FieldCreateCaseConfig) =>
  config.baseFields[0]?.name ?? "Title";

const buildSeedRecordFields = (
  config: FieldCreateCaseConfig,
  rowNumber: number,
) => {
  const title = `${config.generator?.titlePrefix ?? "Item"} ${String(rowNumber).padStart(5, "0")}`;
  if (config.generator?.type === "numeric-sequence") {
    return {
      [getPrimaryField(config)]: title,
      A: rowNumber,
      B: (rowNumber % 97) + 1,
      C: rowNumber % 13,
    };
  }

  return {
    [getPrimaryField(config)]: title,
  };
};

const getFormulaExpectedKind = (
  field: FieldCreateInput,
): FormulaExpectedKind => {
  const expression = (field.options as FormulaOptions | undefined)?.expression;
  const normalizedExpression = expression?.replace(/\s+/g, "");
  switch (normalizedExpression) {
    case "({A}*{B})+{C}":
      return "aTimesBPlusC";
    case "{A}+{B}+{C}":
      return "aPlusBPlusC";
    case "({A}*{C})+{B}":
      return "aTimesCPlusB";
    case "{A}+({B}*{C})":
      return "aPlusBTimesC";
    case "({A}*3)+({B}*5)+({C}*7)":
      return "weightedABC";
    default:
      throw new Error(
        `Unsupported formula field ready expression for ${field.name}: ${String(
          expression,
        )}`,
      );
  }
};

const quoteSqlIdentifier = (identifier: string) =>
  `"${identifier.replace(/"/g, '""')}"`;

const getSqlTableRef = (baseId: string, dbTableName: string) => {
  const [schemaName, tableName, ...rest] = dbTableName.split(".");
  if (tableName && rest.length === 0) {
    return `${quoteSqlIdentifier(schemaName)}.${quoteSqlIdentifier(tableName)}`;
  }
  return `${quoteSqlIdentifier(baseId)}.${quoteSqlIdentifier(dbTableName)}`;
};

const getNumericSqlExpression = (field: FieldStorageMeta) => {
  const columnRef = quoteSqlIdentifier(field.dbFieldName);
  switch (field.dbFieldType.toUpperCase()) {
    case "INTEGER":
    case "REAL":
      return `(${columnRef})::double precision`;
    case "TEXT":
      return `NULLIF(${columnRef}, '')::double precision`;
    case "JSON":
      return `NULLIF(${columnRef}#>>'{}', '')::double precision`;
    default:
      throw new Error(
        `Unsupported numeric SQL comparison type for ${field.name}: ${field.dbFieldType}`,
      );
  }
};

const getExpectedFormulaSqlByKind = (
  a: string,
  b: string,
  c: string,
): Record<FormulaExpectedKind, string> => ({
  aTimesBPlusC: `((${a} * ${b}) + ${c})`,
  aPlusBPlusC: `(${a} + ${b} + ${c})`,
  aTimesCPlusB: `((${a} * ${c}) + ${b})`,
  aPlusBTimesC: `(${a} + (${b} * ${c}))`,
  weightedABC: `((${a} * 3) + (${b} * 5) + (${c} * 7))`,
});

const compileFormulaExpression = (
  expression: string,
  fields: Array<{ id: string; name: string }>,
) => {
  const fieldIdByName = new Map(fields.map((field) => [field.name, field.id]));
  return expression.replace(/\{([^}]+)\}/g, (match, fieldName: string) => {
    const fieldId = fieldIdByName.get(fieldName);
    return fieldId ? `{${fieldId}}` : match;
  });
};

const buildCreateFieldsForTable = async (
  fixture: FieldCreateFixture,
  config: FieldCreateCaseConfig,
) => {
  const fieldsToCreate = getCreateFields(config);
  if (
    !fieldsToCreate.some(
      (field) =>
        field.type === FieldType.Formula &&
        typeof (field.options as FormulaOptions | undefined)?.expression ===
          "string",
    )
  ) {
    return fieldsToCreate;
  }

  const tableFields = (await getFields(fixture.tableId)) as CreatedField[];
  return fieldsToCreate.map((field) => {
    const expression = (field.options as FormulaOptions | undefined)
      ?.expression;
    if (field.type !== FieldType.Formula || !expression) {
      return field;
    }

    return {
      ...field,
      options: {
        ...field.options,
        expression: compileFormulaExpression(expression, tableFields),
      },
    };
  });
};

const resolveFieldByName = <T extends { name: string }>(
  fields: T[],
  fieldName: string,
): T => {
  const field = fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw new Error(
      `Missing field ${fieldName}; available fields: ${fields
        .map((candidate) => candidate.name)
        .join(", ")}`,
    );
  }
  return field;
};

const buildComputedReadyFields = (
  config: FieldCreateCaseConfig,
  primaryResult: FieldCreatePrimaryResult,
) =>
  getCreateFields(config)
    .map((field, index) => ({
      field,
      createdField: primaryResult.fields[index],
    }))
    .filter(({ field }) => field.type === FieldType.Formula)
    .map(({ field, createdField }) => {
      if (!createdField) {
        throw new Error(`Missing created formula field ${field.name}`);
      }

      return {
        name: field.name,
        fieldId: createdField.id,
        expectedKind: getFormulaExpectedKind(field),
      };
    });

const resolveFieldStorage = async (
  context: PerfRunContext,
  tableId: string,
): Promise<{ dbTableName: string; fields: FieldStorageMeta[] }> => {
  const prisma = context.app.get<PrismaService>(PrismaService);
  const tableMeta = await prisma.tableMeta.findUniqueOrThrow({
    where: { id: tableId },
    select: {
      dbTableName: true,
      fields: {
        where: { deletedTime: null },
        select: {
          id: true,
          name: true,
          dbFieldName: true,
          dbFieldType: true,
        },
      },
    },
  });

  return {
    dbTableName: tableMeta.dbTableName,
    fields: tableMeta.fields as unknown as FieldStorageMeta[],
  };
};

const buildComputedBackfillSql = ({
  baseId,
  dbTableName,
  aField,
  bField,
  cField,
  computedFields,
}: {
  baseId: string;
  dbTableName: string;
  aField: FieldStorageMeta;
  bField: FieldStorageMeta;
  cField: FieldStorageMeta;
  computedFields: Array<
    FieldStorageMeta & { expectedKind: FormulaExpectedKind }
  >;
}) => {
  const a = getNumericSqlExpression(aField);
  const b = getNumericSqlExpression(bField);
  const c = getNumericSqlExpression(cField);
  const expectedSqlByKind = getExpectedFormulaSqlByKind(a, b, c);

  const checks = computedFields.flatMap((field, index) => {
    const actual = getNumericSqlExpression(field);
    const expected = expectedSqlByKind[field.expectedKind];
    return [
      `COUNT(*) FILTER (WHERE ${quoteSqlIdentifier(
        field.dbFieldName,
      )} IS NULL)::text AS "f${index}_nulls"`,
      `COUNT(*) FILTER (WHERE ${quoteSqlIdentifier(
        field.dbFieldName,
      )} IS NOT NULL AND abs(${actual} - ${expected}) > 0.000001)::text AS "f${index}_mismatches"`,
    ];
  });

  return `
    SELECT
      COUNT(*)::text AS "total",
      ${checks.join(",\n      ")}
    FROM ${getSqlTableRef(baseId, dbTableName)}
  `;
};

const buildComputedBackfillSampleSql = ({
  baseId,
  dbTableName,
  aField,
  bField,
  cField,
  computedFields,
  sampleAValues,
}: {
  baseId: string;
  dbTableName: string;
  aField: FieldStorageMeta;
  bField: FieldStorageMeta;
  cField: FieldStorageMeta;
  computedFields: Array<
    FieldStorageMeta & { expectedKind: FormulaExpectedKind }
  >;
  sampleAValues: number[];
}) => {
  const a = getNumericSqlExpression(aField);
  const b = getNumericSqlExpression(bField);
  const c = getNumericSqlExpression(cField);
  const expectedSqlByKind = getExpectedFormulaSqlByKind(a, b, c);
  const formulaColumns = computedFields.flatMap((field, index) => {
    const actual = getNumericSqlExpression(field);
    const expected = expectedSqlByKind[field.expectedKind];
    return [
      `${actual} AS "f${index}_actual"`,
      `${expected} AS "f${index}_expected"`,
    ];
  });

  return `
    SELECT
      ${a} AS "a",
      ${b} AS "b",
      ${c} AS "c",
      ${formulaColumns.join(",\n      ")}
    FROM ${getSqlTableRef(baseId, dbTableName)}
    WHERE ${a} IN (${sampleAValues.join(", ")})
    ORDER BY ${a}
  `;
};

const toNumberOrNull = (value: unknown) =>
  value == null ? null : Number(value);

const assertComputedBackfillReady = async (
  baseId: string,
  context: PerfRunContext,
  fixture: FieldCreateFixture,
  config: FieldCreateCaseConfig,
  primaryResult: FieldCreatePrimaryResult,
  attempts: number,
): Promise<FieldCreateReadyVerification> => {
  if (!config.ready) {
    throw new Error("Computed field ready verification requires config.ready");
  }
  if (config.generator?.type !== "numeric-sequence") {
    throw new Error(
      "Computed field ready verification requires numeric-sequence",
    );
  }

  const storage = await resolveFieldStorage(context, fixture.tableId);
  fixture.dbTableName = storage.dbTableName;
  const titleField = {
    ...resolveFieldByName(storage.fields, getPrimaryField(config)),
    role: "title" as const,
  };
  const aField = {
    ...resolveFieldByName(storage.fields, "A"),
    role: "A" as const,
  };
  const bField = {
    ...resolveFieldByName(storage.fields, "B"),
    role: "B" as const,
  };
  const cField = {
    ...resolveFieldByName(storage.fields, "C"),
    role: "C" as const,
  };
  const computedFields = buildComputedReadyFields(config, primaryResult).map(
    (field) => ({
      ...resolveFieldByName(storage.fields, field.name),
      expectedKind: field.expectedKind,
    }),
  );
  if (computedFields.length === 0) {
    throw new Error(
      "Computed field ready verification found no formula fields",
    );
  }

  const rows = await queryPerfDb<ComputedBackfillSqlRow>(
    buildComputedBackfillSql({
      baseId,
      dbTableName: storage.dbTableName,
      aField,
      bField,
      cField,
      computedFields,
    }),
  );
  const row = rows[0];
  if (!row) {
    throw new Error("Computed backfill SQL returned no rows");
  }

  const totalRows = Number(row.total);
  const checks = computedFields.map((field, index) => ({
    name: field.name,
    fieldId: field.id,
    dbFieldName: field.dbFieldName,
    dbFieldType: field.dbFieldType,
    nulls: Number(row[`f${index}_nulls`] ?? 0),
    mismatches: Number(row[`f${index}_mismatches`] ?? 0),
  }));
  const rowCount = config.rowCount ?? 0;
  const notReady = checks.filter(
    (check) => check.nulls !== 0 || check.mismatches !== 0,
  );

  if (totalRows !== rowCount || notReady.length > 0) {
    throw new Error(
      `Computed backfill not ready: total=${totalRows}/${rowCount}, checks=${JSON.stringify(
        checks,
      )}`,
    );
  }

  const sampleAValues = [1, Math.max(1, Math.ceil(rowCount / 2)), rowCount];
  const sampleRows = await queryPerfDb<ComputedBackfillSqlRow>(
    buildComputedBackfillSampleSql({
      baseId,
      dbTableName: storage.dbTableName,
      aField,
      bField,
      cField,
      computedFields,
      sampleAValues,
    }),
  );

  return {
    metric: config.ready.metric,
    startedAfterMetric: config.threshold.metric,
    attempts,
    totalRows,
    expectedRows: rowCount,
    dbTableName: storage.dbTableName,
    dependencyFields: [titleField, aField, bField, cField],
    computedFields,
    checks,
    sampleRows: sampleRows.map((sampleRow) => ({
      a: Number(sampleRow.a),
      b: Number(sampleRow.b),
      c: Number(sampleRow.c),
      formulas: computedFields.map((field, index) => ({
        name: field.name,
        fieldId: field.id,
        actual: toNumberOrNull(sampleRow[`f${index}_actual`]),
        expected: toNumberOrNull(sampleRow[`f${index}_expected`]),
      })),
    })),
  };
};

const waitForComputedFieldsReady = (
  baseId: string,
  context: PerfRunContext,
  fixture: FieldCreateFixture,
  config: FieldCreateCaseConfig,
  primaryResult: FieldCreatePrimaryResult,
) => {
  let attempts = 0;
  return pollUntilReady(
    {
      timeoutMs: config.ready?.timeoutMs ?? 30_000,
      pollIntervalMs: config.ready?.pollIntervalMs ?? 200,
      description: "computed backfill ready",
    },
    () => {
      attempts += 1;
      return assertComputedBackfillReady(
        baseId,
        context,
        fixture,
        config,
        primaryResult,
        attempts,
      );
    },
  );
};

const pickResponseHeaders = pickRoutingResponseHeaders;

const assertExpectedRouting = (
  context: PerfRunContext,
  responseHeaders: Record<string, string>,
) =>
  assertEngineRouting(context, responseHeaders, {
    operation: "Field create",
  });

const assertSeedReady = async (
  fixture: FieldCreateFixture,
  config: FieldCreateCaseConfig,
) => {
  const fields = (await getFields(fixture.tableId)) as CreatedField[];
  const baseFieldNames = new Set(config.baseFields.map((field) => field.name));
  const rowCount = config.rowCount ?? 0;
  const missingBaseFields = config.baseFields.filter(
    (field) => !fields.some((actual) => actual.name === field.name),
  );
  if (missingBaseFields.length > 0) {
    throw new Error(
      `Missing base fields: ${missingBaseFields.map((field) => field.name).join(", ")}`,
    );
  }

  for (const field of fields) {
    if (!baseFieldNames.has(field.name)) {
      await deleteField(fixture.tableId, field.id);
    }
  }

  const views = await getViews(fixture.tableId);
  const viewId = views[0]?.id;
  if (!viewId) {
    throw new Error(`Missing default view for table ${fixture.tableId}`);
  }

  if (rowCount > 0) {
    const pageSize = config.verify.fullScanPageSize ?? 1_000;
    const { scannedRecords } = await forEachRecordPage(
      {
        totalRows: rowCount,
        pageSize,
        fetchPage: (skip, take) =>
          getRecords(fixture.tableId, {
            viewId,
            fieldKeyType: FieldKeyType.Name,
            skip,
            take,
          }),
        pageNoun: "seed records",
      },
      () => {},
    );
    fixture.viewId = viewId;
    fixture.seedRecordCount = scannedRecords;
  }

  return {
    fieldCount: fields.length,
    baseFieldCount: config.baseFields.length,
    rowCount,
  };
};

const seedRecords = async (
  fixture: FieldCreateFixture,
  config: FieldCreateCaseConfig,
) => {
  const rowCount = config.rowCount ?? 0;
  if (rowCount <= 0) {
    return [];
  }

  const batchSize = config.batchSize ?? 1_000;
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    fields: buildSeedRecordFields(config, index + 1),
  }));
  const batchDurations: number[] = [];

  for (const [batchIndex, batch] of chunk(rows, batchSize).entries()) {
    const batchMeasurement = await measureAsync(
      `seedRecords:${batchIndex + 1}`,
      () =>
        createRecords(fixture.tableId, {
          fieldKeyType: FieldKeyType.Name,
          typecast: false,
          records: batch,
        }),
    );
    expect(batchMeasurement.result.records).toHaveLength(batch.length);
    batchDurations.push(batchMeasurement.durationMs);
  }

  fixture.seedRecordCount = rowCount;
  fixture.seedBatchDurations = batchDurations;
  return batchDurations;
};

const buildFieldCreateFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  tableName: string,
  config: FieldCreateCaseConfig,
  seedCacheInfo: SeedCacheInfo,
): Promise<FieldCreateFixture> => {
  if (seedCacheInfo.enabled) {
    const cachedTable = await findSeedTable(
      baseId,
      seedCacheInfo.seedTableName,
    );
    if (cachedTable) {
      const fixture = {
        tableId: cachedTable.id,
        tableName: cachedTable.name,
        seedCacheInfo,
        seedCacheHit: true,
        reusableSeed: true,
      };
      try {
        await assertSeedReady(fixture, config);
        return fixture;
      } catch (error) {
        console.warn(
          `Invalid cached field create seed ${seedCacheInfo.seedTableName}; rebuilding`,
          error,
        );
        await permanentDeleteTable(baseId, cachedTable.id);
      }
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
            fields: config.baseFields,
            records: [],
          }),
        ),
    );
    createdTableId = createTableMeasurement.result.id;
    const fixture = {
      tableId: createdTableId,
      tableName: actualTableName,
      seedCacheInfo,
      seedCacheHit: false,
      reusableSeed: seedCacheInfo.enabled,
    };
    await seedRecords(fixture, config);
    return fixture;
  } catch (error) {
    if (createdTableId) {
      try {
        await permanentDeleteTable(baseId, createdTableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup incomplete field create seed ${createdTableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const runFieldCreatePrimary = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: FieldCreateFixture,
  config: FieldCreateCaseConfig,
  fieldsToCreate: FieldCreateInput[],
): Promise<Measurement<FieldCreatePrimaryResult>> => {
  const createdFields: FieldCreatePrimaryResult["fields"] = [];

  return measureAsync(config.threshold.metric.replace(/Ms$/, ""), async () => {
    const createOneField = async (
      field: FieldCreateInput,
      fieldIndex: number,
    ) => {
      const createField = async () => {
        const createResponse = await apiCreateField(fixture.tableId, field);
        expect(createResponse.status).toBe(201);

        const responseHeaders = pickResponseHeaders(
          createResponse.headers as Record<string, unknown>,
        );
        const routing = assertExpectedRouting(context, responseHeaders);
        const createdField = createResponse.data as CreatedField;
        createdFields.push({
          id: createdField.id,
          name: createdField.name,
          type: createdField.type,
          optionCount: createdField.options?.choices?.length,
          responseHeaders,
          routing,
        });
      };

      if (config.tracePerField) {
        await withPerfTraceStep(
          context,
          perfCase,
          `${config.threshold.metric}:${fieldIndex + 1}`,
          createField,
        );
        return;
      }
      await createField();
    };

    if (config.tracePerField) {
      for (const [fieldIndex, field] of fieldsToCreate.entries()) {
        await createOneField(field, fieldIndex);
      }
    } else {
      await withPerfTraceStep(
        context,
        perfCase,
        config.threshold.metric,
        async () => {
          for (const [fieldIndex, field] of fieldsToCreate.entries()) {
            await createOneField(field, fieldIndex);
          }
        },
      );
    }

    return {
      fieldIds: createdFields.map((field) => field.id),
      fields: createdFields,
    };
  });
};

const verifyCreatedFieldValuesEmpty = async (
  fixture: FieldCreateFixture,
  config: FieldCreateCaseConfig,
  createdFields: FieldCreatePrimaryResult["fields"],
) => {
  if (!config.verify.emptyCreatedFields) {
    return;
  }
  if (!fixture.viewId) {
    throw new Error(`Missing default view for table ${fixture.tableId}`);
  }
  const rowCount = config.rowCount ?? 0;
  const projection = createdFields.map((field) => field.id);
  let checkedCellCount = 0;
  const { scannedRecords } = await forEachRecordPage(
    {
      totalRows: rowCount,
      pageSize: config.verify.fullScanPageSize ?? 1_000,
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          viewId: fixture.viewId,
          fieldKeyType: FieldKeyType.Id,
          projection,
          skip,
          take,
        }),
      pageNoun: "created field values",
    },
    (record, rowNumber) => {
      for (const field of createdFields) {
        const value = record.fields[field.id];
        if (value != null) {
          throw new Error(
            `Created field ${field.name} row ${rowNumber} expected empty value, got ${JSON.stringify(value)}`,
          );
        }
        checkedCellCount += 1;
      }
    },
  );

  return {
    scannedRecords,
    checkedFieldCount: createdFields.length,
    checkedCellCount,
  };
};

const verifyCreatedFields = async (
  fixture: FieldCreateFixture,
  config: FieldCreateCaseConfig,
  expectedFields = getCreateFields(config),
): Promise<FieldCreateVerification> => {
  const fields = (await getFields(fixture.tableId)) as CreatedField[];
  const verifiedFields = expectedFields.map((expectedField) => {
    const actualField = fields.find(
      (field) => field.name === expectedField.name,
    );
    if (!actualField) {
      throw new Error(`Missing created field ${expectedField.name}`);
    }
    if (actualField.type !== expectedField.type) {
      throw new Error(
        `Created field ${actualField.name} has type ${actualField.type}, expected ${expectedField.type}`,
      );
    }
    const expectedChoices = (expectedField.options as SelectOptions | undefined)
      ?.choices;
    const actualChoices = actualField.options?.choices;
    if (expectedField.options) {
      assertExpectedOptionSubset(
        actualField.options,
        expectedField.options,
        `${actualField.name}.options`,
      );
    }
    if (expectedChoices?.length || actualChoices?.length) {
      if (expectedChoices?.length !== actualChoices?.length) {
        throw new Error(
          `Created field ${actualField.name} choice count mismatch: expected ${expectedChoices?.length ?? 0}, got ${actualChoices?.length ?? 0}`,
        );
      }
      for (const [choiceIndex, expectedChoice] of (
        expectedChoices ?? []
      ).entries()) {
        const actualChoice = actualChoices?.[choiceIndex];
        if (
          !actualChoice ||
          actualChoice.name !== expectedChoice.name ||
          actualChoice.color !== expectedChoice.color
        ) {
          throw new Error(
            `Created field ${actualField.name} option ${choiceIndex} mismatch: expected ${JSON.stringify(
              expectedChoice,
            )}, got ${JSON.stringify(actualChoice)}`,
          );
        }
      }
    }
    return {
      name: actualField.name,
      type: actualField.type,
      optionCount: actualChoices?.length,
      expression: actualField.options?.expression,
    };
  });

  const verifiedOptions =
    config.field && config.verify.optionCount != null
      ? assertSingleSelectOptions(
          fields.find((field) => field.name === config.field?.name),
          config,
        )
      : undefined;

  return {
    verifiedFields,
    verifiedOptions,
  };
};

const buildFieldCreateResult = ({
  config,
  prepareMeasurement,
  seedReadyMeasurement,
  primaryMeasurement,
  readyMeasurement,
  verification,
  error,
}: {
  config: FieldCreateCaseConfig;
  prepareMeasurement?: Measurement<FieldCreateFixture>;
  seedReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertSeedReady>>
  >;
  primaryMeasurement?: Measurement<FieldCreatePrimaryResult>;
  readyMeasurement?: Measurement<
    Awaited<ReturnType<typeof waitForComputedFieldsReady>>
  >;
  verification?: FieldCreateVerification;
  error?: unknown;
}): PerfRunResult => {
  const fixture = prepareMeasurement?.result;
  const primaryResult = primaryMeasurement?.result;

  return {
    metrics: {
      ...(prepareMeasurement
        ? { fieldCreatePrepareMs: prepareMeasurement.durationMs }
        : {}),
      ...(fixture?.seedCacheInfo
        ? {
            seedCacheHit: fixture.seedCacheHit ? 1 : 0,
            seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
            ...(fixture.seedCacheHit
              ? { seedRestoreMs: prepareMeasurement?.durationMs ?? 0 }
              : fixture.seedCacheInfo.enabled
                ? { seedBuildMs: prepareMeasurement?.durationMs ?? 0 }
                : {}),
            ...(seedReadyMeasurement
              ? { seedReadyMs: seedReadyMeasurement.durationMs }
              : {}),
          }
        : {}),
      ...(primaryMeasurement
        ? { [config.threshold.metric]: primaryMeasurement.durationMs }
        : {}),
      ...(readyMeasurement && config.ready
        ? { [config.ready.metric]: readyMeasurement.durationMs }
        : {}),
    },
    thresholds: primaryMeasurement
      ? [
          {
            metric: config.threshold.metric,
            max: getPrimaryThresholdMs(config.threshold.maxMs),
            unit: "ms",
          },
        ]
      : [],
    phases: [
      ...(prepareMeasurement
        ? [
            {
              name: prepareMeasurement.name,
              durationMs: prepareMeasurement.durationMs,
            },
          ]
        : []),
      ...(seedReadyMeasurement
        ? [
            {
              name: seedReadyMeasurement.name,
              durationMs: seedReadyMeasurement.durationMs,
            },
          ]
        : []),
      ...(primaryMeasurement
        ? [
            {
              name: primaryMeasurement.name,
              durationMs: primaryMeasurement.durationMs,
            },
          ]
        : []),
      ...(readyMeasurement
        ? [
            {
              name: readyMeasurement.name,
              durationMs: readyMeasurement.durationMs,
            },
          ]
        : []),
    ],
    details: {
      tableId: fixture?.tableId,
      tableName: fixture?.tableName,
      seedRecordCount: fixture?.seedRecordCount ?? config.rowCount ?? 0,
      fieldNames: getCreateFields(config).map((field) => field.name),
      fieldIds: primaryResult?.fieldIds,
      createdFields: primaryResult?.fields,
      verifiedFields: verification?.verifiedFields,
      verifiedOptions: verification?.verifiedOptions,
      emptyCreatedValues: verification?.emptyCreatedValues,
      ready: readyMeasurement
        ? {
            metric: readyMeasurement.result.metric,
            durationMs: readyMeasurement.durationMs,
            startedAfterMetric: readyMeasurement.result.startedAfterMetric,
            verification: "db-aggregate",
            attempts: readyMeasurement.result.attempts,
            totalRows: readyMeasurement.result.totalRows,
            expectedRows: readyMeasurement.result.expectedRows,
            dbTableName: readyMeasurement.result.dbTableName,
            dependencyFields: readyMeasurement.result.dependencyFields,
            computedFields: readyMeasurement.result.computedFields,
            checks: readyMeasurement.result.checks,
            sampleRows: readyMeasurement.result.sampleRows,
          }
        : undefined,
      prepare: fixture
        ? {
            durationMs: prepareMeasurement.durationMs,
            seedCacheEnabled: fixture.seedCacheInfo?.enabled,
            seedCacheHit: fixture.seedCacheHit,
            seedHash: fixture.seedCacheInfo?.seedHash,
            seedTableName: fixture.seedCacheInfo?.seedTableName,
            seedRecordCount: fixture.seedRecordCount,
            seedBatchDurations: fixture.seedBatchDurations,
            sharedSeedIdentity: Boolean(config.seedIdentity),
          }
        : undefined,
      ...(error
        ? {
            diagnosticError:
              error instanceof Error ? error.message : String(error),
          }
        : {}),
    },
  };
};

const getFieldCreateSeedConfig = (config: FieldCreateCaseConfig) => ({
  ...(config.seedIdentity
    ? { seedIdentity: config.seedIdentity }
    : { tableNamePrefix: config.tableNamePrefix }),
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  baseFields: config.baseFields,
  generator: config.generator,
});

const getFieldCreateSeedIdentityCase = (
  perfCase: PerfCase,
  seedIdentity?: string,
) =>
  seedIdentity
    ? ({
        ...perfCase,
        id: `field-create/shared-${seedIdentity}`,
      } as PerfCase)
    : perfCase;

const buildSeedCache = (perfCase: PerfCase, config: FieldCreateCaseConfig) =>
  buildSeedCacheInfo({
    perfCase: getFieldCreateSeedIdentityCase(perfCase, config.seedIdentity),
    runner: "field-create",
    fixtureVersion: FIELD_CREATE_FIXTURE_VERSION,
    seedConfig: getFieldCreateSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });

type FieldCreateLifecycleFixture = FieldCreateFixture & {
  // The prepare phase the driver does not emit: in the execute path it is the
  // measured "prepareFieldCreate" phase; in the seed path it is the measured
  // "seedBuild"/"seedRestore" phase. Carried on the (mutable) fixture so
  // buildResult can rebuild the prepare measurement from the live object,
  // after seedReady/backfill have mutated it in place.
  prepareName: string;
  prepareDurationMs: number;
};

type FieldCreateSeedReadyResult = Awaited<ReturnType<typeof assertSeedReady>>;

type FieldCreatePrimary = {
  primaryMeasurement: Measurement<FieldCreatePrimaryResult>;
  readyMeasurement?: Measurement<
    Awaited<ReturnType<typeof waitForComputedFieldsReady>>
  >;
  verification: FieldCreateVerification;
};

// field-create rides the field-add lifecycle as the third member, with the
// widest variation: it seeds an empty (base-fields-only) table, adds N fields in
// one measured trace step (per-field routing), optionally polls until the
// formula columns finish their computed backfill, verifies the created fields
// (and single-select options), then restores the seed by deleting the added
// (non-base) fields. Unlike the prior two members its prepare is a single
// measured phase, so prepareFixture owns that measurement and parks it on the
// fixture; the driver itself is unchanged.
const fieldCreateFieldAddSpec: FieldAddLifecycleSpec<
  FieldCreateCaseConfig,
  FieldCreateLifecycleFixture,
  FieldCreateSeedReadyResult,
  FieldCreatePrimary
> = {
  prepareFixture: async ({ perfCase, context, baseId, config, seedMode }) => {
    const seedCacheInfo = await buildSeedCache(perfCase, config);
    if (seedMode) {
      const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
      const prepareMeasurement = await measureAsync("prepareFieldCreate", () =>
        buildFieldCreateFixture(
          perfCase,
          context,
          baseId,
          tableName,
          config,
          seedCacheInfo,
        ),
      );
      return Object.assign(prepareMeasurement.result, {
        prepareName: prepareMeasurement.result.seedCacheHit
          ? "seedRestore"
          : "seedBuild",
        prepareDurationMs: prepareMeasurement.durationMs,
      });
    }
    const tableName = `${config.tableNamePrefix}-${Date.now()}`;
    const prepareMeasurement = await measureAsync("prepareFieldCreate", () =>
      buildFieldCreateFixture(
        perfCase,
        context,
        baseId,
        tableName,
        config,
        seedCacheInfo,
      ),
    );
    return Object.assign(prepareMeasurement.result, {
      prepareName: prepareMeasurement.name,
      prepareDurationMs: prepareMeasurement.durationMs,
    });
  },
  assertSeedReady: ({ fixture, config }) => assertSeedReady(fixture, config),
  runPrimary: async ({ perfCase, context, baseId, fixture, config }) => {
    const fieldsToCreate = await buildCreateFieldsForTable(fixture, config);
    const primaryMeasurement = await runFieldCreatePrimary(
      perfCase,
      context,
      fixture,
      config,
      fieldsToCreate,
    );
    let readyMeasurement:
      | Measurement<Awaited<ReturnType<typeof waitForComputedFieldsReady>>>
      | undefined;
    if (config.ready) {
      readyMeasurement = await measureAsync(config.ready.metric, () =>
        waitForComputedFieldsReady(
          baseId,
          context,
          fixture,
          config,
          primaryMeasurement.result,
        ),
      );
    }
    const verification = await verifyCreatedFields(
      fixture,
      config,
      fieldsToCreate,
    );
    verification.emptyCreatedValues = await verifyCreatedFieldValuesEmpty(
      fixture,
      config,
      primaryMeasurement.result.fields,
    );
    return { primaryMeasurement, readyMeasurement, verification };
  },
  buildResult: ({ config, fixture, seedReadyMeasurement, primary, error }) => {
    const prepareMeasurement = fixture
      ? {
          name: fixture.prepareName,
          durationMs: fixture.prepareDurationMs,
          result: fixture,
        }
      : undefined;
    return buildFieldCreateResult({
      config,
      prepareMeasurement,
      seedReadyMeasurement,
      primaryMeasurement: primary?.primaryMeasurement,
      readyMeasurement: primary?.readyMeasurement,
      verification: primary?.verification,
      error,
    });
  },
  cleanup: async ({ baseId, fixture, config }) => {
    if (!fixture || (isExecuteDbIsolated() && !config.seedIdentity)) {
      return;
    }
    if (fixture.reusableSeed) {
      // Restore the reusable seed by deleting the created (non-base) fields —
      // the same "base fields only" invariant assertSeedReady enforces before
      // the measured create. Re-resolve by name; idempotent, and a no-op when
      // the create made nothing.
      try {
        const baseFieldNames = new Set(
          config.baseFields.map((field) => field.name),
        );
        const fields = (await getFields(fixture.tableId)) as Array<{
          id: string;
          name: string;
        }>;
        for (const field of fields) {
          if (!baseFieldNames.has(field.name)) {
            await deleteField(fixture.tableId, field.id);
          }
        }
      } catch (error) {
        console.warn(
          `Failed to cleanup perf field create fields on ${fixture.tableId}`,
          error,
        );
      }
      return;
    }
    try {
      await permanentDeleteTable(baseId, fixture.tableId);
    } catch (error) {
      console.warn(
        `Failed to cleanup perf field create table ${fixture.tableId}`,
        error,
      );
    }
  },
};

export const seedFieldCreateCase = (
  perfCase: PerfCaseFor<"field-create">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedFieldAddLifecycle(perfCase, context, fieldCreateFieldAddSpec);

export const runFieldCreateCase = (
  perfCase: PerfCaseFor<"field-create">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runFieldAddLifecycle(perfCase, context, fieldCreateFieldAddSpec);
