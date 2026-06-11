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
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync } from "../metrics";
import {
  buildSeedCacheInfo,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { queryPerfDb } from "../sql";
import { withPerfTraceStep } from "../trace-collector";
import type {
  FieldCreateCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import { PerfRunDiagnosticError } from "../types";

type Measurement<T> = {
  name: string;
  durationMs: number;
  result: T;
};

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

type FieldCreateRouting = {
  requestedEngine: string;
  expectedXTeableV2: string;
  actualXTeableV2: string;
  routeMatched: boolean;
  xTeableV2Feature: string;
  xTeableV2Reason: string;
};

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const waitForComputedFieldsReady = async (
  baseId: string,
  context: PerfRunContext,
  fixture: FieldCreateFixture,
  config: FieldCreateCaseConfig,
  primaryResult: FieldCreatePrimaryResult,
) => {
  const timeoutMs = config.ready?.timeoutMs ?? 30_000;
  const pollIntervalMs = config.ready?.pollIntervalMs ?? 200;
  const startedAt = Date.now();
  let lastError: unknown;
  let attempts = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    try {
      return await assertComputedBackfillReady(
        baseId,
        context,
        fixture,
        config,
        primaryResult,
        attempts,
      );
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for computed backfill ready after ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const getResponseHeader = (headers: Record<string, unknown>, name: string) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0]) : String(value ?? "");
};

const pickResponseHeaders = (headers: Record<string, unknown>) => ({
  "x-teable-v2": getResponseHeader(headers, "x-teable-v2"),
  "x-teable-v2-feature": getResponseHeader(headers, "x-teable-v2-feature"),
  "x-teable-v2-reason": getResponseHeader(headers, "x-teable-v2-reason"),
  traceparent: getResponseHeader(headers, "traceparent"),
});

const assertExpectedRouting = (
  context: PerfRunContext,
  responseHeaders: Record<string, string>,
) => {
  const expectedXTeableV2 = context.engine === "v2" ? "true" : "false";
  const actualXTeableV2 = responseHeaders["x-teable-v2"];
  if (actualXTeableV2 !== expectedXTeableV2) {
    throw new Error(
      `Field create did not use expected ${context.engine.toUpperCase()} route; expected x-teable-v2=${expectedXTeableV2}, got ${actualXTeableV2}; headers=${JSON.stringify(
        responseHeaders,
      )}`,
    );
  }

  return {
    requestedEngine: context.engine,
    expectedXTeableV2,
    actualXTeableV2,
    routeMatched: true,
    xTeableV2Feature: responseHeaders["x-teable-v2-feature"],
    xTeableV2Reason: responseHeaders["x-teable-v2-reason"],
  };
};

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
    let scannedRecords = 0;
    for (let skip = 0; skip < rowCount; skip += pageSize) {
      const expectedTake = Math.min(pageSize, rowCount - skip);
      const result = await getRecords(fixture.tableId, {
        viewId,
        fieldKeyType: FieldKeyType.Name,
        skip,
        take: expectedTake,
      });
      if (result.records.length !== expectedTake) {
        throw new Error(
          `Expected ${expectedTake} seed records at skip ${skip}, got ${result.records.length}`,
        );
      }
      scannedRecords += result.records.length;
    }
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
    await withPerfTraceStep(
      context,
      perfCase,
      config.threshold.metric,
      async () => {
        for (const field of fieldsToCreate) {
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
        }
      },
    );

    return {
      fieldIds: createdFields.map((field) => field.id),
      fields: createdFields,
    };
  });
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
  tableNamePrefix: config.tableNamePrefix,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  baseFields: config.baseFields,
  generator: config.generator,
});

const buildSeedCache = (perfCase: PerfCase, config: FieldCreateCaseConfig) =>
  buildSeedCacheInfo({
    perfCase,
    runner: "field-create",
    fixtureVersion: FIELD_CREATE_FIXTURE_VERSION,
    seedConfig: getFieldCreateSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });

export const seedFieldCreateCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FieldCreateCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const seedCacheInfo = await buildSeedCache(perfCase, config);
  const fixture = await buildFieldCreateFixture(
    perfCase,
    context,
    baseId,
    tableName,
    config,
    seedCacheInfo,
  );
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    assertSeedReady(fixture, config),
  );

  return buildFieldCreateResult({
    config,
    prepareMeasurement: {
      name: fixture.seedCacheHit ? "seedRestore" : "seedBuild",
      durationMs: 0,
      result: fixture,
    },
    seedReadyMeasurement,
  });
};

export const runFieldCreateCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FieldCreateCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const seedCacheInfo = await buildSeedCache(perfCase, config);
  let fixture: FieldCreateFixture | undefined;
  let createdFieldIds: string[] = [];
  let prepareMeasurement: Measurement<FieldCreateFixture> | undefined;
  let seedReadyMeasurement:
    | Measurement<Awaited<ReturnType<typeof assertSeedReady>>>
    | undefined;
  let primaryMeasurement: Measurement<FieldCreatePrimaryResult> | undefined;
  let readyMeasurement:
    | Measurement<Awaited<ReturnType<typeof waitForComputedFieldsReady>>>
    | undefined;
  let verification: FieldCreateVerification | undefined;

  try {
    prepareMeasurement = await measureAsync("prepareFieldCreate", () =>
      buildFieldCreateFixture(
        perfCase,
        context,
        baseId,
        tableName,
        config,
        seedCacheInfo,
      ),
    );
    fixture = prepareMeasurement.result;
    seedReadyMeasurement = await measureAsync("seedReady", () =>
      assertSeedReady(prepareMeasurement.result, config),
    );
    const fieldsToCreate = await buildCreateFieldsForTable(
      prepareMeasurement.result,
      config,
    );
    primaryMeasurement = await runFieldCreatePrimary(
      perfCase,
      context,
      prepareMeasurement.result,
      config,
      fieldsToCreate,
    );
    createdFieldIds = primaryMeasurement.result.fieldIds;
    if (config.ready) {
      readyMeasurement = await measureAsync(config.ready.metric, () =>
        waitForComputedFieldsReady(
          baseId,
          context,
          prepareMeasurement.result,
          config,
          primaryMeasurement.result,
        ),
      );
    }
    verification = await verifyCreatedFields(
      prepareMeasurement.result,
      config,
      fieldsToCreate,
    );

    return buildFieldCreateResult({
      config,
      prepareMeasurement,
      seedReadyMeasurement,
      primaryMeasurement,
      readyMeasurement,
      verification,
    });
  } catch (error) {
    throw new PerfRunDiagnosticError(
      error instanceof Error ? error.message : String(error),
      buildFieldCreateResult({
        config,
        prepareMeasurement,
        seedReadyMeasurement,
        primaryMeasurement,
        readyMeasurement,
        verification,
        error,
      }),
    );
  } finally {
    if (fixture?.reusableSeed) {
      if (!isExecuteDbIsolated() && createdFieldIds.length > 0) {
        try {
          for (const fieldId of createdFieldIds) {
            await deleteField(fixture.tableId, fieldId);
          }
        } catch (error) {
          console.warn(
            `Failed to cleanup perf field create fields ${createdFieldIds.join(", ")}`,
            error,
          );
        }
      }
    } else if (fixture?.tableId) {
      try {
        await permanentDeleteTable(baseId, fixture.tableId);
      } catch (error) {
        console.warn(
          `Failed to cleanup perf field create table ${fixture.tableId}`,
          error,
        );
      }
    }
  }
};
