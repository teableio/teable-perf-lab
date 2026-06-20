import { FieldKeyType, FieldType } from "@teable/core";
import { readFile } from "node:fs/promises";
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
import { chunk } from "../chunk";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, roundMetric, type Measurement } from "../metrics";
import {
  assertEngineRouting,
  getRoutingResponseHeader,
  type EngineRouting,
} from "../routing";
import { forEachRecordPage } from "../record-page-scan";
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

const IMPORT_BASE_FIXTURE_VERSION = "import-base-v2-only-v2";
const IMPORT_BASE_METADATA_PREFIX = "perf-lab-import-base:";
const IMPORT_BASE_SKIPPED_REASON =
  "import-base is V2-only because the legacy V1 import path is no longer maintained and can report stream done before all imported table data is ready.";

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
  seedCacheInfo?: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
  source: "generated" | "tea-file";
  cachedNotifyInfo?: ImportNotifyInfo;
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

type BaseNodeVerification = {
  available: boolean;
  expectedAppCount?: number;
  appCount?: number;
  expectedWorkflowCount?: number;
  workflowCount?: number;
};

type TableScanResult = {
  tableId: string;
  name: string;
  fieldCount?: number;
  viewCount?: number;
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
  baseNodes?: BaseNodeVerification;
};

type ImportNotifyInfo = {
  notify: unknown;
  bytes: number;
  contentType: string;
  cacheHit?: boolean;
  source?: "export" | "export-cache" | "tea-file-upload" | "tea-file-cache";
};

type CachedImportNotify = {
  fixtureVersion: string;
  source: "export" | "tea-file";
  bytes: number;
  contentType: string;
  notify: unknown;
  teaFilePath?: string;
  fileName?: string;
  tableRowCounts?: number[];
  requestedWorkflowCount?: number;
  workflowCount?: number;
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

const getEffectiveThresholdMetric = (config: ImportBaseCaseConfig) =>
  config.threshold.metric;

const isTeaFileImportCase = (config: ImportBaseCaseConfig) =>
  Boolean(config.teaFile);

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
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: tableConfig.rowCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(tableRef.id, {
          viewId: tableRef.viewId,
          fieldKeyType: FieldKeyType.Id,
          projection: [tableRef.fieldIdByName[TITLE_FIELD]],
          skip,
          take,
        }),
      pageNoun: `records in ${tableRef.name}`,
    },
    () => {},
  );

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

const verifyBaseNodes = async (
  baseId: string,
  config: ImportBaseCaseConfig,
): Promise<BaseNodeVerification> => {
  try {
    const response = await axios.get(`/base/${baseId}/node/list`);
    const nodes = Array.isArray(response.data)
      ? (response.data as Array<{ resourceType?: string }>)
      : [];
    const appCount = nodes.filter((node) => node.resourceType === "app").length;
    const workflowCount = nodes.filter(
      (node) => node.resourceType === "workflow",
    ).length;

    if (
      config.verify.expectedAppCount != null &&
      appCount !== config.verify.expectedAppCount
    ) {
      throw new Error(
        `Expected ${config.verify.expectedAppCount} app nodes in base ${baseId}, found ${appCount}`,
      );
    }

    return {
      available: true,
      expectedAppCount: config.verify.expectedAppCount,
      appCount,
      expectedWorkflowCount: config.workflows.count,
      workflowCount,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Expected") &&
      error.message.includes("app nodes")
    ) {
      throw error;
    }
    return {
      available: false,
      expectedAppCount: config.verify.expectedAppCount,
      expectedWorkflowCount: config.workflows.count,
    };
  }
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

const parseCachedImportNotify = (
  description: string | null | undefined,
): CachedImportNotify | undefined => {
  const metadata = parseMetadata(description) as CachedImportNotify | undefined;
  if (
    metadata?.fixtureVersion !== IMPORT_BASE_FIXTURE_VERSION ||
    !metadata.source ||
    !metadata.notify
  ) {
    return;
  }
  return metadata;
};

const getSeedConfig = (config: ImportBaseCaseConfig) => ({
  spaceId: config.spaceId,
  sourceBaseNamePrefix: config.sourceBaseNamePrefix,
  teaFile: config.teaFile,
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

const assertTeaFileFixtureReady = async (
  fixture: Pick<ImportBaseFixture, "cachedNotifyInfo">,
) => {
  if (!fixture.cachedNotifyInfo?.notify) {
    throw new Error("Cached tea file import notify is missing");
  }
  return {
    cachedNotify: {
      bytes: fixture.cachedNotifyInfo.bytes,
      contentType: fixture.cachedNotifyInfo.contentType,
      cacheHit: Boolean(fixture.cachedNotifyInfo.cacheHit),
      source: fixture.cachedNotifyInfo.source,
    },
  };
};

const assertImportedStructure = async (
  importedBaseId: string,
  config: ImportBaseCaseConfig,
) => {
  const tableList = (await getTableList(importedBaseId)).data as Array<{
    id: string;
    name: string;
  }>;

  if (
    config.verify.expectedTableCount != null &&
    tableList.length !== config.verify.expectedTableCount
  ) {
    throw new Error(
      `Expected ${config.verify.expectedTableCount} imported tables, found ${tableList.length}`,
    );
  }

  const tables = await resolveTables(importedBaseId, config);
  const tableResults = [];
  for (const [index, tableConfig] of config.tables.entries()) {
    const tableRef = tables[index];
    if (!tableRef) {
      throw new Error(`Imported base is missing table ${tableConfig.name}`);
    }

    const table = await getTable(importedBaseId, tableRef.id);
    const fields = await getFields(tableRef.id);
    const views = await getViews(tableRef.id);
    if (
      tableConfig.expectedFieldCount != null &&
      fields.length !== tableConfig.expectedFieldCount
    ) {
      throw new Error(
        `${tableConfig.name} field count mismatch: expected ${tableConfig.expectedFieldCount}, actual ${fields.length}`,
      );
    }
    if (
      tableConfig.expectedViewCount != null &&
      views.length !== tableConfig.expectedViewCount
    ) {
      throw new Error(
        `${tableConfig.name} view count mismatch: expected ${tableConfig.expectedViewCount}, actual ${views.length}`,
      );
    }

    tableResults.push({
      tableId: tableRef.id,
      name: tableRef.name,
      fieldCount: fields.length,
      viewCount: views.length,
      scannedRecords: 0,
      pageCount: 0,
      samples: [],
      descriptionPresent: Boolean(table.description),
    });
  }

  return tableResults;
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
        source: "generated",
        cachedNotifyInfo: metadata.notify
          ? {
              notify: metadata.notify,
              bytes: Number(metadata.bytes ?? 0),
              contentType: String(metadata.contentType ?? "application/zip"),
              cacheHit: true,
              source: "export-cache",
            }
          : undefined,
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
      source: "generated",
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

const prepareTeaFileImportFixture = async (
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
      const tableList = (await getTableList(cachedBase.id)).data as Array<{
        id: string;
        name: string;
      }>;
      const metadataTable = tableList[0];
      if (!metadataTable) {
        throw new Error("Cached tea file import base has no metadata table");
      }
      const metadata = parseCachedImportNotify(
        (await getTable(cachedBase.id, metadataTable.id)).description,
      );
      if (
        !metadata ||
        metadata.source !== "tea-file" ||
        metadata.teaFilePath !== config.teaFile?.path ||
        metadata.fileName !== config.teaFile.fileName
      ) {
        throw new Error("Cached tea file import metadata mismatch");
      }

      return createTeaFileFixture(
        config,
        seedCacheInfo,
        {
          notify: metadata.notify,
          bytes: metadata.bytes,
          contentType: metadata.contentType,
          cacheHit: true,
          source: "tea-file-cache",
        },
        { id: cachedBase.id, name: cachedBase.name },
        true,
      );
    } catch (error) {
      console.warn(
        `Invalid cached tea file import seed ${seedCacheInfo.seedTableName}; rebuilding`,
        error,
      );
      try {
        await permanentDeleteBase(cachedBase.id);
      } catch (cleanupError) {
        console.warn(
          `Failed to delete stale tea file import seed ${cachedBase.id}`,
          cleanupError,
        );
      }
    }
  }

  const baseName = seedCacheInfo.enabled
    ? seedCacheInfo.seedTableName
    : `${config.sourceBaseNamePrefix}-tea-cache-${Date.now()}`;
  let createdBaseId = "";

  try {
    const baseResponse = await createBase({ spaceId, name: baseName });
    expect([200, 201]).toContain(baseResponse.status);
    createdBaseId = baseResponse.data.id;

    const metadataTable = await createTable(createdBaseId, {
      name: "Import Tea File Cache",
      fields: [{ name: TITLE_FIELD, type: FieldType.SingleLineText }],
      records: [],
    });
    const notifyInfo = await buildImportNotifyFromTeaFile(config, {
      baseId: createdBaseId,
      tableId: metadataTable.id,
    });

    return createTeaFileFixture(
      config,
      seedCacheInfo,
      notifyInfo,
      { id: createdBaseId, name: baseName },
      false,
    );
  } catch (error) {
    if (createdBaseId) {
      try {
        await permanentDeleteBase(createdBaseId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup incomplete tea file import seed ${createdBaseId}`,
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
      const tableResults =
        config.verify.mode === "structure-only"
          ? await assertImportedStructure(importedBaseId, config)
          : await (async () => {
              const tables = await resolveTables(importedBaseId, config);
              const results = [];
              for (const [index, tableConfig] of config.tables.entries()) {
                const tableRef = tables[index];
                if (!tableRef) {
                  throw new Error(
                    `Imported base is missing table ${tableConfig.name}`,
                  );
                }
                results.push(await scanTable(tableRef, tableConfig, config));
              }
              return results;
            })();

      const workflows = await verifyWorkflows(
        importedBaseId,
        fixture.workflowCount,
        config.workflows.namePrefix,
      );
      const baseNodes = await verifyBaseNodes(importedBaseId, config);

      return {
        attempts,
        waitedMs: Date.now() - startedAt,
        tables: {
          main: tableResults[0],
          importedTables: tableResults,
        },
        workflows,
        baseNodes,
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
    cacheHit: false,
    source: "export",
  };
};

const buildImportNotifyFromTeaFile = async (
  config: ImportBaseCaseConfig,
  persist?: {
    baseId: string;
    tableId: string;
  },
): Promise<ImportNotifyInfo> => {
  const teaFile = config.teaFile;
  if (!teaFile) {
    throw new Error("Import base teaFile config is required");
  }

  const fileUrl = new URL(`../../${teaFile.path}`, import.meta.url);
  const buffer = await readFile(fileUrl);
  const contentType = teaFile.contentType ?? "application/zip";
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
    teaFile.fileName,
  );
  expect([200, 201]).toContain(notifyResponse.status);

  const notifyInfo: ImportNotifyInfo = {
    notify: notifyResponse.data,
    bytes: buffer.length,
    contentType,
    cacheHit: false,
    source: "tea-file-upload",
  };

  if (persist) {
    await persistMetadata(persist.baseId, persist.tableId, {
      fixtureVersion: IMPORT_BASE_FIXTURE_VERSION,
      source: "tea-file",
      teaFilePath: teaFile.path,
      fileName: teaFile.fileName,
      bytes: buffer.length,
      contentType,
      notify: notifyResponse.data,
    });
  }

  return notifyInfo;
};

const cacheGeneratedImportNotify = async (
  context: PerfRunContext,
  perfCase: PerfCase,
  fixture: ImportBaseFixture,
  config: ImportBaseCaseConfig,
): Promise<{
  exportMeasurement: Measurement<unknown>;
  uploadMeasurement: Measurement<ImportNotifyInfo>;
}> => {
  if (!fixture.tables[0]?.id) {
    throw new Error("Generated import base fixture is missing metadata table");
  }

  const exportSetup = await exportBaseStream(context, perfCase, fixture);
  const uploadMeasurement = await measureAsync("prepareImportUpload", () =>
    buildImportNotifyFromExport(context, exportSetup.exportResult),
  );
  await persistMetadata(fixture.baseId, fixture.tables[0].id, {
    fixtureVersion: IMPORT_BASE_FIXTURE_VERSION,
    tableRowCounts: config.tables.map((table) => table.rowCount),
    requestedWorkflowCount: config.workflows.count,
    workflowCount: fixture.workflowCount,
    source: "export",
    notify: uploadMeasurement.result.notify,
    bytes: uploadMeasurement.result.bytes,
    contentType: uploadMeasurement.result.contentType,
  });
  fixture.cachedNotifyInfo = {
    ...uploadMeasurement.result,
    cacheHit: false,
    source: "export",
  };

  return {
    exportMeasurement: exportSetup.measurement,
    uploadMeasurement,
  };
};

const createTeaFileFixture = (
  config: ImportBaseCaseConfig,
  seedCacheInfo?: SeedCacheInfo,
  cachedNotifyInfo?: ImportNotifyInfo,
  base?: {
    id: string;
    name: string;
  },
  seedCacheHit = false,
): ImportBaseFixture => ({
  baseId: base?.id ?? "",
  baseName:
    base?.name ?? config.teaFile?.fileName ?? config.sourceBaseNamePrefix,
  tables: [],
  workflowCount: config.workflows.count,
  seedCacheInfo,
  seedCacheHit,
  reusableSeed: Boolean(seedCacheInfo?.enabled),
  source: "tea-file",
  cachedNotifyInfo,
});

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
  exportMeasurement?: Measurement<unknown>;
  uploadMeasurement: Measurement<ImportNotifyInfo>;
}): Promise<ImportBasePrimaryResult> => {
  const streamMeasurement = await measureAsync("importBaseStream", () =>
    perfStreamSse<ImportBaseStreamEvent>({
      context,
      perfCase,
      stepId: getEffectiveThresholdMetric(config),
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
      preparedExportMs: exportMeasurement?.durationMs ?? 0,
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
  exportMeasurement?: Measurement<unknown>;
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
  seedReadyMeasurement?: Measurement<unknown>;
  exportMeasurement?: Measurement<unknown>;
  uploadMeasurement?: Measurement<ImportNotifyInfo>;
  primaryMeasurement?: Measurement<ImportBasePrimaryResult>;
  error?: unknown;
}): PerfRunResult => {
  const fixture = prepareMeasurement?.result;
  const primaryResult = primaryMeasurement?.result;
  const primaryMetric = getEffectiveThresholdMetric(config);
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
            importNotifyCacheHit: uploadMeasurement.result.cacheHit ? 1 : 0,
          }
        : {}),
      ...(primaryMeasurement
        ? {
            [primaryMetric]: primaryResult?.requestMs ?? 0,
            ...(primaryResult?.verification
              ? {
                  importBaseFullScanReadyMs: fullScanReadyMs,
                  importBaseTotalReadyDiagnosticMs:
                    primaryMeasurement.durationMs,
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
              durationMs: primaryResult?.requestMs ?? 0,
            },
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
            source: fixture.source,
            teaFile: config.teaFile,
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
            cachedNotify: fixture.cachedNotifyInfo
              ? {
                  bytes: fixture.cachedNotifyInfo.bytes,
                  contentType: fixture.cachedNotifyInfo.contentType,
                  cacheHit: Boolean(fixture.cachedNotifyInfo.cacheHit),
                  source: fixture.cachedNotifyInfo.source,
                }
              : undefined,
            cache: fixture.seedCacheInfo
              ? {
                  enabled: fixture.seedCacheInfo.enabled,
                  cacheHit: Boolean(fixture.seedCacheHit),
                  reusable: Boolean(fixture.reusableSeed),
                  seedHash: fixture.seedCacheInfo.seedHash,
                  seedHashShort: fixture.seedCacheInfo.seedHashShort,
                  seedBaseName: fixture.seedCacheInfo.seedTableName,
                  schemaSignature: fixture.seedCacheInfo.schemaSignature,
                }
              : undefined,
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
            upload: uploadMeasurement
              ? {
                  bytes: uploadMeasurement.result.bytes,
                  contentType: uploadMeasurement.result.contentType,
                  cacheHit: Boolean(uploadMeasurement.result.cacheHit),
                  source: uploadMeasurement.result.source,
                }
              : undefined,
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
      baseNodes: primaryResult?.verification?.baseNodes,
      verification: primaryResult
        ? {
            durationMs: fullScanReadyMs,
            metric: "importBaseFullScanReadyMs",
            participatesInThreshold: false,
            checks: [
              "tableListResolved",
              config.verify.mode === "structure-only"
                ? "importedTablesStructure"
                : "importedTablesFullScanWithSamples",
              "baseNodeAppCount(best-effort)",
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

// Intentionally NOT on a lifecycle driver yet — deferred after audit
// (2026-06-20), not an oversight. import-base has no clean driver fit:
//
//   - It cannot ride csv-import-lifecycle.ts without rewriting that driver.
//     import-base's cleanup must delete the imported RESULT base
//     (primaryMeasurement.result.resultBaseId), but that driver's cleanup args
//     carry only prepareMeasurement; its buildResult args carry no export/upload
//     measurements; and its execute path has neither a seedReady phase nor the
//     intermediate export+upload phases import-base emits between seedReady and
//     the measured stream. csv-import imports a CSV INTO the existing base, while
//     import-base creates a WHOLE NEW base (permanentDeleteBase) — different
//     cardinality, not the same family. Generalizing csv-import-lifecycle to fit
//     would force a re-G1 of its three csv-import cases for optionality they
//     never use.
//   - A standalone one-member import-base-lifecycle.ts would be premature: a
//     lifecycle driver only earns its abstraction once a SECOND family member
//     shares its shape, and there is no second base-import-from-stream kind.
//
// So this runner stays direct until a second base-import kind gives a driver a
// real second member. Its run/seed flow is already explicit and loud-on-error,
// and the upload-must-be-rebuilt-in-execute constraint (see the prepareImportUpload
// comment below) is easier to keep correct inline than behind a driver seam.
// See tasks/runner-migration-tracker.md.
export const runImportBaseCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as ImportBaseCaseConfig;
  if (context.engine !== "v2") {
    return {
      result: "skipped",
      metrics: {},
      thresholds: [],
      details: {
        operation: "import-base",
        skipped: true,
        skippedReason: IMPORT_BASE_SKIPPED_REASON,
        requestedEngine: context.engine,
        sourceBaseNamePrefix: config.sourceBaseNamePrefix,
        tableCount: config.tables.length,
        requestedWorkflowCount: config.workflows.count,
      },
    };
  }

  const spaceId = globalThis.testConfig.spaceId;
  const thresholdMetric = getEffectiveThresholdMetric(config);
  let prepareMeasurement: Measurement<ImportBaseFixture> | undefined;
  let seedReadyMeasurement:
    | Measurement<
        | Awaited<ReturnType<typeof assertSourceBaseReady>>
        | Awaited<ReturnType<typeof assertTeaFileFixtureReady>>
      >
    | undefined;
  let exportMeasurement: Measurement<unknown> | undefined;
  let uploadMeasurement: Measurement<ImportNotifyInfo> | undefined;
  let primaryMeasurement: Measurement<ImportBasePrimaryResult> | undefined;

  try {
    if (isTeaFileImportCase(config)) {
      prepareMeasurement = await measureAsync("prepare", () =>
        prepareTeaFileImportFixture(spaceId, config, perfCase),
      );
      seedReadyMeasurement = await measureAsync("seedReady", () =>
        assertTeaFileFixtureReady(prepareMeasurement!.result),
      );
    } else {
      prepareMeasurement = await measureAsync("prepare", () =>
        prepareImportBaseFixture(spaceId, config, perfCase),
      );
      seedReadyMeasurement = await measureAsync("seedReady", () =>
        assertSourceBaseReady(prepareMeasurement!.result, config),
      );
    }

    // The seed→execute boundary only carries the PostgreSQL dump (see the
    // `seed` and `execute` jobs in .github/workflows/teable-ee-e2e-perf.yml),
    // never the backend `.assets/uploads` directory. Any import `notify` payload
    // cached in seed-phase metadata therefore points at an uploaded file that no
    // longer exists on the execute runner, so reusing it makes `import-stream`
    // fail with ENOENT and the SSE request then hangs until the case times out.
    // Always rebuild the upload here so the import reads a file that is present
    // on this runner. The export/upload cost is a diagnostic phase outside the
    // `importBaseStreamMs` threshold metric.
    if (isTeaFileImportCase(config)) {
      uploadMeasurement = await measureAsync("prepareImportUpload", () =>
        buildImportNotifyFromTeaFile(config),
      );
    } else {
      const cacheSetup = await cacheGeneratedImportNotify(
        context,
        perfCase,
        prepareMeasurement.result,
        config,
      );
      exportMeasurement = cacheSetup.exportMeasurement;
      uploadMeasurement = cacheSetup.uploadMeasurement;
    }

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
            exportMeasurement,
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
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as ImportBaseCaseConfig;
  if (isTeaFileImportCase(config)) {
    const spaceId = globalThis.testConfig.spaceId;
    const prepareMeasurement = await measureAsync("prepare", () =>
      prepareTeaFileImportFixture(spaceId, config, perfCase),
    );
    const seedReadyMeasurement = await measureAsync("seedReady", () =>
      assertTeaFileFixtureReady(prepareMeasurement.result),
    );

    return buildImportBaseResult({
      config,
      prepareMeasurement,
      seedReadyMeasurement,
    });
  }

  const spaceId = globalThis.testConfig.spaceId;
  const prepareMeasurement = await measureAsync("prepare", () =>
    prepareImportBaseFixture(spaceId, config, perfCase),
  );
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    assertSourceBaseReady(prepareMeasurement.result, config),
  );
  const cacheSetup = prepareMeasurement.result.cachedNotifyInfo
    ? undefined
    : await cacheGeneratedImportNotify(
        context,
        perfCase,
        prepareMeasurement.result,
        config,
      );

  return buildImportBaseResult({
    config,
    prepareMeasurement,
    seedReadyMeasurement,
    exportMeasurement: cacheSetup?.exportMeasurement,
    uploadMeasurement: cacheSetup?.uploadMeasurement,
  });
};
