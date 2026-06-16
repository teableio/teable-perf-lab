import { FieldKeyType, FieldType } from "@teable/core";
import { performance } from "node:perf_hooks";
import {
  axios,
  createBase,
  createWorkflow,
  getBaseList,
  getSignature,
  getTableList,
  notify,
  permanentDeleteBase,
  uploadFile,
  UploadType,
  updateTableDescription,
  X_CANARY_HEADER,
} from "@teable/openapi";
import {
  createRecords,
  createTable,
  getFields,
  getRecords,
  getTable,
  getViews,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, roundMetric } from "../metrics";
import {
  assertEngineRouting,
  getRoutingResponseHeader,
  type EngineRouting,
} from "../routing";
import { buildSeedCacheInfo, type SeedCacheInfo } from "../seed-cache";
import { perfStreamSse } from "../sse";
import { withPerfTraceStep } from "../trace-collector";
import { PerfRunDiagnosticError } from "../types";
import type {
  ImportBaseCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import type { Measurement } from "./record-undo-redo.shared";

const IMPORT_BASE_FIXTURE_VERSION = "import-base-v1";
const IMPORT_BASE_METADATA_PREFIX = "perf-lab-import-base:";

const TITLE_FIELD = "Title";
const EXTERNAL_ID_FIELD = "External ID";
const PAYLOAD_FIELD = "Payload";
const ROW_NUMBER_FIELD = "Row Number";

type ImportBaseTableConfig = ImportBaseCaseConfig["tables"][number];

type TableRef = {
  id: string;
  name: string;
  viewId: string;
  fieldIdByName: Record<string, string>;
};

type ImportBaseFixture = {
  baseId: string;
  baseName: string;
  tables: TableRef[];
  workflowCount: number;
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
};

type BaseStreamProgressEvent = {
  type: "progress";
  phase: string;
  detail?: string;
  tableId?: string;
  tableName?: string;
  tableIndex?: number;
  totalTables?: number;
  totalRows?: number;
  processedRows?: number;
  batchProcessedRows?: number;
  currentBatch?: number;
};

type BaseStreamErrorEvent = { type: "error"; message: string };

type ExportBaseDoneEvent = {
  type: "done";
  data: {
    previewUrl: string;
    baseName: string;
    fileName: string;
  };
};

type ImportBaseDoneEvent = {
  type: "done";
  data: {
    base: { id: string; name: string; spaceId: string };
    tableIdMap: Record<string, string>;
    fieldIdMap: Record<string, string>;
    viewIdMap: Record<string, string>;
    workflowIdMap?: Record<string, string>;
    baseIdMap?: Record<string, string>;
  };
};

type ExportBaseStreamEvent =
  | BaseStreamProgressEvent
  | ExportBaseDoneEvent
  | BaseStreamErrorEvent;

type ImportBaseStreamEvent =
  | BaseStreamProgressEvent
  | ImportBaseDoneEvent
  | BaseStreamErrorEvent;

type WorkflowVerification = {
  available: boolean;
  totalCount?: number;
  prefixMatchCount?: number;
  expectedCount: number;
};

type TableScanResult = {
  tableId: string;
  name: string;
  scannedRecords: number;
  pageCount: number;
  samples: Array<{
    rowOffset: number;
    rowNumber: number;
    recordId: string;
    title: unknown;
    externalId: unknown;
  }>;
};

type ImportedBaseVerification = {
  attempts: number;
  waitedMs: number;
  tables: {
    main?: TableScanResult;
    importedTables: TableScanResult[];
  };
  workflows: WorkflowVerification;
};

type ImportNotifyInfo = {
  notify: unknown;
  bytes: number;
  contentType: string;
};

type ImportBasePrimaryResult = {
  requestMs: number;
  status: number;
  resultBaseId: string;
  resultBaseName: string;
  progressEventCount: number;
  doneEvent: ImportBaseDoneEvent & {
    preparedExportMs: number;
    uploadMs: number;
    uploadedBytes: number;
  };
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
  verification?: ImportedBaseVerification;
};

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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

const getStreamHeaders = (context: PerfRunContext) => ({
  "Content-Type": "application/json",
  ...(context.cookie ? { Cookie: context.cookie } : {}),
  [X_CANARY_HEADER]: context.engine === "v2" ? "true" : "false",
});

const getEffectiveThresholdMetric = (
  config: ImportBaseCaseConfig,
  context?: PerfRunContext,
) =>
  context?.engine === "v1" ? "importBaseTotalReadyMs" : config.threshold.metric;

const expectedTitle = (rowNumber: number, tableConfig: ImportBaseTableConfig) =>
  `${tableConfig.generator.titlePrefix} ${padRowNumber(rowNumber)}`;

const expectedExternalId = (rowNumber: number) =>
  `IMPORT-BASE-${padRowNumber(rowNumber)}`;

const tableFields = () => [
  { name: TITLE_FIELD, type: FieldType.SingleLineText },
  { name: EXTERNAL_ID_FIELD, type: FieldType.SingleLineText },
  { name: PAYLOAD_FIELD, type: FieldType.LongText },
  { name: ROW_NUMBER_FIELD, type: FieldType.Number },
];

const buildRecordFields = (
  tableConfig: ImportBaseTableConfig,
  rowNumber: number,
) => {
  const padded = padRowNumber(rowNumber);
  return {
    [TITLE_FIELD]: expectedTitle(rowNumber, tableConfig),
    [EXTERNAL_ID_FIELD]: expectedExternalId(rowNumber),
    [PAYLOAD_FIELD]: `${tableConfig.generator.payloadPrefix} payload ${padded}`,
    [ROW_NUMBER_FIELD]: rowNumber,
  };
};

const buildTableRef = async (
  tableId: string,
  tableName: string,
): Promise<TableRef> => {
  const fields = await getFields(tableId);
  const fieldIdByName: Record<string, string> = {};
  for (const field of fields) {
    fieldIdByName[field.name] = field.id;
  }

  for (const fieldName of [TITLE_FIELD, EXTERNAL_ID_FIELD]) {
    if (!fieldIdByName[fieldName]) {
      throw new Error(`Table ${tableName} is missing field ${fieldName}`);
    }
  }

  const views = await getViews(tableId);
  const viewId = views[0]?.id;
  if (!viewId) {
    throw new Error(`No grid view found for table ${tableName}`);
  }

  return { id: tableId, name: tableName, viewId, fieldIdByName };
};

const resolveTables = async (baseId: string, config: ImportBaseCaseConfig) => {
  const tableList = (await getTableList(baseId)).data as Array<{
    id: string;
    name: string;
  }>;
  const byName = new Map(tableList.map((table) => [table.name, table]));
  const missingTableNames = config.tables
    .map((table) => table.name)
    .filter((name) => !byName.has(name));
  if (missingTableNames.length) {
    throw new Error(
      `Base ${baseId} is missing expected tables ${missingTableNames.join(
        ", ",
      )}; found: ${tableList.map((table) => table.name).join(", ")}`,
    );
  }

  return Promise.all(
    config.tables.map((expectedTable) => {
      const table = byName.get(expectedTable.name)!;
      return buildTableRef(table.id, table.name);
    }),
  );
};

const assertTableSamples = async (
  tableRef: TableRef,
  tableConfig: ImportBaseTableConfig,
  sampleRows: number[],
) => {
  const titleFieldId = tableRef.fieldIdByName[TITLE_FIELD];
  const externalIdFieldId = tableRef.fieldIdByName[EXTERNAL_ID_FIELD];
  const verifiedSamples: TableScanResult["samples"] = [];

  for (const rowOffset of sampleRows) {
    const rowNumber = rowOffset + 1;
    const result = await getRecords(tableRef.id, {
      viewId: tableRef.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: [titleFieldId, externalIdFieldId],
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(
        `${tableRef.name} sample row at offset ${rowOffset} not found`,
      );
    }

    const actualTitle = record.fields[titleFieldId];
    const expectedSampleTitle = expectedTitle(rowNumber, tableConfig);
    if (actualTitle !== expectedSampleTitle) {
      throw new Error(
        `${tableRef.name} row ${rowNumber} Title mismatch: expected ${expectedSampleTitle}, actual ${String(
          actualTitle,
        )}`,
      );
    }

    const actualExternalId = record.fields[externalIdFieldId];
    const expectedSampleExternalId = expectedExternalId(rowNumber);
    if (actualExternalId !== expectedSampleExternalId) {
      throw new Error(
        `${tableRef.name} row ${rowNumber} External ID mismatch: expected ${expectedSampleExternalId}, actual ${String(
          actualExternalId,
        )}`,
      );
    }

    verifiedSamples.push({
      rowOffset,
      rowNumber,
      recordId: record.id,
      title: actualTitle,
      externalId: actualExternalId,
    });
  }

  return verifiedSamples;
};

const scanTable = async (
  tableRef: TableRef,
  tableConfig: ImportBaseTableConfig,
  config: ImportBaseCaseConfig,
): Promise<TableScanResult> => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  let scannedRecords = 0;
  let pageCount = 0;

  for (let skip = 0; skip < tableConfig.rowCount; skip += pageSize) {
    const expectedTake = Math.min(pageSize, tableConfig.rowCount - skip);
    const result = await getRecords(tableRef.id, {
      viewId: tableRef.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: [tableRef.fieldIdByName[TITLE_FIELD]],
      skip,
      take: expectedTake,
    });
    pageCount += 1;

    if (result.records.length !== expectedTake) {
      throw new Error(
        `Expected ${expectedTake} records in ${tableRef.name} at skip ${skip}, got ${result.records.length}`,
      );
    }
    scannedRecords += result.records.length;
  }

  if (scannedRecords !== tableConfig.rowCount) {
    throw new Error(
      `Row count mismatch in ${tableRef.name}: expected ${tableConfig.rowCount}, scanned ${scannedRecords}`,
    );
  }

  const samples = await assertTableSamples(
    tableRef,
    tableConfig,
    config.verify.sampleRows,
  );

  return {
    tableId: tableRef.id,
    name: tableRef.name,
    scannedRecords,
    pageCount,
    samples,
  };
};

const listWorkflows = async (
  baseId: string,
): Promise<{ available: boolean; items: Array<{ name?: string }> }> => {
  try {
    const response = await axios.get(`/base/${baseId}/workflow`);
    const data = response.data as unknown;
    const items = Array.isArray(data)
      ? data
      : Array.isArray((data as { workflows?: unknown[] })?.workflows)
        ? (data as { workflows: unknown[] }).workflows
        : Array.isArray((data as { list?: unknown[] })?.list)
          ? (data as { list: unknown[] }).list
          : [];
    return { available: true, items: items as Array<{ name?: string }> };
  } catch {
    return { available: false, items: [] };
  }
};

const verifyWorkflows = async (
  baseId: string,
  expectedCount: number,
  namePrefix: string,
): Promise<WorkflowVerification> => {
  if (expectedCount === 0) {
    return { available: false, expectedCount };
  }

  const { available, items } = await listWorkflows(baseId);
  if (!available) {
    return { available: false, expectedCount };
  }

  const totalCount = items.length;
  const prefixMatchCount = items.filter((item) =>
    String(item?.name ?? "").startsWith(namePrefix),
  ).length;
  if (totalCount < expectedCount) {
    throw new Error(
      `Expected at least ${expectedCount} workflows in base ${baseId}, found ${totalCount}`,
    );
  }

  return { available: true, totalCount, prefixMatchCount, expectedCount };
};

const parseMetadata = (description: string | null | undefined) => {
  if (!description?.startsWith(IMPORT_BASE_METADATA_PREFIX)) {
    return;
  }
  try {
    return JSON.parse(description.slice(IMPORT_BASE_METADATA_PREFIX.length));
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
    description: `${IMPORT_BASE_METADATA_PREFIX}${JSON.stringify(metadata)}`,
  });
};

const getSeedConfig = (config: ImportBaseCaseConfig) => ({
  spaceId: config.spaceId,
  sourceBaseNamePrefix: config.sourceBaseNamePrefix,
  tables: config.tables,
  fields: tableFields(),
  workflows: config.workflows,
  sampleRows: config.verify.sampleRows,
  fixtureVersion: IMPORT_BASE_FIXTURE_VERSION,
});

const assertSourceBaseReady = async (
  fixture: Pick<ImportBaseFixture, "tables">,
  config: ImportBaseCaseConfig,
) => {
  const tableResults = [];
  for (const [index, tableConfig] of config.tables.entries()) {
    const tableRef = fixture.tables[index];
    if (!tableRef) {
      throw new Error(`Fixture is missing table ${tableConfig.name}`);
    }
    tableResults.push(await scanTable(tableRef, tableConfig, config));
  }

  return { tables: tableResults };
};

const seedTable = async (
  baseId: string,
  tableConfig: ImportBaseTableConfig,
) => {
  const table = await createTable(baseId, {
    name: tableConfig.name,
    fields: tableFields(),
    records: [],
  });

  const records = Array.from({ length: tableConfig.rowCount }, (_, index) => ({
    fields: buildRecordFields(tableConfig, index + 1),
  }));
  for (const batch of chunk(records, tableConfig.batchSize)) {
    await createRecords(table.id, {
      fieldKeyType: FieldKeyType.Name,
      typecast: true,
      records: batch,
    });
  }

  return { tableId: table.id };
};

const seedWorkflows = async (baseId: string, config: ImportBaseCaseConfig) => {
  let seeded = 0;
  for (let index = 1; index <= config.workflows.count; index += 1) {
    try {
      await createWorkflow(baseId, {
        name: `${config.workflows.namePrefix}-${index}`,
      });
      seeded += 1;
    } catch (error) {
      console.warn(
        `Workflow creation unavailable in this runtime; seeded ${seeded}/${config.workflows.count}`,
        error instanceof Error ? error.message : error,
      );
      break;
    }
  }
  return seeded;
};

const findCachedSourceBase = async (spaceId: string, seedBaseName: string) => {
  const response = await getBaseList({ spaceId });
  return response.data.find((base) => base.name === seedBaseName);
};

const prepareImportBaseFixture = async (
  spaceId: string,
  config: ImportBaseCaseConfig,
  perfCase: PerfCase,
): Promise<ImportBaseFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "import-base",
    fixtureVersion: IMPORT_BASE_FIXTURE_VERSION,
    seedConfig: getSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });

  const cachedBase =
    seedCacheInfo.enabled &&
    (await findCachedSourceBase(spaceId, seedCacheInfo.seedTableName));

  if (cachedBase) {
    try {
      const tables = await resolveTables(cachedBase.id, config);
      const mainMeta = await getTable(cachedBase.id, tables[0].id);
      const metadata = parseMetadata(mainMeta.description);
      if (
        !metadata ||
        metadata.fixtureVersion !== IMPORT_BASE_FIXTURE_VERSION ||
        JSON.stringify(metadata.tableRowCounts) !==
          JSON.stringify(config.tables.map((table) => table.rowCount)) ||
        metadata.requestedWorkflowCount !== config.workflows.count
      ) {
        throw new Error("Cached import base metadata mismatch");
      }

      const fixture: ImportBaseFixture = {
        baseId: cachedBase.id,
        baseName: cachedBase.name,
        tables,
        workflowCount: Number(metadata.workflowCount ?? 0),
        seedCacheInfo,
        seedCacheHit: true,
        reusableSeed: true,
      };
      await assertSourceBaseReady(fixture, config);
      return fixture;
    } catch (error) {
      console.warn(
        `Invalid cached import base seed ${seedCacheInfo.seedTableName}; rebuilding`,
        error,
      );
      try {
        await permanentDeleteBase(cachedBase.id);
      } catch (cleanupError) {
        console.warn(
          `Failed to delete stale import base seed ${cachedBase.id}`,
          cleanupError,
        );
      }
    }
  }

  const baseName = seedCacheInfo.enabled
    ? seedCacheInfo.seedTableName
    : `${config.sourceBaseNamePrefix}-${Date.now()}`;
  let createdBaseId = "";

  try {
    const baseResponse = await createBase({ spaceId, name: baseName });
    expect([200, 201]).toContain(baseResponse.status);
    createdBaseId = baseResponse.data.id;

    let mainTableId = "";
    for (const tableConfig of config.tables) {
      const table = await seedTable(createdBaseId, tableConfig);
      mainTableId ||= table.tableId;
    }
    if (!mainTableId) {
      throw new Error("Failed to seed primary table for import base fixture");
    }

    const workflowCount = await seedWorkflows(createdBaseId, config);
    await persistMetadata(createdBaseId, mainTableId, {
      fixtureVersion: IMPORT_BASE_FIXTURE_VERSION,
      tableRowCounts: config.tables.map((table) => table.rowCount),
      requestedWorkflowCount: config.workflows.count,
      workflowCount,
    });

    const tables = await resolveTables(createdBaseId, config);
    const fixture: ImportBaseFixture = {
      baseId: createdBaseId,
      baseName,
      tables,
      workflowCount,
      seedCacheInfo,
      seedCacheHit: false,
      reusableSeed: seedCacheInfo.enabled,
    };
    await assertSourceBaseReady(fixture, config);
    return fixture;
  } catch (error) {
    if (createdBaseId) {
      try {
        await permanentDeleteBase(createdBaseId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup incomplete import base seed ${createdBaseId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const verifyImportedBase = async (
  importedBaseId: string,
  fixture: ImportBaseFixture,
  config: ImportBaseCaseConfig,
): Promise<ImportedBaseVerification> => {
  const timeoutMs = config.verify.timeoutMs ?? 180_000;
  const pollIntervalMs = config.verify.pollIntervalMs ?? 2_000;
  const startedAt = Date.now();
  let attempts = 0;
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    try {
      const tables = await resolveTables(importedBaseId, config);
      const tableResults = [];
      for (const [index, tableConfig] of config.tables.entries()) {
        const tableRef = tables[index];
        if (!tableRef) {
          throw new Error(`Imported base is missing table ${tableConfig.name}`);
        }
        tableResults.push(await scanTable(tableRef, tableConfig, config));
      }

      const workflows = await verifyWorkflows(
        importedBaseId,
        fixture.workflowCount,
        config.workflows.namePrefix,
      );

      return {
        attempts,
        waitedMs: Date.now() - startedAt,
        tables: {
          main: tableResults[0],
          importedTables: tableResults,
        },
        workflows,
      };
    } catch (error) {
      lastError = error;
      await delay(pollIntervalMs);
    }
  }

  throw new Error(
    `Imported base did not become ready within ${timeoutMs}ms after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

const firstErrorMessage = (errors: BaseStreamErrorEvent[]) =>
  errors.at(-1)?.message ?? "SSE stream ended without result";

const exportBaseStream = async (
  context: PerfRunContext,
  perfCase: PerfCase,
  fixture: ImportBaseFixture,
) => {
  const url = axios.getUri({
    baseURL: axios.defaults.baseURL || "/api",
    url: `/base/${fixture.baseId}/export-stream`,
    params: { includeData: true },
  });
  const streamMeasurement = await measureAsync("prepareImportExport", () =>
    perfStreamSse<ExportBaseStreamEvent>({
      context,
      perfCase,
      stepId: "prepareImportExport",
      url,
      method: "GET",
      headers: getStreamHeaders(context),
      errorPrefix: "Export base stream failed",
    }),
  );
  const sseResult = streamMeasurement.result;
  const errors = sseResult.events.filter(
    (event): event is BaseStreamErrorEvent => event.type === "error",
  );
  const done = sseResult.events.find(
    (event): event is ExportBaseDoneEvent => event.type === "done",
  );

  if (!done) {
    throw new Error(firstErrorMessage(errors));
  }
  expect(errors).toHaveLength(0);
  if (!done.data.previewUrl || !done.data.fileName) {
    throw new Error(
      `Export base stream returned incomplete result: ${JSON.stringify(
        done.data,
      )}`,
    );
  }

  return {
    measurement: streamMeasurement,
    exportResult: done.data,
  };
};

const buildImportNotifyFromExport = async (
  context: PerfRunContext,
  exportResult: ExportBaseDoneEvent["data"],
): Promise<ImportNotifyInfo> => {
  const downloadUrl = new URL(exportResult.previewUrl, context.appUrl);
  const downloadResponse = await fetch(downloadUrl, {
    headers: context.cookie ? { Cookie: context.cookie } : undefined,
  });
  if (!downloadResponse.ok) {
    throw new Error(
      `Failed to download exported base ${downloadResponse.status}: ${await downloadResponse.text()}`,
    );
  }

  const buffer = Buffer.from(await downloadResponse.arrayBuffer());
  const contentType =
    downloadResponse.headers.get("content-type") || "application/zip";
  const signature = await getSignature({
    contentType,
    contentLength: buffer.length,
    type: UploadType.Import,
  });
  expect([200, 201]).toContain(signature.status);
  await uploadFile(
    signature.data.token,
    buffer,
    signature.data.requestHeaders as Record<string, unknown>,
  );
  const notifyResponse = await notify(
    signature.data.token,
    undefined,
    exportResult.fileName,
  );
  expect([200, 201]).toContain(notifyResponse.status);

  return {
    notify: notifyResponse.data,
    bytes: buffer.length,
    contentType,
  };
};

const importBaseStream = async ({
  context,
  perfCase,
  spaceId,
  fixture,
  config,
  notifyInfo,
  exportMeasurement,
  uploadMeasurement,
}: {
  context: PerfRunContext;
  perfCase: PerfCase;
  spaceId: string;
  fixture: ImportBaseFixture;
  config: ImportBaseCaseConfig;
  notifyInfo: ImportNotifyInfo;
  exportMeasurement: Measurement<unknown>;
  uploadMeasurement: Measurement<ImportNotifyInfo>;
}): Promise<ImportBasePrimaryResult> => {
  const streamMeasurement = await measureAsync("importBaseStream", () =>
    perfStreamSse<ImportBaseStreamEvent>({
      context,
      perfCase,
      stepId: getEffectiveThresholdMetric(config, context),
      url: `${axios.defaults.baseURL || "/api"}/base/import-stream`,
      method: "POST",
      headers: getStreamHeaders(context),
      body: JSON.stringify({
        spaceId,
        notify: notifyInfo.notify,
      }),
      errorPrefix: "Import base stream failed",
    }),
  );
  const sseResult = streamMeasurement.result;
  const progressEvents = sseResult.events.filter(
    (event): event is BaseStreamProgressEvent => event.type === "progress",
  );
  const errors = sseResult.events.filter(
    (event): event is BaseStreamErrorEvent => event.type === "error",
  );
  const done = sseResult.events.find(
    (event): event is ImportBaseDoneEvent => event.type === "done",
  );

  if (!done) {
    throw new Error(firstErrorMessage(errors));
  }
  expect(errors).toHaveLength(0);

  const routing = assertEngineRouting(context, sseResult.headers, {
    feature: "importBase",
    operation: "importBaseStream",
  });

  const primaryResult: ImportBasePrimaryResult = {
    requestMs: streamMeasurement.durationMs,
    status: sseResult.status,
    resultBaseId: done.data.base.id,
    resultBaseName: done.data.base.name,
    progressEventCount: progressEvents.length,
    doneEvent: {
      ...done,
      preparedExportMs: exportMeasurement.durationMs,
      uploadMs: uploadMeasurement.durationMs,
      uploadedBytes: notifyInfo.bytes,
    },
    responseHeaders: pickResponseHeaders(sseResult.headers),
    routing,
  };

  return primaryResult;
};

const measureImportBaseReady = async ({
  context,
  perfCase,
  spaceId,
  fixture,
  config,
  notifyInfo,
  exportMeasurement,
  uploadMeasurement,
}: {
  context: PerfRunContext;
  perfCase: PerfCase;
  spaceId: string;
  fixture: ImportBaseFixture;
  config: ImportBaseCaseConfig;
  notifyInfo: ImportNotifyInfo;
  exportMeasurement: Measurement<unknown>;
  uploadMeasurement: Measurement<ImportNotifyInfo>;
}): Promise<Measurement<ImportBasePrimaryResult>> => {
  const startedAt = performance.now();
  const primaryResult = await importBaseStream({
    context,
    perfCase,
    spaceId,
    fixture,
    config,
    notifyInfo,
    exportMeasurement,
    uploadMeasurement,
  });

  try {
    primaryResult.verification = await verifyImportedBase(
      primaryResult.resultBaseId,
      fixture,
      config,
    );
  } catch (error) {
    const partialPrimaryMeasurement: Measurement<ImportBasePrimaryResult> = {
      name: "importBaseReady",
      durationMs: roundMetric(performance.now() - startedAt),
      result: primaryResult,
    };
    throw new PerfRunDiagnosticError(
      error instanceof Error ? error.message : String(error),
      {
        metrics: {},
        thresholds: [],
        details: {
          partialPrimaryMeasurement,
        },
      },
    );
  }

  return {
    name: "importBaseReady",
    durationMs: roundMetric(performance.now() - startedAt),
    result: primaryResult,
  };
};

const buildImportBaseResult = ({
  context,
  config,
  prepareMeasurement,
  seedReadyMeasurement,
  exportMeasurement,
  uploadMeasurement,
  primaryMeasurement,
  error,
}: {
  context?: PerfRunContext;
  config: ImportBaseCaseConfig;
  prepareMeasurement?: Measurement<ImportBaseFixture>;
  seedReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertSourceBaseReady>>
  >;
  exportMeasurement?: Measurement<unknown>;
  uploadMeasurement?: Measurement<ImportNotifyInfo>;
  primaryMeasurement?: Measurement<ImportBasePrimaryResult>;
  error?: unknown;
}): PerfRunResult => {
  const fixture = prepareMeasurement?.result;
  const primaryResult = primaryMeasurement?.result;
  const primaryMetric = getEffectiveThresholdMetric(config, context);
  const isTotalReadyMetric = primaryMetric === "importBaseTotalReadyMs";
  const fullScanReadyMs =
    primaryMeasurement && primaryResult?.verification
      ? roundMetric(primaryMeasurement.durationMs - primaryResult.requestMs)
      : undefined;

  return {
    metrics: {
      ...(prepareMeasurement
        ? { importBasePrepareMs: prepareMeasurement.durationMs }
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
      ...(exportMeasurement
        ? { prepareImportExportMs: exportMeasurement.durationMs }
        : {}),
      ...(uploadMeasurement
        ? {
            prepareImportUploadMs: uploadMeasurement.durationMs,
            uploadedBytes: uploadMeasurement.result.bytes,
          }
        : {}),
      ...(primaryMeasurement
        ? {
            [primaryMetric]: isTotalReadyMetric
              ? primaryMeasurement.durationMs
              : (primaryResult?.requestMs ?? 0),
            ...(isTotalReadyMetric && primaryResult
              ? { importBaseStreamMs: primaryResult.requestMs }
              : {}),
            ...(primaryResult?.verification
              ? {
                  importBaseFullScanReadyMs: fullScanReadyMs,
                  importBaseTotalReadyMs: primaryMeasurement.durationMs,
                }
              : {}),
          }
        : {}),
    },
    thresholds: primaryMeasurement
      ? [
          {
            metric: primaryMetric,
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
      ...(exportMeasurement
        ? [
            {
              name: exportMeasurement.name,
              durationMs: exportMeasurement.durationMs,
            },
          ]
        : []),
      ...(uploadMeasurement
        ? [
            {
              name: uploadMeasurement.name,
              durationMs: uploadMeasurement.durationMs,
            },
          ]
        : []),
      ...(primaryMeasurement
        ? [
            {
              name: primaryMetric,
              durationMs: isTotalReadyMetric
                ? primaryMeasurement.durationMs
                : (primaryResult?.requestMs ?? 0),
            },
            ...(isTotalReadyMetric && primaryResult
              ? [
                  {
                    name: "importBaseStream",
                    durationMs: primaryResult.requestMs,
                  },
                ]
              : []),
            ...(primaryResult?.verification
              ? [
                  {
                    name: "importBaseFullScanReady",
                    durationMs: fullScanReadyMs ?? 0,
                  },
                  {
                    name: "importBaseTotalReady",
                    durationMs: primaryMeasurement.durationMs,
                  },
                ]
              : []),
          ]
        : []),
    ],
    details: {
      sourceBase: fixture
        ? {
            baseId: fixture.baseId,
            baseName: fixture.baseName,
            tables: fixture.tables.map((tableRef, index) => ({
              tableId: tableRef.id,
              name: tableRef.name,
              rowCount: config.tables[index]?.rowCount,
              fieldCount: Object.keys(tableRef.fieldIdByName).length,
            })),
            workflows: {
              requested: config.workflows.count,
              seeded: fixture.workflowCount,
            },
            seedReady: seedReadyMeasurement?.result,
            cache: {
              enabled: fixture.seedCacheInfo.enabled,
              cacheHit: Boolean(fixture.seedCacheHit),
              reusable: Boolean(fixture.reusableSeed),
              seedHash: fixture.seedCacheInfo.seedHash,
              seedHashShort: fixture.seedCacheInfo.seedHashShort,
              seedBaseName: fixture.seedCacheInfo.seedTableName,
              schemaSignature: fixture.seedCacheInfo.schemaSignature,
            },
          }
        : undefined,
      import: primaryResult
        ? {
            status: primaryResult.status,
            requestMs: primaryResult.requestMs,
            baseId: primaryResult.resultBaseId,
            baseName: primaryResult.resultBaseName,
            progressEventCount: primaryResult.progressEventCount,
            doneEvent: primaryResult.doneEvent,
            responseHeaders: primaryResult.responseHeaders,
            routing: primaryResult.routing,
          }
        : undefined,
      routing: primaryResult?.routing,
      fullScan: primaryResult
        ? primaryResult.verification
          ? {
              attempts: primaryResult.verification.attempts,
              waitedMs: primaryResult.verification.waitedMs,
              tables: primaryResult.verification.tables,
            }
          : undefined
        : undefined,
      workflows: primaryResult?.verification?.workflows,
      verification: primaryResult
        ? {
            durationMs: fullScanReadyMs,
            metric: "importBaseFullScanReadyMs",
            participatesInThreshold: isTotalReadyMetric,
            checks: [
              "tableListResolved",
              "importedTablesFullScanWithSamples",
              "workflowCount(best-effort)",
            ],
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

export const runImportBaseCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as ImportBaseCaseConfig;
  const spaceId = globalThis.testConfig.spaceId;
  const thresholdMetric = getEffectiveThresholdMetric(config, context);
  let prepareMeasurement: Measurement<ImportBaseFixture> | undefined;
  let seedReadyMeasurement:
    | Measurement<Awaited<ReturnType<typeof assertSourceBaseReady>>>
    | undefined;
  let exportMeasurement: Measurement<unknown> | undefined;
  let uploadMeasurement: Measurement<ImportNotifyInfo> | undefined;
  let primaryMeasurement: Measurement<ImportBasePrimaryResult> | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareImportBaseFixture(spaceId, config, perfCase),
    );
    seedReadyMeasurement = await measureAsync("seedReady", () =>
      assertSourceBaseReady(prepareMeasurement!.result, config),
    );
    const exportSetup = await exportBaseStream(
      context,
      perfCase,
      prepareMeasurement.result,
    );
    exportMeasurement = exportSetup.measurement;
    uploadMeasurement = await measureAsync("prepareImportUpload", () =>
      buildImportNotifyFromExport(context, exportSetup.exportResult),
    );

    try {
      primaryMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        thresholdMetric,
        () =>
          measureImportBaseReady({
            context,
            perfCase,
            spaceId,
            fixture: prepareMeasurement!.result,
            config,
            notifyInfo: uploadMeasurement!.result,
            exportMeasurement: exportMeasurement!,
            uploadMeasurement: uploadMeasurement!,
          }),
      );
    } catch (error) {
      const diagnosticResult =
        error instanceof PerfRunDiagnosticError
          ? (error.result.details?.partialPrimaryMeasurement as
              | Measurement<ImportBasePrimaryResult>
              | undefined)
          : undefined;
      if (diagnosticResult) {
        primaryMeasurement = diagnosticResult;
      }
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildImportBaseResult({
          context,
          config,
          prepareMeasurement,
          seedReadyMeasurement,
          exportMeasurement,
          uploadMeasurement,
          primaryMeasurement,
          error,
        }),
      );
    }

    return buildImportBaseResult({
      context,
      config,
      prepareMeasurement,
      seedReadyMeasurement,
      exportMeasurement,
      uploadMeasurement,
      primaryMeasurement,
    });
  } finally {
    if (!isExecuteDbIsolated()) {
      // Only bases are deleted here. The intermediate export `.tea` preview file
      // and the uploaded import attachment are transient object-storage artifacts
      // with their own retention/GC and have no stable delete handle exposed to
      // this flow, so they are intentionally left to be reclaimed by storage TTL.
      if (primaryMeasurement?.result.resultBaseId) {
        try {
          await permanentDeleteBase(primaryMeasurement.result.resultBaseId);
        } catch (error) {
          console.warn(
            `Failed to cleanup imported perf base ${primaryMeasurement.result.resultBaseId}`,
            error,
          );
        }
      }

      const fixture = prepareMeasurement?.result;
      if (fixture?.baseId && !fixture.reusableSeed) {
        try {
          await permanentDeleteBase(fixture.baseId);
        } catch (error) {
          console.warn(
            `Failed to cleanup import base seed ${fixture.baseId}`,
            error,
          );
        }
      }
    }
  }
};

export const seedImportBaseCase = async (
  perfCase: PerfCase,
  _context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as ImportBaseCaseConfig;
  const spaceId = globalThis.testConfig.spaceId;
  const prepareMeasurement = await measureAsync("prepare", () =>
    prepareImportBaseFixture(spaceId, config, perfCase),
  );
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    assertSourceBaseReady(prepareMeasurement.result, config),
  );

  return buildImportBaseResult({
    config,
    prepareMeasurement,
    seedReadyMeasurement,
  });
};
