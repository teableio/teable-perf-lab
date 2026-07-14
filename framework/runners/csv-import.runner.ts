import { Buffer } from "node:buffer";
import { FieldKeyType, FieldType } from "@teable/core";
import {
  analyzeFile,
  getImportStatus,
  getSignature,
  inplaceImportTableFromFile,
  importTableFromFile,
  notify,
  SUPPORTEDTYPE,
  UploadType,
  uploadFile,
  updateTableDescription,
} from "@teable/openapi";
import {
  createTable,
  getFields,
  getRecords,
  getTable,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, roundMetric } from "../metrics";
import {
  buildSeedCacheInfo,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { pollUntilReady, sleep } from "../readiness";
import { queryPerfDb } from "../sql";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  CsvImportCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  runCsvImportLifecycle,
  seedCsvImportLifecycle,
  type CsvImportLifecycleSpec,
  type CsvImportMeasurement,
} from "./csv-import-lifecycle";

type Measurement<T> = CsvImportMeasurement<T>;

type CsvField = CsvImportCaseConfig["fields"][number] & {
  id: string;
  name: string;
};

type CsvFixture = {
  tableId: string;
  tableName: string;
  dbTableName: string;
  viewId: string;
  fields: CsvField[];
  csvContent: string;
  attachmentUrl: string;
  sourceColumnMap?: Record<string, number>;
  analyzeColumns: Array<{ name: string; type: string }>;
  attachmentCacheHit?: boolean;
  seedCacheInfo?: SeedCacheInfo;
  seedCacheHit?: boolean;
  reusableSeed?: boolean;
  lastImport?: Omit<CsvImportPrimaryResult, "verifiedRows">;
};

type CsvImportPrimaryResult = {
  importRequestMs: number;
  importCompletedMs?: number;
  importCompletion?: CsvImportCompletion;
  importStatus: number;
  responseHeaders: Record<string, string>;
  verifiedRows: Awaited<ReturnType<typeof assertImportedRows>>;
  createdTableId?: string;
};

type CsvImportCompletion = {
  status: string;
  engine: PerfRunContext["engine"];
  completionSignal: string;
  measuredWindow: string;
  pollCount: number;
  durationMs: number;
  expectedRowCount: number;
  rowCountAtCompletion: number;
  pollIntervalMs?: number;
  message?: string;
};

const IMPORT_SHEET_KEY = "Import Table";
const CSV_FILE_NAME = "csv-import-mixed-case-10k-20fields.csv";

const CSV_IMPORT_FIXTURE_VERSION = "csv-import-v1";

const CSV_IMPORT_METADATA_PREFIX = "perf-lab:csv-import:";

type CachedImportAttachment = {
  fixtureVersion: string;
  attachmentUrl: string;
  analyzeColumns: Array<{ name: string; type: string }>;
};

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const dateOnlyForRow = (rowNumber: number, offsetDays = 0) => {
  const date = new Date(
    Date.UTC(2026, 0, 1 + offsetDays + ((rowNumber - 1) % 365)),
  );
  return date.toISOString().slice(0, 10);
};

const selectChoices = (field: CsvImportCaseConfig["fields"][number]) =>
  (
    field.options as
      | {
          choices?: Array<{ name: string }>;
        }
      | undefined
  )?.choices ?? [];

const ratingMax = (field: CsvImportCaseConfig["fields"][number]) =>
  (
    field.options as
      | {
          max?: number;
        }
      | undefined
  )?.max ?? 5;

const csvEscape = (value: unknown) => {
  const stringValue = value == null ? "" : String(value);
  return /[",\n]/.test(stringValue)
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
};

const getSelectChoice = (
  field: CsvImportCaseConfig["fields"][number],
  rowNumber: number,
) => {
  const choices = selectChoices(field);
  if (choices.length === 0) {
    throw new Error(`Select field ${field.name} has no choices`);
  }
  return choices[(rowNumber - 1) % choices.length].name;
};

const getMultiSelectChoices = (
  field: CsvImportCaseConfig["fields"][number],
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
  field: CsvImportCaseConfig["fields"][number],
  rowNumber: number,
  config: CsvImportCaseConfig,
) => {
  if (config.generator.compact) {
    if (
      ![
        "Title",
        "Status",
        "Tags",
        "Amount",
        "Start Date",
        "Active",
        "Score",
      ].includes(field.name)
    ) {
      return null;
    }

    switch (field.type) {
      case FieldType.SingleSelect:
        return getSelectChoice(field, rowNumber);
      case FieldType.MultipleSelect:
        return getMultiSelectChoices(field, rowNumber);
      case FieldType.Number:
        return rowNumber % 10;
      case FieldType.Date:
        return dateOnlyForRow(
          rowNumber,
          field.name.toLowerCase().includes("due") ? 7 : 0,
        );
      case FieldType.Checkbox:
        return rowNumber % 2 === 1 ? true : null;
      case FieldType.Rating:
        return ((rowNumber - 1) % ratingMax(field)) + 1;
      default:
        return field.name === "Title" ? `R${rowNumber}` : "x";
    }
  }

  const padded = padRowNumber(rowNumber);

  switch (field.name) {
    case "Title":
      return `${config.generator.titlePrefix} ${padded}`;
    case "Description":
    case "Notes":
    case "Comment":
      return `${config.generator.payloadPrefix}-${padded}-${field.name.replace(
        /\s+/g,
        "-",
      )}-payload`;
    case "Owner Text":
    case "External ID":
    case "Source":
      return `${config.generator.valuePrefix}-${padded}-${field.name.replace(
        /\s+/g,
        "-",
      )}`;
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
      return dateOnlyForRow(
        rowNumber,
        field.name.toLowerCase().includes("due") ? 7 : 0,
      );
    case FieldType.Checkbox:
      return rowNumber % 2 === 1 ? true : null;
    case FieldType.Rating:
      return ((rowNumber - 1) % ratingMax(field)) + 1;
    default:
      return `${config.generator.valuePrefix}-${padded}-${field.name.replace(
        /\s+/g,
        "-",
      )}`;
  }
};

const getCsvCellValue = (
  field: CsvImportCaseConfig["fields"][number],
  rowNumber: number,
  config: CsvImportCaseConfig,
) => {
  const expectedValue = getExpectedValue(field, rowNumber, config);
  if (Array.isArray(expectedValue)) {
    return expectedValue.join(", ");
  }
  if (expectedValue == null) {
    return "";
  }
  return expectedValue;
};

const buildCsvContent = (config: CsvImportCaseConfig) => {
  const header = config.fields.map((field) => csvEscape(field.name)).join(",");
  const rows = Array.from({ length: config.rowCount }, (_, index) => {
    const rowNumber = index + 1;
    return config.fields
      .map((field) => csvEscape(getCsvCellValue(field, rowNumber, config)))
      .join(",");
  });

  return [header, ...rows].join("\n");
};

const normalizeMultiSelectValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const valuesMatch = (expectedValue: unknown, actualValue: unknown) => {
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
  if (
    typeof expectedValue === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(expectedValue) &&
    typeof actualValue === "string"
  ) {
    return new Date(actualValue).toISOString().slice(0, 10) === expectedValue;
  }
  return actualValue === expectedValue;
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

const resolveCsvFields = (
  fields: Array<{ id: string; name: string }>,
  config: CsvImportCaseConfig,
) => {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  return config.fields.map((field) => {
    const resolvedField = fieldByName.get(field.name);
    if (!resolvedField) {
      throw new Error(
        `Missing CSV import field ${field.name}; available fields: ${fields
          .map(({ name }) => name)
          .join(", ")}`,
      );
    }
    return { ...field, id: resolvedField.id, name: resolvedField.name };
  });
};

const getCsvImportSeedConfig = (config: CsvImportCaseConfig) => ({
  baseId: config.baseId,
  targetMode: config.targetMode ?? "inplace",
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  fields: config.fields,
  generator: config.generator,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: CSV_IMPORT_FIXTURE_VERSION,
});

const getCsvImportTargetMode = (config: CsvImportCaseConfig) =>
  config.targetMode ?? "inplace";

const getCsvThresholdValue = (
  config: CsvImportCaseConfig,
  primaryMeasurement: Measurement<CsvImportPrimaryResult>,
) =>
  config.threshold.metric === "csvCreateTableImportCompletedMs"
    ? (primaryMeasurement.result.importCompletedMs ??
      primaryMeasurement.result.importRequestMs)
    : primaryMeasurement.durationMs;

const getCsvVerificationDuration = (
  primaryMeasurement: Measurement<CsvImportPrimaryResult>,
) =>
  roundMetric(
    primaryMeasurement.durationMs -
      (primaryMeasurement.result.importCompletedMs ??
        primaryMeasurement.result.importRequestMs),
  );

const buildBaseCsvFixture = async (
  baseId: string,
  tableId: string,
  tableName: string,
  config: CsvImportCaseConfig,
): Promise<
  Omit<
    CsvFixture,
    | "csvContent"
    | "attachmentUrl"
    | "sourceColumnMap"
    | "analyzeColumns"
    | "seedCacheInfo"
    | "seedCacheHit"
    | "reusableSeed"
  >
> => {
  const tableMeta = await getTable(baseId, tableId);
  const tableFields = await getFields(tableId);
  const views = await getViews(tableId);
  const viewId = views[0]?.id;
  if (!viewId) {
    throw new Error(`No grid view found for CSV import table ${tableId}`);
  }

  return {
    tableId,
    tableName,
    dbTableName: tableMeta.dbTableName,
    viewId,
    fields: resolveCsvFields(tableFields, config),
  };
};

const assertCsvImportTargetEmpty = async (
  baseId: string,
  fixture: Pick<CsvFixture, "dbTableName">,
) => {
  const rows = await queryPerfDb<{ count: string }>(
    `SELECT CAST(COUNT(*) AS text) AS "count" FROM ${getSqlTableRef(
      baseId,
      fixture.dbTableName,
    )}`,
  );
  const actualRowCount = Number(rows[0]?.count);
  if (actualRowCount !== 0) {
    throw new Error(`Expected empty CSV import target, got ${actualRowCount}`);
  }
  return { rowCount: actualRowCount };
};

const readImportedRowCount = async (
  baseId: string,
  fixture: Pick<CsvFixture, "dbTableName">,
) => {
  const rows = await queryPerfDb<{ count: string }>(
    `SELECT CAST(COUNT(*) AS text) AS "count" FROM ${getSqlTableRef(
      baseId,
      fixture.dbTableName,
    )}`,
  );
  return Number(rows[0]?.count);
};

const assertImportedRows = async (
  baseId: string,
  dbTableName: string,
  tableId: string,
  viewId: string,
  fields: CsvField[],
  config: CsvImportCaseConfig,
) => {
  const projection = fields.map((field) => field.id);
  const actualRowCount = await readImportedRowCount(baseId, { dbTableName });

  if (actualRowCount !== config.rowCount) {
    throw new Error(
      `Expected ${config.rowCount} imported records, got ${actualRowCount}`,
    );
  }

  const verifiedSamples = [];

  for (const rowOffset of config.verify.sampleRows) {
    if (rowOffset < 0 || rowOffset >= config.rowCount) {
      throw new Error(
        `Sample row offset ${rowOffset} is outside rowCount ${config.rowCount}`,
      );
    }

    const result = await getRecords(tableId, {
      viewId,
      fieldKeyType: FieldKeyType.Id,
      projection,
      skip: rowOffset,
      take: 1,
    });

    if (result.records.length !== 1) {
      throw new Error(
        `Expected 1 imported sample record at row offset ${rowOffset}, got ${result.records.length}`,
      );
    }

    const rowNumber = rowOffset + 1;
    const record = result.records[0];
    const actual: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};

    for (const field of fields) {
      const expectedValue = getExpectedValue(field, rowNumber, config);
      const actualValue = record.fields[field.id];
      actual[field.name] = actualValue;
      expected[field.name] = expectedValue;

      if (!valuesMatch(expectedValue, actualValue)) {
        throw new Error(
          `Row ${rowNumber} ${field.name} mismatch: expected ${String(
            expectedValue,
          )}, actual ${String(actualValue)}`,
        );
      }
    }

    verifiedSamples.push({
      rowOffset,
      rowNumber,
      recordId: record.id,
      actual,
      expected,
    });
  }

  return {
    rowCount: actualRowCount,
    sampleCount: verifiedSamples.length,
    verifiedSamples: verifiedSamples.sort(
      (left, right) => left.rowOffset - right.rowOffset,
    ),
  };
};

const assertImportedRowsReady = (
  baseId: string,
  dbTableName: string,
  tableId: string,
  viewId: string,
  fields: CsvField[],
  config: CsvImportCaseConfig,
) =>
  pollUntilReady(
    {
      timeoutMs: 120_000,
      pollIntervalMs: 1_000,
      description: "CSV import readiness",
    },
    () =>
      assertImportedRows(baseId, dbTableName, tableId, viewId, fields, config),
  );

const waitForCsvImportCompletion = async (
  baseId: string,
  tableId: string,
  dbTableName: string,
  config: CsvImportCaseConfig,
  context: PerfRunContext,
): Promise<CsvImportCompletion> => {
  const startedAt = Date.now();
  if (context.engine === "v2") {
    const rowCountAtCompletion = await readImportedRowCount(baseId, {
      dbTableName,
    });
    if (rowCountAtCompletion !== config.rowCount) {
      throw new Error(
        `V2 CSV import returned before all records were written: expected ${config.rowCount}, got ${rowCountAtCompletion}`,
      );
    }
    return {
      status: "completed" as const,
      engine: context.engine,
      completionSignal: "post-response-sql-row-count" as const,
      measuredWindow:
        "POST request duration; V2 ImportCsvCommand writes records before responding, then SQL row count is asserted after the response",
      pollCount: 0,
      durationMs: 0,
      expectedRowCount: config.rowCount,
      rowCountAtCompletion,
    };
  }

  const timeoutMs = 120_000;
  const pollIntervalMs = 1_000;
  let pollCount = 0;
  let latestStatus:
    | Awaited<ReturnType<typeof getImportStatus>>["data"]
    | undefined;

  while (Date.now() - startedAt <= timeoutMs) {
    pollCount += 1;
    const response = await getImportStatus(tableId);
    latestStatus = response.data;
    if (latestStatus.status === "completed") {
      return {
        ...latestStatus,
        engine: context.engine,
        completionSignal: "import-status-completed" as const,
        measuredWindow:
          "POST request duration plus GET /api/import/status polling until completed",
        pollIntervalMs,
        pollCount,
        durationMs: roundMetric(Date.now() - startedAt),
        expectedRowCount: config.rowCount,
        rowCountAtCompletion: await readImportedRowCount(baseId, {
          dbTableName,
        }),
      };
    }
    if (latestStatus.status === "failed") {
      throw new Error(
        `CSV import failed: ${latestStatus.message ?? JSON.stringify(latestStatus)}`,
      );
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(
    `CSV import completion timed out after ${timeoutMs}ms; latest=${JSON.stringify(
      latestStatus,
    )}`,
  );
};

const uploadCsv = async (csvContent: string) => {
  const csvBuffer = Buffer.from(csvContent, "utf8");
  const signature = await getSignature({
    type: UploadType.Import,
    contentLength: csvBuffer.byteLength,
    contentType: "text/csv",
  });
  const { token, requestHeaders } = signature.data;
  await uploadFile(token, csvBuffer, requestHeaders);
  const notified = await notify(token, undefined, CSV_FILE_NAME);

  return notified.data.presignedUrl ?? notified.data.url;
};

const parseCachedImportAttachment = (
  description: string | null | undefined,
): CachedImportAttachment | undefined => {
  if (!description?.startsWith(CSV_IMPORT_METADATA_PREFIX)) {
    return;
  }
  try {
    return JSON.parse(
      description.slice(CSV_IMPORT_METADATA_PREFIX.length),
    ) as CachedImportAttachment;
  } catch {
    return;
  }
};

const persistCachedImportAttachment = async (
  baseId: string,
  tableId: string,
  metadata: CachedImportAttachment,
) => {
  await updateTableDescription(baseId, tableId, {
    description: `${CSV_IMPORT_METADATA_PREFIX}${JSON.stringify(metadata)}`,
  });
};

const analyzeCsvAttachment = async (attachmentUrl: string) => {
  const analyzed = await analyzeFile({
    attachmentUrl,
    fileType: SUPPORTEDTYPE.CSV,
  });
  return (
    analyzed.data.worksheets[IMPORT_SHEET_KEY]?.columns ??
    Object.values<any>(analyzed.data.worksheets)[0]?.columns ??
    []
  );
};

const prepareCsvAttachment = async ({
  baseId,
  tableId,
  csvContent,
  cachedAttachment,
}: {
  baseId: string;
  tableId?: string;
  csvContent: string;
  cachedAttachment?: CachedImportAttachment;
}) => {
  // Attachment URLs can expire, so reuse is best-effort and falls back to a fresh upload.
  if (cachedAttachment?.fixtureVersion === CSV_IMPORT_FIXTURE_VERSION) {
    try {
      const analyzeColumns = await analyzeCsvAttachment(
        cachedAttachment.attachmentUrl,
      );
      return {
        attachmentUrl: cachedAttachment.attachmentUrl,
        analyzeColumns,
        attachmentCacheHit: true,
      };
    } catch (error) {
      console.warn(
        "Cached CSV import attachment is invalid; re-uploading",
        error,
      );
    }
  }

  const attachmentUrl = await uploadCsv(csvContent);
  const analyzeColumns = await analyzeCsvAttachment(attachmentUrl);
  if (tableId) {
    await persistCachedImportAttachment(baseId, tableId, {
      fixtureVersion: CSV_IMPORT_FIXTURE_VERSION,
      attachmentUrl,
      analyzeColumns,
    });
  }

  return {
    attachmentUrl,
    analyzeColumns,
    attachmentCacheHit: false,
  };
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

const assertExpectedCsvRouting = (
  context: PerfRunContext,
  config: CsvImportCaseConfig,
  responseHeaders: Record<string, string>,
) => {
  if (context.engine !== "v2") {
    return;
  }

  const expectedFeature =
    getCsvImportTargetMode(config) === "create-table"
      ? "importCsv"
      : "importRecords";

  if (
    responseHeaders["x-teable-v2"] === "false" ||
    responseHeaders["x-teable-v2-reason"] === "no_feature" ||
    responseHeaders["x-teable-v2-feature"] !== expectedFeature
  ) {
    throw new Error(
      `CSV import did not use expected V2 route ${expectedFeature}; headers=${JSON.stringify(
        responseHeaders,
      )}`,
    );
  }
};

const buildCreateTableWorksheets = (
  tableName: string,
  config: CsvImportCaseConfig,
  analyzeColumns: Array<{ name: string; type: string }>,
) => {
  const analyzedByName = new Map(
    analyzeColumns.map((column, index) => [column.name, { ...column, index }]),
  );
  const columns = config.fields.map((field, index) => {
    const analyzed = analyzedByName.get(field.name);
    return {
      name: field.name,
      type: analyzed?.type ?? field.type,
      sourceColumnIndex: analyzed?.index ?? index,
    };
  });

  return {
    [IMPORT_SHEET_KEY]: {
      name: tableName,
      columns,
      useFirstRowAsHeader: true,
      importData: true,
    },
  };
};

const prepareCsvCreateTableFixture = async (
  tableName: string,
  config: CsvImportCaseConfig,
): Promise<CsvFixture> => {
  const baseId = globalThis.testConfig.baseId;
  const csvContent = buildCsvContent(config);
  const attachmentUrl = await uploadCsv(csvContent);
  const analyzeColumns = await analyzeCsvAttachment(attachmentUrl);

  return {
    tableId: "",
    tableName,
    dbTableName: "",
    viewId: "",
    fields: config.fields.map((field) => ({
      ...field,
      id: "",
      name: field.name,
    })),
    csvContent,
    attachmentUrl,
    analyzeColumns,
  };
};

const prepareCsvImportFixture = async (
  baseId: string,
  tableName: string,
  config: CsvImportCaseConfig,
  perfCase: PerfCase,
): Promise<CsvFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "csv-import",
    fixtureVersion: CSV_IMPORT_FIXTURE_VERSION,
    seedConfig: getCsvImportSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
  const cachedTable =
    seedCacheInfo.enabled &&
    (await findSeedTable(baseId, seedCacheInfo.seedTableName));
  let baseFixture: Awaited<ReturnType<typeof buildBaseCsvFixture>> | undefined;
  let cachedAttachment: CachedImportAttachment | undefined;
  let seedCacheHit = false;
  let createdTableId = "";

  if (cachedTable) {
    try {
      baseFixture = await buildBaseCsvFixture(
        baseId,
        cachedTable.id,
        cachedTable.name,
        config,
      );
      await assertCsvImportTargetEmpty(baseId, baseFixture);
      cachedAttachment = parseCachedImportAttachment(
        (await getTable(baseId, cachedTable.id)).description,
      );
      seedCacheHit = true;
    } catch (error) {
      console.warn(
        `Invalid cached CSV import seed ${seedCacheInfo.seedTableName}; rebuilding`,
        error,
      );
      await permanentDeleteTable(baseId, cachedTable.id);
      baseFixture = undefined;
    }
  }

  if (!baseFixture) {
    const actualTableName = seedCacheInfo.enabled
      ? seedCacheInfo.seedTableName
      : tableName;
    try {
      const table = await createTable(baseId, {
        name: actualTableName,
        fields: config.fields,
        records: [],
      });
      createdTableId = table.id;
      baseFixture = await buildBaseCsvFixture(
        baseId,
        table.id,
        actualTableName,
        config,
      );
      await assertCsvImportTargetEmpty(baseId, baseFixture);
    } catch (error) {
      if (createdTableId) {
        try {
          await permanentDeleteTable(baseId, createdTableId);
        } catch (cleanupError) {
          console.warn(
            `Failed to cleanup incomplete CSV import seed ${createdTableId}`,
            cleanupError,
          );
        }
      }
      throw error;
    }
  }

  const csvContent = buildCsvContent(config);
  const attachment = await prepareCsvAttachment({
    baseId,
    tableId: baseFixture.tableId,
    csvContent,
    cachedAttachment,
  });

  return {
    ...baseFixture,
    csvContent,
    attachmentUrl: attachment.attachmentUrl,
    sourceColumnMap: Object.fromEntries(
      baseFixture.fields.map((field, index) => [field.id, index]),
    ),
    analyzeColumns: attachment.analyzeColumns,
    attachmentCacheHit: attachment.attachmentCacheHit,
    seedCacheInfo,
    seedCacheHit,
    reusableSeed: seedCacheInfo.enabled,
  };
};

const importAndVerifyCsv = async (
  baseId: string,
  fixture: CsvFixture,
  config: CsvImportCaseConfig,
  context: PerfRunContext,
  perfCase: PerfCase,
  traceStepId: string,
) => {
  if (getCsvImportTargetMode(config) === "create-table") {
    const importMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      traceStepId,
      () =>
        measureAsync("importRequest", async () => {
          const response = await importTableFromFile(baseId, {
            attachmentUrl: fixture.attachmentUrl,
            fileType: SUPPORTEDTYPE.CSV,
            worksheets: buildCreateTableWorksheets(
              fixture.tableName,
              config,
              fixture.analyzeColumns,
            ),
            notification: true,
            tz: "UTC",
          });
          expect([200, 201]).toContain(response.status);
          return response;
        }),
    );

    const responseHeaders = pickResponseHeaders(
      importMeasurement.result.headers,
    );
    assertExpectedCsvRouting(context, config, responseHeaders);

    const createdTable = importMeasurement.result.data[0];
    if (!createdTable?.id) {
      throw new Error("CSV create-table import did not return a table id");
    }

    const tableMeta = await getTable(baseId, createdTable.id);
    const tableFields = await getFields(createdTable.id);
    const views = await getViews(createdTable.id);
    const viewId = views[0]?.id;
    if (!viewId) {
      throw new Error(
        `No grid view found for CSV import table ${createdTable.id}`,
      );
    }
    const fields = resolveCsvFields(tableFields, config);

    fixture.tableId = createdTable.id;
    fixture.dbTableName = tableMeta.dbTableName;
    fixture.viewId = viewId;
    fixture.fields = fields;
    fixture.lastImport = {
      importRequestMs: importMeasurement.durationMs,
      importStatus: importMeasurement.result.status,
      responseHeaders,
      createdTableId: createdTable.id,
    };

    const completionMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      traceStepId,
      () =>
        measureAsync("importCompleted", () =>
          waitForCsvImportCompletion(
            baseId,
            createdTable.id,
            tableMeta.dbTableName,
            config,
            context,
          ),
        ),
    );

    const verifyMeasurement = await measureAsync("verifyReady", () =>
      assertImportedRowsReady(
        baseId,
        tableMeta.dbTableName,
        createdTable.id,
        viewId,
        fields,
        config,
      ),
    );

    return {
      importRequestMs: importMeasurement.durationMs,
      importCompletedMs:
        importMeasurement.durationMs + completionMeasurement.result.durationMs,
      importCompletion: completionMeasurement.result,
      importStatus: importMeasurement.result.status,
      responseHeaders,
      verifiedRows: verifyMeasurement.result,
      createdTableId: createdTable.id,
    };
  }

  const importMeasurement = await withPerfTraceStep(
    context,
    perfCase,
    traceStepId,
    () =>
      measureAsync("importRequest", async () => {
        const response = await inplaceImportTableFromFile(
          baseId,
          fixture.tableId,
          {
            attachmentUrl: fixture.attachmentUrl,
            fileType: SUPPORTEDTYPE.CSV,
            insertConfig: {
              excludeFirstRow: true,
              sourceWorkSheetKey: IMPORT_SHEET_KEY,
              sourceColumnMap: fixture.sourceColumnMap,
            },
            notification: true,
          },
        );
        expect(response.status).toBe(200);
        return response;
      }),
  );

  const responseHeaders = pickResponseHeaders(importMeasurement.result.headers);
  assertExpectedCsvRouting(context, config, responseHeaders);
  fixture.lastImport = {
    importRequestMs: importMeasurement.durationMs,
    importStatus: importMeasurement.result.status,
    responseHeaders,
  };

  const verifyMeasurement = await measureAsync("verifyReady", () =>
    assertImportedRowsReady(
      baseId,
      fixture.dbTableName,
      fixture.tableId,
      fixture.viewId,
      fixture.fields,
      config,
    ),
  );

  return {
    importRequestMs: importMeasurement.durationMs,
    importCompletion: {
      status: "completed",
      engine: context.engine,
      completionSignal: "verify-ready-sql-row-count-plus-samples",
      measuredWindow:
        "PATCH request duration plus SQL row-count readiness and configured sample-row verification",
      pollCount: 0,
      durationMs: verifyMeasurement.durationMs,
      expectedRowCount: config.rowCount,
      rowCountAtCompletion: verifyMeasurement.result.rowCount,
    },
    importStatus: importMeasurement.result.status,
    responseHeaders,
    verifiedRows: verifyMeasurement.result,
  };
};

const buildCsvImportCaseResult = ({
  config,
  prepareMeasurement,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  config: CsvImportCaseConfig;
  prepareMeasurement?: Measurement<CsvFixture>;
  seedReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertCsvImportTargetEmpty>>
  >;
  primaryMeasurement?: Measurement<CsvImportPrimaryResult>;
  error?: unknown;
}): PerfRunResult => {
  const fixture = prepareMeasurement?.result;
  const primaryResult = primaryMeasurement?.result;
  const lastImport = primaryResult ?? fixture?.lastImport;
  const thresholdValue = primaryMeasurement
    ? getCsvThresholdValue(config, primaryMeasurement)
    : undefined;
  const verificationDuration = primaryMeasurement
    ? getCsvVerificationDuration(primaryMeasurement)
    : undefined;

  return {
    metrics: {
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
            [config.threshold.metric]: thresholdValue ?? 0,
            ...(config.threshold.metric !== "csvCreateTableImportReadyMs"
              ? { csvCreateTableImportReadyMs: primaryMeasurement.durationMs }
              : {}),
            importRequestMs: primaryResult?.importRequestMs ?? 0,
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
      ...(primaryMeasurement
        ? [
            {
              name: primaryMeasurement.name,
              durationMs: thresholdValue ?? primaryMeasurement.durationMs,
            },
            ...(config.threshold.metric === "csvCreateTableImportCompletedMs"
              ? [
                  {
                    name: "verifyReady",
                    durationMs: verificationDuration ?? 0,
                  },
                  {
                    name: "csvCreateTableImportReadyMs",
                    durationMs: primaryMeasurement.durationMs,
                  },
                ]
              : []),
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
    ],
    details: {
      tableId: fixture?.tableId,
      targetMode: getCsvImportTargetMode(config),
      tableName: fixture?.tableName,
      dbTableName: fixture?.dbTableName,
      viewId: fixture?.viewId,
      rowCount: config.rowCount,
      fieldCount: config.fields.length,
      csvBytes: fixture ? Buffer.byteLength(fixture.csvContent, "utf8") : 0,
      fields: fixture?.fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
      })),
      prepare: fixture
        ? {
            durationMs: prepareMeasurement.durationMs,
            cache: fixture.seedCacheInfo
              ? {
                  enabled: fixture.seedCacheInfo.enabled,
                  cacheHit: Boolean(fixture.seedCacheHit),
                  reusable: Boolean(fixture.reusableSeed),
                  seedHash: fixture.seedCacheInfo.seedHash,
                  seedHashShort: fixture.seedCacheInfo.seedHashShort,
                  seedTableName: fixture.seedCacheInfo.seedTableName,
                  schemaSignature: fixture.seedCacheInfo.schemaSignature,
                }
              : undefined,
            uploadedBeforeMetric: true,
            analyzedBeforeMetric: true,
            attachmentCacheHit: Boolean(fixture.attachmentCacheHit),
            analyzeColumns: fixture.analyzeColumns,
            seedReady: seedReadyMeasurement?.result,
          }
        : undefined,
      import: lastImport
        ? {
            status: lastImport.importStatus,
            requestMs: lastImport.importRequestMs,
            responseHeaders: lastImport.responseHeaders,
            createdTableId: lastImport.createdTableId,
            completion: primaryResult?.importCompletion,
            verificationCompleted: Boolean(primaryResult),
          }
        : undefined,
      verification: primaryResult
        ? {
            method: "sql-count-plus-samples",
            rowCount: primaryResult.verifiedRows.rowCount,
            sampleCount: primaryResult.verifiedRows.sampleCount,
            durationMs: verificationDuration,
          }
        : undefined,
      verifiedSamples: primaryResult?.verifiedRows.verifiedSamples,
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

const csvImportLifecycleSpec: CsvImportLifecycleSpec<
  CsvFixture,
  CsvImportPrimaryResult,
  Awaited<ReturnType<typeof assertCsvImportTargetEmpty>>
> = {
  hasReusableSeed: (config) =>
    getCsvImportTargetMode(config) !== "create-table",
  seedlessResult: (perfCase) => ({
    result: "skipped",
    metrics: {},
    thresholds: [],
    details: {
      skipped: true,
      reason: "create-table has no reusable seed",
      runner: perfCase.runner,
    },
  }),
  prepareExecute: ({ perfCase, config, baseId, tableName }) =>
    getCsvImportTargetMode(config) === "create-table"
      ? prepareCsvCreateTableFixture(tableName, config)
      : prepareCsvImportFixture(baseId, tableName, config, perfCase),
  prepareSeed: ({ perfCase, config, baseId, tableName }) =>
    prepareCsvImportFixture(baseId, tableName, config, perfCase),
  execute: ({ perfCase, context, config, baseId, fixture }) =>
    importAndVerifyCsv(
      baseId,
      fixture,
      config,
      context,
      perfCase,
      config.threshold.metric,
    ),
  seedReady: ({ baseId, fixture }) =>
    assertCsvImportTargetEmpty(baseId, fixture),
  buildResult: buildCsvImportCaseResult,
  cleanup: async ({ baseId, prepareMeasurement }) => {
    // CI execute jobs run on a disposable restored DB copy, so the imported
    // (mutated) table is discarded with the database. Locally the table is
    // deleted: inplace import mutates the cached seed and create-table mode
    // has no reusable seed.
    if (prepareMeasurement?.result.tableId && !isExecuteDbIsolated()) {
      try {
        await permanentDeleteTable(baseId, prepareMeasurement.result.tableId);
      } catch (error) {
        console.warn(
          `Failed to cleanup perf table ${prepareMeasurement.result.tableId}`,
          error,
        );
      }
    }
  },
};

export const runCsvImportCase = (
  perfCase: PerfCaseFor<"csv-import">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runCsvImportLifecycle(perfCase, context, csvImportLifecycleSpec);

export const seedCsvImportCase = (
  perfCase: PerfCaseFor<"csv-import">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedCsvImportLifecycle(perfCase, context, csvImportLifecycleSpec);
