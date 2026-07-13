import { FieldKeyType, FieldType, Relationship } from "@teable/core";
import {
  axios,
  createField,
  updateRecords,
  updateTableDescription,
} from "@teable/openapi";
import {
  createRecords,
  createTable,
  getFields,
  getRecords,
  getTable,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { chunk } from "../chunk";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { forEachRecordPage } from "../record-page-scan";
import { type Measurement, measureAsync, roundMetric } from "../metrics";
import {
  assertEngineRouting,
  getRoutingResponseHeader,
  type EngineRouting,
} from "../routing";
import {
  buildSeedCacheInfo,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { withPerfTraceStep } from "../trace-collector";
import type {
  DuplicateTableCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  runDuplicateLifecycle,
  seedDuplicateLifecycle,
  type DuplicateLifecycleSpec,
} from "./duplicate-lifecycle";

type NamedField = {
  id: string;
  name: string;
  type?: FieldType;
  options?: unknown;
};

type DuplicateField = DuplicateTableCaseConfig["fields"][number] & {
  id: string;
  name: string;
};

type FormulaField = NonNullable<
  DuplicateTableCaseConfig["formulas"]
>[number] & {
  id: string;
};

type ExpectedCellValue = string | number | boolean | string[] | null;

type DuplicateTableFixture = {
  tableId: string;
  tableName: string;
  viewId: string;
  fields: DuplicateField[];
  formulas: FormulaField[];
  projection: string[];
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
};

type DuplicateTableResponse = {
  status: number;
  data: {
    id: string;
    name: string;
    viewMap?: Record<string, string>;
    fieldMap?: Record<string, string>;
  };
  headers: Record<string, unknown>;
};

type DuplicateTablePrimaryResult = {
  duplicateRequestMs: number;
  duplicateStatus: number;
  duplicateTableId: string;
  duplicateTableName: string;
  fieldMap: Record<string, string>;
  viewMap: Record<string, string>;
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
  duplicatedFormulaFields: Array<{ id: string; name: string }>;
  verifiedRows: Awaited<ReturnType<typeof waitForDuplicatedRows>>;
};

const DUPLICATE_TABLE_FIXTURE_VERSION = "duplicate-table-v2-self-link";
const DUPLICATE_TABLE_METADATA_PREFIX = "perf-lab-duplicate-table:";

const STATUS_CHOICES = ["Todo", "Doing", "Done"];
const PRIORITY_CHOICES = ["P0", "P1", "P2"];
const TAG_CHOICES = ["Alpha", "Beta", "Gamma", "Delta"];
const CATEGORY_CHOICES = ["A", "B", "C"];
const LABEL_CHOICES = ["Red", "Blue", "Green"];

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const fieldNameKey = (fieldName: string) => fieldName.replace(/\s+/g, "-");

const dateIsoForRow = (rowNumber: number, offsetDays = 0) => {
  const date = new Date(
    Date.UTC(2026, 0, 1 + offsetDays + ((rowNumber - 1) % 365)),
  );
  return date.toISOString().slice(0, 10) + "T00:00:00.000Z";
};

const selectChoices = (field: DuplicateTableCaseConfig["fields"][number]) =>
  (
    field.options as
      | {
          choices?: Array<{ name: string }>;
        }
      | undefined
  )?.choices ?? [];

const ratingMax = (field: DuplicateTableCaseConfig["fields"][number]) =>
  (
    field.options as
      | {
          max?: number;
        }
      | undefined
  )?.max ?? 5;

const getSelectChoice = (
  field: DuplicateTableCaseConfig["fields"][number],
  rowNumber: number,
) => {
  const choices = selectChoices(field);
  if (choices.length === 0) {
    throw new Error(`Select field ${field.name} has no choices`);
  }
  return choices[(rowNumber - 1) % choices.length].name;
};

const getMultiSelectChoices = (
  field: DuplicateTableCaseConfig["fields"][number],
  rowNumber: number,
) => {
  const choices = selectChoices(field);
  if (choices.length === 0) {
    throw new Error(`Multiple select field ${field.name} has no choices`);
  }
  const first = choices[(rowNumber - 1) % choices.length].name;
  const second = choices[rowNumber % choices.length].name;
  return first === second ? [first] : [first, second];
};

const getExpectedValue = (
  field: DuplicateTableCaseConfig["fields"][number],
  rowNumber: number,
  config: DuplicateTableCaseConfig,
): ExpectedCellValue => {
  const padded = padRowNumber(rowNumber);

  switch (field.name) {
    case "Title":
      return `${config.generator.titlePrefix} ${padded}`;
    case "Description":
    case "Notes":
    case "Comment":
      return `${config.generator.payloadPrefix}-${padded}-${fieldNameKey(
        field.name,
      )}-payload`;
    case "Owner Text":
    case "External ID":
    case "Source":
      return `${config.generator.valuePrefix}-${padded}-${fieldNameKey(
        field.name,
      )}`;
    case "URL":
      return `https://example.com/perf/${padded}`;
    case "Email":
      return `perf-${padded}@example.com`;
  }

  switch (field.type) {
    case FieldType.SingleSelect:
      return getSelectChoice(field, rowNumber);
    case FieldType.MultipleSelect:
      return getMultiSelectChoices(field, rowNumber);
    case FieldType.Number:
      if (field.name === "Amount") {
        return Number((rowNumber * 7 + 0.25).toFixed(2));
      }
      if (field.name === "Quantity") {
        return rowNumber * 3;
      }
      if (field.name === "Percent") {
        return Number(((rowNumber % 100) / 100).toFixed(2));
      }
      return rowNumber;
    case FieldType.Date:
      return dateIsoForRow(
        rowNumber,
        field.name.toLowerCase().includes("due") ? 7 : 0,
      );
    case FieldType.Checkbox:
      return rowNumber % 2 === 1 ? true : null;
    case FieldType.Rating:
      return ((rowNumber - 1) % ratingMax(field)) + 1;
    default:
      return `${config.generator.valuePrefix}-${padded}-${fieldNameKey(
        field.name,
      )}`;
  }
};

const getFormulaExpectedValue = (
  formula: FormulaField,
  rowNumber: number,
): number => {
  const amount = Number((rowNumber * 7 + 0.25).toFixed(2));
  const quantity = rowNumber * 3;
  const percent = Number(((rowNumber % 100) / 100).toFixed(2));

  switch (formula.expected) {
    case "amountTimesQuantity":
      return amount * quantity;
    case "amountPlusQuantity":
      return amount + quantity;
    case "percentTimes100":
      return percent * 100;
    case "quantityPlusPercent":
      return quantity + percent;
    case "amountTimesPercent":
      return amount * percent;
  }
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildRecords = (
  fields: DuplicateField[],
  config: DuplicateTableCaseConfig,
) =>
  Array.from({ length: config.rowCount }, (_, index) => {
    const rowNumber = index + 1;
    return {
      fields: Object.fromEntries(
        fields.map((field) => [
          field.name,
          getExpectedValue(field, rowNumber, config),
        ]),
      ),
    };
  });

const normalizeMultiSelectValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
};

const valuesMatch = (
  expectedValue: ExpectedCellValue,
  actualValue: unknown,
  field: DuplicateField,
) => {
  if (expectedValue == null) {
    return actualValue == null;
  }

  if (Array.isArray(expectedValue)) {
    return (
      JSON.stringify(normalizeMultiSelectValue(actualValue)) ===
      JSON.stringify(expectedValue)
    );
  }

  if (typeof expectedValue === "number") {
    return Number(actualValue) === expectedValue;
  }

  if (typeof expectedValue === "boolean") {
    return actualValue === expectedValue;
  }

  if (field.type === FieldType.Date) {
    return (
      typeof actualValue === "string" &&
      new Date(actualValue).toISOString() === expectedValue
    );
  }

  return actualValue === expectedValue;
};

const formulaValuesMatch = (expectedValue: number, actualValue: unknown) =>
  Math.abs(Number(actualValue) - expectedValue) < 0.000001;

const resolveFields = (
  tableFields: NamedField[],
  config: DuplicateTableCaseConfig,
): DuplicateField[] => {
  const fieldByName = new Map(tableFields.map((field) => [field.name, field]));
  return config.fields.map((field) => {
    const resolvedField = fieldByName.get(field.name);
    if (!resolvedField) {
      throw new Error(
        `Missing duplicate table source field ${field.name}; available fields: ${tableFields
          .map(({ name }) => name)
          .join(", ")}`,
      );
    }
    return {
      ...field,
      id: resolvedField.id,
      name: resolvedField.name,
      options: resolvedField.options ?? field.options,
    };
  });
};

const resolveFormulas = (
  tableFields: NamedField[],
  config: DuplicateTableCaseConfig,
): FormulaField[] => {
  const fieldByName = new Map(tableFields.map((field) => [field.name, field]));
  return (config.formulas ?? []).map((formula) => {
    const resolvedField = fieldByName.get(formula.name);
    if (!resolvedField) {
      throw new Error(
        `Missing duplicate table formula field ${formula.name}; available fields: ${tableFields
          .map(({ name }) => name)
          .join(", ")}`,
      );
    }
    return {
      ...formula,
      id: resolvedField.id,
    };
  });
};

const compileFormulaExpression = (
  expression: string,
  fields: DuplicateField[],
) =>
  expression.replace(/\{([^}]+)\}/g, (match, fieldName: string) => {
    const field = fields.find((candidate) => candidate.name === fieldName);
    if (!field) {
      throw new Error(`Unknown field in formula expression: ${fieldName}`);
    }
    return `{${field.id}}`;
  });

const seedSelfLinkIfConfigured = async (
  tableId: string,
  fields: DuplicateField[],
  config: DuplicateTableCaseConfig,
) => {
  if (!config.selfLink) {
    return;
  }
  const primary = fields.find((field) => field.name === "Title") ?? fields[0];
  if (!primary) {
    throw new Error("selfLink seed requires at least one field");
  }
  const createResponse = await createField(tableId, {
    name: config.selfLink.name,
    type: FieldType.Link,
    options: {
      relationship: Relationship.ManyMany,
      foreignTableId: tableId,
      lookupFieldId: primary.id,
      isOneWay: config.selfLink.isOneWay ?? false,
    },
  });
  if (createResponse.status !== 201) {
    throw new Error(
      `Failed to create self link field: status ${createResponse.status}`,
    );
  }
  const tableFields = await getFields(tableId);
  const linkField = tableFields.find(
    (field) => field.name === config.selfLink!.name,
  );
  if (!linkField) {
    throw new Error(
      `Self link field ${config.selfLink.name} missing after create`,
    );
  }

  // Fetch all record ids in stable order, then link i -> i+1.
  const recordIds: string[] = [];
  await forEachRecordPage(
    {
      totalRows: config.rowCount,
      pageSize: config.batchSize,
      fetchPage: (skip, take) =>
        getRecords(tableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: [primary.id],
          skip,
          take,
        }),
      pageNoun: "self-link seed records",
    },
    (record) => {
      recordIds.push(record.id);
    },
  );

  // Link updates are much heavier than plain cell writes (junction + optional
  // symmetric field). Cap density and keep batches small so CI seed stays under
  // Prisma interactive-transaction timeout (30s) and case timeout.
  const maxLinks = Math.min(
    config.selfLink.maxLinks ?? recordIds.length,
    recordIds.length,
  );
  const linkBatchSize = Math.min(config.selfLink.batchSize ?? 50, 100);
  const linkUpdates = recordIds.slice(0, maxLinks).map((recordId, index) => ({
    id: recordId,
    fields: {
      [linkField.id]: [{ id: recordIds[(index + 1) % recordIds.length] }],
    },
  }));
  for (const batch of chunk(linkUpdates, linkBatchSize)) {
    const response = await updateRecords(tableId, {
      fieldKeyType: FieldKeyType.Id,
      typecast: false,
      records: batch,
    });
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(
        `Failed to seed self-link values: status ${response.status}`,
      );
    }
  }
};

const createFormulaFields = async (
  tableId: string,
  fields: DuplicateField[],
  config: DuplicateTableCaseConfig,
) => {
  for (const formula of config.formulas ?? []) {
    const response = await createField(tableId, {
      name: formula.name,
      type: FieldType.Formula,
      options: {
        expression: compileFormulaExpression(formula.expression, fields),
      },
    });
    expect(response.status).toBe(201);
  }
};

const assertRow = (
  rowNumber: number,
  fields: DuplicateField[],
  formulas: FormulaField[],
  recordFields: Record<string, unknown>,
  config: DuplicateTableCaseConfig,
) => {
  const actual: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};

  for (const field of fields) {
    const expectedValue = getExpectedValue(field, rowNumber, config);
    const actualValue = recordFields[field.id];
    actual[field.name] = actualValue;
    expected[field.name] = expectedValue;

    if (!valuesMatch(expectedValue, actualValue, field)) {
      throw new Error(
        `Row ${rowNumber} ${field.name} mismatch: expected ${String(
          expectedValue,
        )}, actual ${String(actualValue)}`,
      );
    }
  }

  for (const formula of formulas) {
    const expectedValue = getFormulaExpectedValue(formula, rowNumber);
    const actualValue = recordFields[formula.id];
    actual[formula.name] = actualValue;
    expected[formula.name] = expectedValue;

    if (!formulaValuesMatch(expectedValue, actualValue)) {
      throw new Error(
        `Row ${rowNumber} ${formula.name} mismatch: expected ${String(
          expectedValue,
        )}, actual ${String(actualValue)}`,
      );
    }
  }

  return { actual, expected };
};

const assertDuplicatedRows = async (
  duplicateTableId: string,
  viewId: string,
  fields: DuplicateField[],
  formulas: FormulaField[],
  config: DuplicateTableCaseConfig,
  options: { verifyFormulaValues: boolean },
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleRowOffsets = new Set(config.verify.sampleRows);
  const verifiedFormulas = options.verifyFormulaValues ? formulas : [];
  const projection = [...fields, ...verifiedFormulas].map((field) => field.id);
  const verifiedSamples = [];
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.rowCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(duplicateTableId, {
          viewId,
          fieldKeyType: FieldKeyType.Id,
          projection,
          skip,
          take,
        }),
      pageNoun: "duplicated records",
    },
    (record, rowNumber) => {
      const verifiedRow = assertRow(
        rowNumber,
        fields,
        verifiedFormulas,
        record.fields,
        config,
      );
      const rowOffset = rowNumber - 1;

      if (sampleRowOffsets.has(rowOffset)) {
        verifiedSamples.push({
          rowOffset,
          rowNumber,
          recordId: record.id,
          ...verifiedRow,
        });
      }
    },
  );

  if (scannedRecords !== config.rowCount) {
    throw new Error(
      `Duplicated row count mismatch: expected ${config.rowCount}, scanned ${scannedRecords}`,
    );
  }

  return {
    scannedRecords,
    pageSize,
    pageCount,
    formulaValueVerification: options.verifyFormulaValues
      ? "verified"
      : "skipped",
    verifiedSamples: verifiedSamples.sort(
      (left, right) => left.rowOffset - right.rowOffset,
    ),
  };
};

const waitForDuplicatedRows = async (
  duplicateTableId: string,
  viewId: string,
  fields: DuplicateField[],
  formulas: FormulaField[],
  config: DuplicateTableCaseConfig,
  options: { verifyFormulaValues: boolean },
) => {
  const timeoutMs = config.verify.timeoutMs ?? 120_000;
  const pollIntervalMs = config.verify.pollIntervalMs ?? 2_000;
  const startedAt = Date.now();
  let attempts = 0;
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    try {
      const verifiedRows = await assertDuplicatedRows(
        duplicateTableId,
        viewId,
        fields,
        formulas,
        config,
        options,
      );
      return {
        ...verifiedRows,
        attempts,
        waitedMs: Date.now() - startedAt,
      };
    } catch (error) {
      lastError = error;
      if (Date.now() - startedAt > timeoutMs) {
        break;
      }
      await delay(pollIntervalMs);
    }
  }

  throw new Error(
    `Duplicated rows did not become ready within ${timeoutMs}ms after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

const pickResponseHeaders = (headers: Record<string, unknown>) => ({
  "x-teable-v2": getRoutingResponseHeader(headers, "x-teable-v2"),
  "x-teable-v2-feature": getRoutingResponseHeader(
    headers,
    "x-teable-v2-feature",
  ),
  "x-teable-v2-reason": getRoutingResponseHeader(headers, "x-teable-v2-reason"),
  traceparent: getRoutingResponseHeader(headers, "traceparent"),
});

const parseMetadata = (description: string | null | undefined) => {
  if (!description?.startsWith(DUPLICATE_TABLE_METADATA_PREFIX)) {
    return;
  }
  try {
    return JSON.parse(
      description.slice(DUPLICATE_TABLE_METADATA_PREFIX.length),
    );
  } catch {
    return;
  }
};

const persistMetadata = async (
  baseId: string,
  tableId: string,
  metadata: Record<string, unknown>,
) => {
  await updateTableDescription(baseId, tableId, {
    description: `${DUPLICATE_TABLE_METADATA_PREFIX}${JSON.stringify(
      metadata,
    )}`,
  });
};

const buildBaseFixture = async (
  baseId: string,
  tableId: string,
  tableName: string,
  config: DuplicateTableCaseConfig,
) => {
  const tableFields = await getFields(tableId);
  const views = await getViews(tableId);
  const viewId = views[0]?.id;
  if (!viewId) {
    throw new Error(`No grid view found for duplicate table source ${tableId}`);
  }

  const fields = resolveFields(tableFields, config);
  const formulas = resolveFormulas(tableFields, config);

  return {
    tableId,
    tableName,
    viewId,
    fields,
    formulas,
    projection: [...fields, ...formulas].map((field) => field.id),
  };
};

const getDuplicateTableSeedConfig = (config: DuplicateTableCaseConfig) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  fields: config.fields,
  formulas: config.formulas,
  selfLink: config.selfLink,
  generator: config.generator,
  fixtureVersion: DUPLICATE_TABLE_FIXTURE_VERSION,
});

const assertSeedReady = async (
  fixture: Pick<
    DuplicateTableFixture,
    "tableId" | "viewId" | "fields" | "formulas"
  >,
  config: DuplicateTableCaseConfig,
) => {
  const verified = await assertDuplicatedRows(
    fixture.tableId,
    fixture.viewId,
    fixture.fields,
    fixture.formulas,
    config,
    { verifyFormulaValues: true },
  );
  return {
    scannedRecords: verified.scannedRecords,
    pageSize: verified.pageSize,
    pageCount: verified.pageCount,
  };
};

const prepareDuplicateTableFixture = async (
  baseId: string,
  tableName: string,
  config: DuplicateTableCaseConfig,
  perfCase: PerfCase,
): Promise<DuplicateTableFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "duplicate-table",
    fixtureVersion: DUPLICATE_TABLE_FIXTURE_VERSION,
    seedConfig: getDuplicateTableSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
  const cachedTable =
    seedCacheInfo.enabled &&
    (await findSeedTable(baseId, seedCacheInfo.seedTableName));

  if (cachedTable) {
    try {
      const tableMeta = await getTable(baseId, cachedTable.id);
      const metadata = parseMetadata(tableMeta.description);
      if (
        !metadata ||
        metadata.fixtureVersion !== DUPLICATE_TABLE_FIXTURE_VERSION ||
        metadata.rowCount !== config.rowCount
      ) {
        throw new Error("Cached duplicate table metadata mismatch");
      }
      const fixture = await buildBaseFixture(
        baseId,
        cachedTable.id,
        cachedTable.name,
        config,
      );
      await assertSeedReady(fixture, config);
      return {
        ...fixture,
        seedCacheInfo,
        seedCacheHit: true,
        reusableSeed: true,
      };
    } catch (error) {
      console.warn(
        `Invalid cached duplicate table seed ${seedCacheInfo.seedTableName}; rebuilding`,
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
    const table = await createTable(baseId, {
      name: actualTableName,
      fields: config.fields,
      records: [],
    });
    createdTableId = table.id;
    let tableFields = await getFields(table.id);
    let fields = resolveFields(tableFields, config);
    const records = buildRecords(fields, config);

    for (const batch of chunk(records, config.batchSize)) {
      await createRecords(table.id, {
        fieldKeyType: FieldKeyType.Name,
        typecast: false,
        records: batch,
      });
    }

    await createFormulaFields(table.id, fields, config);
    await seedSelfLinkIfConfigured(table.id, fields, config);
    tableFields = await getFields(table.id);
    fields = resolveFields(tableFields, config);
    const formulas = resolveFormulas(tableFields, config);
    const fixture = {
      tableId: table.id,
      tableName: actualTableName,
      viewId: (await getViews(table.id))[0]?.id,
      fields,
      formulas,
      projection: [...fields, ...formulas].map((field) => field.id),
    };
    if (!fixture.viewId) {
      throw new Error(
        `No grid view found for duplicate table source ${table.id}`,
      );
    }

    await assertSeedReady(fixture, config);
    await persistMetadata(baseId, table.id, {
      fixtureVersion: DUPLICATE_TABLE_FIXTURE_VERSION,
      rowCount: config.rowCount,
      fieldCount: config.fields.length,
      formulaCount: config.formulas?.length ?? 0,
    });

    return {
      ...fixture,
      viewId: fixture.viewId,
      seedCacheInfo,
      seedCacheHit: false,
      reusableSeed: seedCacheInfo.enabled,
    };
  } catch (error) {
    if (createdTableId) {
      try {
        await permanentDeleteTable(baseId, createdTableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup incomplete duplicate table seed ${createdTableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const resolveDuplicatedFields = async (
  duplicateTableId: string,
  sourceFields: DuplicateField[],
  sourceFormulas: FormulaField[],
  fieldMap: Record<string, string>,
) => {
  const duplicatedTableFields = await getFields(duplicateTableId);
  const fieldById = new Map(
    duplicatedTableFields.map((field) => [field.id, field]),
  );

  const fields = sourceFields.map((field) => {
    const duplicatedFieldId = fieldMap[field.id];
    const duplicatedField = duplicatedFieldId
      ? fieldById.get(duplicatedFieldId)
      : duplicatedTableFields.find(
          (candidate) => candidate.name === field.name,
        );
    if (!duplicatedField) {
      throw new Error(
        `Missing duplicated field for source field ${field.name}`,
      );
    }
    return {
      ...field,
      id: duplicatedField.id,
      name: duplicatedField.name,
    };
  });

  const formulas = sourceFormulas.map((formula) => {
    const duplicatedFieldId = fieldMap[formula.id];
    const duplicatedField = duplicatedFieldId
      ? fieldById.get(duplicatedFieldId)
      : duplicatedTableFields.find(
          (candidate) => candidate.name === formula.name,
        );
    if (!duplicatedField) {
      throw new Error(
        `Missing duplicated formula for source field ${formula.name}`,
      );
    }
    return {
      ...formula,
      id: duplicatedField.id,
    };
  });

  return { fields, formulas };
};

const duplicateTableAndVerify = async (
  context: PerfRunContext,
  baseId: string,
  fixture: DuplicateTableFixture,
  config: DuplicateTableCaseConfig,
) => {
  const duplicateName = `${config.duplicate.namePrefix}-${Date.now()}`;
  const duplicateMeasurement = await measureAsync(
    "duplicateRequest",
    async () => {
      const response = (await axios.post(
        `/base/${baseId}/table/${fixture.tableId}/duplicate`,
        {
          name: duplicateName,
          includeRecords: config.duplicate.includeRecords,
        },
      )) as DuplicateTableResponse;
      expect([200, 201]).toContain(response.status);
      return response;
    },
  );
  const responseHeaders = pickResponseHeaders(
    duplicateMeasurement.result.headers,
  );
  const routing = assertEngineRouting(context, responseHeaders, {
    feature: "duplicateTable",
    operation: "duplicateTable",
  });

  const duplicateTableId = duplicateMeasurement.result.data.id;
  const fieldMap = duplicateMeasurement.result.data.fieldMap ?? {};
  const viewMap = duplicateMeasurement.result.data.viewMap ?? {};
  const duplicatedViewId =
    viewMap[fixture.viewId] ?? (await getViews(duplicateTableId))[0]?.id;
  if (!duplicatedViewId) {
    throw new Error(
      `No grid view found for duplicated table ${duplicateTableId}`,
    );
  }

  const duplicatedFields = await resolveDuplicatedFields(
    duplicateTableId,
    fixture.fields,
    fixture.formulas,
    fieldMap,
  );
  const verifiedRows = await waitForDuplicatedRows(
    duplicateTableId,
    duplicatedViewId,
    duplicatedFields.fields,
    duplicatedFields.formulas,
    config,
    { verifyFormulaValues: false },
  );

  return {
    duplicateRequestMs: duplicateMeasurement.durationMs,
    duplicateStatus: duplicateMeasurement.result.status,
    duplicateTableId,
    duplicateTableName: duplicateMeasurement.result.data.name,
    fieldMap,
    viewMap,
    responseHeaders,
    routing,
    duplicatedFormulaFields: duplicatedFields.formulas.map((formula) => ({
      id: formula.id,
      name: formula.name,
    })),
    verifiedRows,
  };
};

const buildDuplicateTableCaseResult = ({
  config,
  prepareMeasurement,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  config: DuplicateTableCaseConfig;
  prepareMeasurement?: Measurement<DuplicateTableFixture>;
  seedReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertSeedReady>>
  >;
  primaryMeasurement?: Measurement<DuplicateTablePrimaryResult>;
  error?: unknown;
}): PerfRunResult => {
  const fixture = prepareMeasurement?.result;
  const primaryResult = primaryMeasurement?.result;

  return {
    metrics: {
      ...(prepareMeasurement
        ? { duplicateTablePrepareMs: prepareMeasurement.durationMs }
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
        ? {
            duplicateTableRequestMs: primaryResult?.duplicateRequestMs ?? 0,
            duplicateTableFullScanReadyMs: primaryResult
              ? roundMetric(
                  primaryMeasurement.durationMs -
                    primaryResult.duplicateRequestMs,
                )
              : 0,
            duplicateTableTotalReadyMs: primaryMeasurement.durationMs,
          }
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
              name: "duplicateTableRequest",
              durationMs: primaryResult?.duplicateRequestMs ?? 0,
            },
            {
              name: "duplicateTableFullScanReady",
              durationMs: primaryResult
                ? roundMetric(
                    primaryMeasurement.durationMs -
                      primaryResult.duplicateRequestMs,
                  )
                : 0,
            },
            {
              name: "duplicateTableTotalReady",
              durationMs: primaryMeasurement.durationMs,
            },
          ]
        : []),
    ],
    details: {
      routing: primaryResult?.routing,
      tableId: fixture?.tableId,
      tableName: fixture?.tableName,
      viewId: fixture?.viewId,
      rowCount: config.rowCount,
      fieldCount: config.fields.length,
      formulaCount: config.formulas?.length ?? 0,
      sourceFields: fixture?.fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
      })),
      sourceFormulas: fixture?.formulas.map((formula) => ({
        id: formula.id,
        name: formula.name,
        expression: formula.expression,
      })),
      prepare: fixture
        ? {
            durationMs: prepareMeasurement.durationMs,
            tableShape: `${config.rowCount} rows, ${config.fields.length} stored fields, ${config.formulas?.length ?? 0} formula fields`,
            createdBeforeMetric: true,
            seedReady: seedReadyMeasurement?.result,
            cache: {
              enabled: fixture.seedCacheInfo.enabled,
              cacheHit: Boolean(fixture.seedCacheHit),
              reusable: Boolean(fixture.reusableSeed),
              seedHash: fixture.seedCacheInfo.seedHash,
              seedHashShort: fixture.seedCacheInfo.seedHashShort,
              seedTableName: fixture.seedCacheInfo.seedTableName,
              schemaSignature: fixture.seedCacheInfo.schemaSignature,
            },
          }
        : undefined,
      duplicate: primaryResult
        ? {
            status: primaryResult.duplicateStatus,
            requestMs: primaryResult.duplicateRequestMs,
            tableId: primaryResult.duplicateTableId,
            tableName: primaryResult.duplicateTableName,
            includeRecords: config.duplicate.includeRecords,
            fieldMapCount: Object.keys(primaryResult.fieldMap).length,
            viewMapCount: Object.keys(primaryResult.viewMap).length,
            formulaFieldCount: primaryResult.duplicatedFormulaFields.length,
            duplicatedFormulaFields: primaryResult.duplicatedFormulaFields,
            formulaValueVerification:
              primaryResult.verifiedRows.formulaValueVerification,
            requestOnlyPrimaryMetric: true,
            responseHeaders: primaryResult.responseHeaders,
            routing: primaryResult.routing,
          }
        : undefined,
      fullScan: primaryResult
        ? {
            scannedRecords: primaryResult.verifiedRows.scannedRecords,
            pageSize: primaryResult.verifiedRows.pageSize,
            pageCount: primaryResult.verifiedRows.pageCount,
            attempts: primaryResult.verifiedRows.attempts,
            waitedMs: primaryResult.verifiedRows.waitedMs,
            formulaValueVerification:
              primaryResult.verifiedRows.formulaValueVerification,
          }
        : undefined,
      verifiedSamples: primaryResult?.verifiedRows.verifiedSamples,
      verification: primaryResult
        ? {
            durationMs: roundMetric(
              primaryMeasurement.durationMs - primaryResult.duplicateRequestMs,
            ),
            scannedRecords: primaryResult.verifiedRows.scannedRecords,
            metric: "duplicateTableFullScanReadyMs",
            participatesInThreshold: false,
          }
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

type DuplicateTableLifecycleFixture = DuplicateTableFixture & {
  // Parked by prepareFixture (the driver emits no "prepare" phase); buildResult
  // rebuilds the prepare measurement from this.
  prepareDurationMs: number;
  // Parked by runPrimary once the duplicate request returns, so cleanup can drop
  // the created copy even if the copy-readiness scan throws afterwards.
  duplicateTableId?: string;
};

// duplicate-table is the first member of the duplicate lifecycle: seed (or
// restore) a populated source table, assert it is fully readable, run the single
// measured duplicate request and wait for the copy's rows to be readable, then
// drop the copy (and the source unless it is a reusable cached seed). Its prepare
// carries its own "prepare" measurement (so the driver emits no "prepare" phase),
// and its primary is the trace-wrapped duplicateTableTotalReady measurement whose
// request/full-scan split feeds the computed metrics — all expressed in the spec,
// so the new driver is born minimal and family-shaped (duplicate-base joins next).
const duplicateTableSpec: DuplicateLifecycleSpec<
  DuplicateTableCaseConfig,
  DuplicateTableLifecycleFixture,
  Awaited<ReturnType<typeof assertSeedReady>>,
  Measurement<DuplicateTablePrimaryResult>
> = {
  prepareFixture: async ({ baseId, config, perfCase, seedMode }) => {
    const tableName = seedMode
      ? `${config.sourceTableNamePrefix}-seed-${Date.now()}`
      : `${config.sourceTableNamePrefix}-${Date.now()}`;
    const prepareMeasurement = await measureAsync("prepare", () =>
      prepareDuplicateTableFixture(baseId, tableName, config, perfCase),
    );
    return Object.assign(prepareMeasurement.result, {
      prepareDurationMs: prepareMeasurement.durationMs,
    });
  },
  assertSeedReady: ({ fixture, config }) => assertSeedReady(fixture, config),
  runPrimary: async ({ perfCase, context, baseId, fixture, config }) => {
    const primaryMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      config.threshold.metric,
      () =>
        measureAsync("duplicateTableTotalReady", () =>
          duplicateTableAndVerify(context, baseId, fixture, config),
        ),
    );
    fixture.duplicateTableId = primaryMeasurement.result.duplicateTableId;
    return primaryMeasurement;
  },
  buildResult: ({ config, fixture, seedReadyMeasurement, primary, error }) => {
    const prepareMeasurement = fixture
      ? {
          name: "prepare",
          durationMs: fixture.prepareDurationMs,
          result: fixture,
        }
      : undefined;
    return buildDuplicateTableCaseResult({
      config,
      prepareMeasurement,
      seedReadyMeasurement,
      primaryMeasurement: primary,
      error,
    });
  },
  cleanup: async ({ baseId, fixture }) => {
    if (isExecuteDbIsolated() || !fixture) {
      return;
    }
    if (fixture.duplicateTableId) {
      try {
        await permanentDeleteTable(baseId, fixture.duplicateTableId);
      } catch (error) {
        console.warn(
          `Failed to cleanup duplicated perf table ${fixture.duplicateTableId}`,
          error,
        );
      }
    }
    if (fixture.tableId && !fixture.reusableSeed) {
      try {
        await permanentDeleteTable(baseId, fixture.tableId);
      } catch (error) {
        console.warn(`Failed to cleanup perf table ${fixture.tableId}`, error);
      }
    }
  },
};

export const runDuplicateTableCase = (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runDuplicateLifecycle(perfCase, context, duplicateTableSpec);

export const seedDuplicateTableCase = (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedDuplicateLifecycle(perfCase, context, duplicateTableSpec);
