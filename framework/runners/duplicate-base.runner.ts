import { FieldKeyType, FieldType, Relationship } from "@teable/core";
import {
  axios,
  createBase,
  createWorkflow,
  getBaseList,
  getTableList,
  permanentDeleteBase,
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
import type {
  DuplicateBaseCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordUndoRedoBaseCaseConfig,
} from "../types";
import { PerfRunDiagnosticError } from "../types";
import {
  buildRecordFields,
  undoRedoMixed20Fields,
  type Measurement,
} from "./record-undo-redo.shared";

const DUPLICATE_BASE_FIXTURE_VERSION = "duplicate-base-v1";
const DUPLICATE_BASE_METADATA_PREFIX = "perf-lab-duplicate-base:";

const LINKED_KEY_FIELD = "Key";
const LINKED_NOTE_FIELD = "Note";
const LINKED_LINK_FIELD = "Main Link";
const SMALL_FIELDS = ["Name", "Code", "Note", "Index"] as const;
const MAIN_TITLE_FIELD = "Title";
const MAIN_EXTERNAL_ID_FIELD = "External ID";

type TableRef = {
  id: string;
  name: string;
  viewId: string;
  fieldIdByName: Record<string, string>;
};

type DuplicateBaseFixture = {
  baseId: string;
  baseName: string;
  main: TableRef;
  linked: TableRef;
  small: TableRef;
  workflowCount: number;
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
};

type ScanResult = {
  scannedRecords: number;
  pageCount: number;
  recordIds: string[];
};

type LinkSample = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
  linkTargetId: string;
  linkTargetTitle: string;
  expectedTitle: string;
};

type WorkflowVerification = {
  available: boolean;
  totalCount?: number;
  prefixMatchCount?: number;
  expectedCount: number;
};

type DuplicateBaseResponse = {
  status: number;
  data: { id: string; name: string; spaceId: string };
  headers: Record<string, unknown>;
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

type DuplicateBaseDoneEvent = {
  type: "done";
  data: { id: string; name: string; spaceId: string };
};

type ExportBaseDoneEvent = {
  type: "done";
  data: {
    previewUrl: string;
    baseName: string;
    fileName: string;
  };
};

type DuplicateBaseStreamEvent =
  | BaseStreamProgressEvent
  | DuplicateBaseDoneEvent
  | BaseStreamErrorEvent;

type ExportBaseStreamEvent =
  | BaseStreamProgressEvent
  | ExportBaseDoneEvent
  | BaseStreamErrorEvent;

type DuplicateBasePrimaryResult = {
  operation: NonNullable<DuplicateBaseCaseConfig["operation"]>;
  requestMs: number;
  status: number;
  resultBaseId?: string;
  resultBaseName?: string;
  exportResult?: ExportBaseDoneEvent["data"];
  progressEventCount?: number;
  doneEvent?: unknown;
  responseHeaders: Record<string, string>;
  routing?: EngineRouting;
  verification?: Awaited<ReturnType<typeof verifyDuplicatedBase>>;
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

const getBaseOperation = (config: DuplicateBaseCaseConfig) =>
  config.operation ?? "duplicate";

const getEffectiveThresholdMetric = (config: DuplicateBaseCaseConfig) =>
  config.threshold.metric;

const summarizeProgressEvents = (events: BaseStreamProgressEvent[]) => ({
  count: events.length,
  phases: [...new Set(events.map((event) => event.phase))],
  last: events.at(-1),
});

const firstErrorMessage = (errors: BaseStreamErrorEvent[]) =>
  errors.at(-1)?.message ?? "SSE stream ended without result";

// The main table reuses the mixed 20-field deterministic generator from the
// record undo/redo seed machinery.
const mainRecordConfig = (
  config: DuplicateBaseCaseConfig,
): RecordUndoRedoBaseCaseConfig => ({
  baseId: "seed-base",
  tableNamePrefix: config.mainTable.name,
  rowCount: config.mainTable.rowCount,
  batchSize: config.mainTable.batchSize,
  fields: undoRedoMixed20Fields,
  generator: {
    type: "mixed-undo-redo",
    titlePrefix: config.mainTable.generator.titlePrefix,
    payloadPrefix: config.mainTable.generator.payloadPrefix,
    source: config.mainTable.generator.source,
  },
  verify: {
    sampleRows: config.verify.mainSampleRows,
    fullScanPageSize: config.verify.fullScanPageSize,
  },
});

const mainRowForLinkedRow = (
  linkedRowNumber: number,
  config: DuplicateBaseCaseConfig,
) =>
  (((linkedRowNumber - 1) * config.linkedTable.permutation.multiplier +
    config.linkedTable.permutation.offset) %
    config.mainTable.rowCount) +
  1;

const expectedMainTitle = (
  rowNumber: number,
  config: DuplicateBaseCaseConfig,
) => `${config.mainTable.generator.titlePrefix} ${padRowNumber(rowNumber)}`;

const expectedMainExternalId = (rowNumber: number) =>
  `UNDO-REDO-${padRowNumber(rowNumber)}`;

const expectedLinkedKey = (
  rowNumber: number,
  config: DuplicateBaseCaseConfig,
) => `${config.linkedTable.keyPrefix}-${padRowNumber(rowNumber)}`;

const linkedFieldRos = (mainTableId: string) => [
  { name: LINKED_KEY_FIELD, type: FieldType.SingleLineText },
  { name: LINKED_NOTE_FIELD, type: FieldType.SingleLineText },
  {
    name: LINKED_LINK_FIELD,
    type: FieldType.Link,
    options: {
      relationship: Relationship.ManyOne,
      foreignTableId: mainTableId,
    },
  },
];

const smallFieldRos = () => [
  { name: "Name", type: FieldType.SingleLineText },
  { name: "Code", type: FieldType.SingleLineText },
  { name: "Note", type: FieldType.SingleLineText },
  { name: "Index", type: FieldType.Number },
];

const buildTableRef = async (
  tableId: string,
  tableName: string,
  expectedFieldNames: string[],
): Promise<TableRef> => {
  const fields = await getFields(tableId);
  const fieldIdByName: Record<string, string> = {};
  for (const field of fields) {
    fieldIdByName[field.name] = field.id;
  }
  for (const name of expectedFieldNames) {
    if (!fieldIdByName[name]) {
      throw new Error(`Table ${tableName} is missing field ${name}`);
    }
  }

  const views = await getViews(tableId);
  const viewId = views[0]?.id;
  if (!viewId) {
    throw new Error(`No grid view found for table ${tableName}`);
  }

  return { id: tableId, name: tableName, viewId, fieldIdByName };
};

const resolveBaseTables = async (
  baseId: string,
  config: DuplicateBaseCaseConfig,
) => {
  const tableList = (await getTableList(baseId)).data as Array<{
    id: string;
    name: string;
  }>;
  const byName = new Map(tableList.map((table) => [table.name, table]));

  const mainTable = byName.get(config.mainTable.name);
  const linkedTable = byName.get(config.linkedTable.name);
  const smallTable = byName.get(config.smallTable.name);
  if (!mainTable || !linkedTable || !smallTable) {
    throw new Error(
      `Base ${baseId} is missing expected tables; found: ${tableList
        .map((table) => table.name)
        .join(", ")}`,
    );
  }

  return {
    main: await buildTableRef(mainTable.id, mainTable.name, [
      MAIN_TITLE_FIELD,
      MAIN_EXTERNAL_ID_FIELD,
    ]),
    linked: await buildTableRef(linkedTable.id, linkedTable.name, [
      LINKED_KEY_FIELD,
      LINKED_LINK_FIELD,
    ]),
    small: await buildTableRef(smallTable.id, smallTable.name, [
      ...SMALL_FIELDS,
    ]),
    tableCount: tableList.length,
  };
};

const scanTable = async (
  tableRef: TableRef,
  expectedRowCount: number,
  pageSize: number,
  options: { collectRecordIds?: boolean } = {},
): Promise<ScanResult> => {
  const recordIds: string[] = [];
  let scannedRecords = 0;
  let pageCount = 0;

  for (let skip = 0; skip < expectedRowCount; skip += pageSize) {
    const expectedTake = Math.min(pageSize, expectedRowCount - skip);
    const result = await getRecords(tableRef.id, {
      viewId: tableRef.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: [
        tableRef.fieldIdByName[Object.keys(tableRef.fieldIdByName)[0]],
      ],
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
    if (options.collectRecordIds) {
      for (const record of result.records) {
        recordIds.push(record.id);
      }
    }
  }

  if (scannedRecords !== expectedRowCount) {
    throw new Error(
      `Row count mismatch in ${tableRef.name}: expected ${expectedRowCount}, scanned ${scannedRecords}`,
    );
  }

  return { scannedRecords, pageCount, recordIds };
};

const assertMainSamples = async (
  mainRef: TableRef,
  config: DuplicateBaseCaseConfig,
) => {
  const titleFieldId = mainRef.fieldIdByName[MAIN_TITLE_FIELD];
  const externalIdFieldId = mainRef.fieldIdByName[MAIN_EXTERNAL_ID_FIELD];
  const verifiedSamples = [];

  for (const rowOffset of config.verify.mainSampleRows) {
    const rowNumber = rowOffset + 1;
    const result = await getRecords(mainRef.id, {
      viewId: mainRef.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: [titleFieldId, externalIdFieldId],
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(`Main sample row at offset ${rowOffset} not found`);
    }

    const actualTitle = record.fields[titleFieldId];
    const expectedTitle = expectedMainTitle(rowNumber, config);
    if (actualTitle !== expectedTitle) {
      throw new Error(
        `Main row ${rowNumber} Title mismatch: expected ${expectedTitle}, actual ${String(
          actualTitle,
        )}`,
      );
    }

    const actualExternalId = record.fields[externalIdFieldId];
    const expectedExternalId = expectedMainExternalId(rowNumber);
    if (actualExternalId !== expectedExternalId) {
      throw new Error(
        `Main row ${rowNumber} External ID mismatch: expected ${expectedExternalId}, actual ${String(
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

const assertLinkSamples = async (
  linkedRef: TableRef,
  config: DuplicateBaseCaseConfig,
  options: { requireLinkTargetIn?: Set<string> } = {},
): Promise<LinkSample[]> => {
  const keyFieldId = linkedRef.fieldIdByName[LINKED_KEY_FIELD];
  const linkFieldId = linkedRef.fieldIdByName[LINKED_LINK_FIELD];
  const samples: LinkSample[] = [];

  for (const rowOffset of config.verify.linkSampleRows) {
    const rowNumber = rowOffset + 1;
    const result = await getRecords(linkedRef.id, {
      viewId: linkedRef.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: [keyFieldId, linkFieldId],
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(`Linked sample row at offset ${rowOffset} not found`);
    }

    const actualKey = record.fields[keyFieldId];
    const expectedKey = expectedLinkedKey(rowNumber, config);
    if (actualKey !== expectedKey) {
      throw new Error(
        `Linked row ${rowNumber} Key mismatch: expected ${expectedKey}, actual ${String(
          actualKey,
        )}`,
      );
    }

    const linkValue = record.fields[linkFieldId] as
      | { id?: string; title?: string }
      | undefined;
    if (!linkValue?.id) {
      throw new Error(`Linked row ${rowNumber} has no link cell value`);
    }

    const expectedTitle = expectedMainTitle(
      mainRowForLinkedRow(rowNumber, config),
      config,
    );
    if (linkValue.title !== expectedTitle) {
      throw new Error(
        `Linked row ${rowNumber} link title mismatch: expected ${expectedTitle}, actual ${String(
          linkValue.title,
        )}`,
      );
    }

    if (
      options.requireLinkTargetIn &&
      !options.requireLinkTargetIn.has(linkValue.id)
    ) {
      throw new Error(
        `Linked row ${rowNumber} link target ${linkValue.id} is not a record of the duplicated main table`,
      );
    }

    samples.push({
      rowOffset,
      rowNumber,
      recordId: record.id,
      linkTargetId: linkValue.id,
      linkTargetTitle: String(linkValue.title),
      expectedTitle,
    });
  }

  return samples;
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
  if (!description?.startsWith(DUPLICATE_BASE_METADATA_PREFIX)) {
    return;
  }
  try {
    return JSON.parse(description.slice(DUPLICATE_BASE_METADATA_PREFIX.length));
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
    description: `${DUPLICATE_BASE_METADATA_PREFIX}${JSON.stringify(metadata)}`,
  });
};

const getDuplicateBaseSeedConfig = (config: DuplicateBaseCaseConfig) => ({
  spaceId: config.spaceId,
  mainTable: config.mainTable,
  mainFields: undoRedoMixed20Fields,
  linkedTable: config.linkedTable,
  smallTable: config.smallTable,
  workflows: config.workflows,
  verifySampleRows: {
    main: config.verify.mainSampleRows,
    link: config.verify.linkSampleRows,
  },
  fixtureVersion: DUPLICATE_BASE_FIXTURE_VERSION,
});

const assertSourceBaseReady = async (
  fixture: Pick<DuplicateBaseFixture, "main" | "linked" | "small">,
  config: DuplicateBaseCaseConfig,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const mainScan = await scanTable(
    fixture.main,
    config.mainTable.rowCount,
    pageSize,
  );
  const mainSamples = await assertMainSamples(fixture.main, config);
  const linkedScan = await scanTable(
    fixture.linked,
    config.linkedTable.rowCount,
    pageSize,
  );
  const linkSamples = await assertLinkSamples(fixture.linked, config);
  const smallScan = await scanTable(
    fixture.small,
    config.smallTable.rowCount,
    pageSize,
  );

  return {
    main: { scannedRecords: mainScan.scannedRecords, samples: mainSamples },
    linked: {
      scannedRecords: linkedScan.scannedRecords,
      linkSamples,
    },
    small: { scannedRecords: smallScan.scannedRecords },
  };
};

const seedMainTable = async (
  baseId: string,
  config: DuplicateBaseCaseConfig,
) => {
  const recordConfig = mainRecordConfig(config);
  const table = await createTable(baseId, {
    name: config.mainTable.name,
    fields: undoRedoMixed20Fields,
    records: [],
  });

  const records = Array.from(
    { length: config.mainTable.rowCount },
    (_, index) => ({
      fields: buildRecordFields(recordConfig, index + 1),
    }),
  );
  const mainRecordIds: string[] = [];
  for (const batch of chunk(records, config.mainTable.batchSize)) {
    const response = await createRecords(table.id, {
      fieldKeyType: FieldKeyType.Name,
      typecast: true,
      records: batch,
    });
    for (const record of response.records) {
      mainRecordIds.push(record.id);
    }
  }

  return { tableId: table.id, mainRecordIds };
};

const seedLinkedTable = async (
  baseId: string,
  mainTableId: string,
  mainRecordIds: string[],
  config: DuplicateBaseCaseConfig,
) => {
  const table = await createTable(baseId, {
    name: config.linkedTable.name,
    fields: linkedFieldRos(mainTableId),
    records: [],
  });

  const records = Array.from(
    { length: config.linkedTable.rowCount },
    (_, index) => {
      const rowNumber = index + 1;
      const mainRowNumber = mainRowForLinkedRow(rowNumber, config);
      const mainRecordId = mainRecordIds[mainRowNumber - 1];
      if (!mainRecordId) {
        throw new Error(
          `No main record id for linked row ${rowNumber} -> main row ${mainRowNumber}`,
        );
      }
      return {
        fields: {
          [LINKED_KEY_FIELD]: expectedLinkedKey(rowNumber, config),
          [LINKED_NOTE_FIELD]: `${config.linkedTable.keyPrefix}-note-${padRowNumber(
            rowNumber,
          )}`,
          [LINKED_LINK_FIELD]: { id: mainRecordId },
        },
      };
    },
  );
  for (const batch of chunk(records, config.linkedTable.batchSize)) {
    await createRecords(table.id, {
      fieldKeyType: FieldKeyType.Name,
      typecast: true,
      records: batch,
    });
  }

  return { tableId: table.id };
};

const seedSmallTable = async (
  baseId: string,
  config: DuplicateBaseCaseConfig,
) => {
  const table = await createTable(baseId, {
    name: config.smallTable.name,
    fields: smallFieldRos(),
    records: [],
  });

  const records = Array.from(
    { length: config.smallTable.rowCount },
    (_, index) => {
      const rowNumber = index + 1;
      const padded = padRowNumber(rowNumber);
      return {
        fields: {
          Name: `${config.smallTable.valuePrefix}-name-${padded}`,
          Code: `${config.smallTable.valuePrefix}-code-${padded}`,
          Note: `${config.smallTable.valuePrefix}-note-${padded}`,
          Index: rowNumber,
        },
      };
    },
  );
  await createRecords(table.id, {
    fieldKeyType: FieldKeyType.Name,
    typecast: true,
    records,
  });

  return { tableId: table.id };
};

// Workflow creation is best-effort: the automation module is an EE feature
// and may be absent from the runtime; the seeded count is persisted in the
// fixture metadata so verification expects exactly what exists.
const seedWorkflows = async (
  baseId: string,
  config: DuplicateBaseCaseConfig,
) => {
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

const prepareDuplicateBaseFixture = async (
  spaceId: string,
  config: DuplicateBaseCaseConfig,
  perfCase: PerfCase,
): Promise<DuplicateBaseFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "duplicate-base",
    fixtureVersion: DUPLICATE_BASE_FIXTURE_VERSION,
    seedConfig: getDuplicateBaseSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("./record-undo-redo.shared.ts", import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });

  const cachedBase =
    seedCacheInfo.enabled &&
    (await findCachedSourceBase(spaceId, seedCacheInfo.seedTableName));

  if (cachedBase) {
    try {
      const tables = await resolveBaseTables(cachedBase.id, config);
      const mainMeta = await getTable(cachedBase.id, tables.main.id);
      const metadata = parseMetadata(mainMeta.description);
      if (
        !metadata ||
        metadata.fixtureVersion !== DUPLICATE_BASE_FIXTURE_VERSION ||
        metadata.mainRowCount !== config.mainTable.rowCount ||
        metadata.linkedRowCount !== config.linkedTable.rowCount ||
        metadata.smallRowCount !== config.smallTable.rowCount ||
        metadata.requestedWorkflowCount !== config.workflows.count
      ) {
        throw new Error("Cached duplicate base metadata mismatch");
      }
      const fixture: DuplicateBaseFixture = {
        baseId: cachedBase.id,
        baseName: cachedBase.name,
        main: tables.main,
        linked: tables.linked,
        small: tables.small,
        workflowCount: Number(metadata.workflowCount ?? 0),
        seedCacheInfo,
        seedCacheHit: true,
        reusableSeed: true,
      };
      await assertSourceBaseReady(fixture, config);
      return fixture;
    } catch (error) {
      console.warn(
        `Invalid cached duplicate base seed ${seedCacheInfo.seedTableName}; rebuilding`,
        error,
      );
      try {
        await permanentDeleteBase(cachedBase.id);
      } catch (cleanupError) {
        console.warn(
          `Failed to delete stale duplicate base seed ${cachedBase.id}`,
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

    const main = await seedMainTable(createdBaseId, config);
    await seedLinkedTable(
      createdBaseId,
      main.tableId,
      main.mainRecordIds,
      config,
    );
    await seedSmallTable(createdBaseId, config);
    const workflowCount = await seedWorkflows(createdBaseId, config);

    await persistMetadata(createdBaseId, main.tableId, {
      fixtureVersion: DUPLICATE_BASE_FIXTURE_VERSION,
      mainRowCount: config.mainTable.rowCount,
      linkedRowCount: config.linkedTable.rowCount,
      smallRowCount: config.smallTable.rowCount,
      requestedWorkflowCount: config.workflows.count,
      workflowCount,
    });

    const tables = await resolveBaseTables(createdBaseId, config);
    const fixture: DuplicateBaseFixture = {
      baseId: createdBaseId,
      baseName,
      main: tables.main,
      linked: tables.linked,
      small: tables.small,
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
          `Failed to cleanup incomplete duplicate base seed ${createdBaseId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const verifyDuplicatedBase = async (
  duplicateBaseId: string,
  fixture: DuplicateBaseFixture,
  config: DuplicateBaseCaseConfig,
) => {
  const timeoutMs = config.verify.timeoutMs ?? 180_000;
  const pollIntervalMs = config.verify.pollIntervalMs ?? 2_000;
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const startedAt = Date.now();
  let attempts = 0;
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    try {
      const tables = await resolveBaseTables(duplicateBaseId, config);

      // Link remap proof part 1: the duplicated link field must point at the
      // duplicated main table, not the source main table.
      const dupLinkedFields = await getFields(tables.linked.id);
      const dupLinkField = dupLinkedFields.find(
        (field) => field.name === LINKED_LINK_FIELD,
      );
      const foreignTableId = (
        dupLinkField?.options as { foreignTableId?: string } | undefined
      )?.foreignTableId;
      if (foreignTableId !== tables.main.id) {
        throw new Error(
          `Duplicated link field points at ${String(
            foreignTableId,
          )}, expected duplicated main table ${tables.main.id}`,
        );
      }
      if (foreignTableId === fixture.main.id) {
        throw new Error(
          "Duplicated link field still points at the source main table",
        );
      }

      const mainScan = await scanTable(
        tables.main,
        config.mainTable.rowCount,
        pageSize,
        { collectRecordIds: true },
      );
      const mainSamples = await assertMainSamples(tables.main, config);
      const dupMainRecordIds = new Set(mainScan.recordIds);

      const linkedScan = await scanTable(
        tables.linked,
        config.linkedTable.rowCount,
        pageSize,
      );
      // Link remap proof part 2: sampled link cells resolve to records that
      // exist inside the duplicated main table with the expected titles.
      const linkSamples = await assertLinkSamples(tables.linked, config, {
        requireLinkTargetIn: dupMainRecordIds,
      });

      const smallScan = await scanTable(
        tables.small,
        config.smallTable.rowCount,
        pageSize,
      );

      const workflows = await verifyWorkflows(
        duplicateBaseId,
        fixture.workflowCount,
        config.workflows.namePrefix,
      );

      return {
        attempts,
        waitedMs: Date.now() - startedAt,
        tables: {
          main: {
            tableId: tables.main.id,
            scannedRecords: mainScan.scannedRecords,
            pageCount: mainScan.pageCount,
            samples: mainSamples,
          },
          linked: {
            tableId: tables.linked.id,
            scannedRecords: linkedScan.scannedRecords,
            linkFieldForeignTableId: foreignTableId,
            linkRemapProven: true,
            linkSamples,
          },
          small: {
            tableId: tables.small.id,
            scannedRecords: smallScan.scannedRecords,
          },
        },
        workflows,
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
    `Duplicated base did not become ready within ${timeoutMs}ms after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

const duplicateBaseStreamAndVerify = async (
  context: PerfRunContext,
  perfCase: PerfCase,
  spaceId: string,
  fixture: DuplicateBaseFixture,
  config: DuplicateBaseCaseConfig,
  onResultBaseCreated?: (baseId: string) => void,
): Promise<DuplicateBasePrimaryResult> => {
  const duplicateName = `${config.duplicate.namePrefix}-stream-${Date.now()}`;
  const streamMeasurement = await measureAsync("duplicateBaseStream", () =>
    perfStreamSse<DuplicateBaseStreamEvent>({
      context,
      perfCase,
      stepId: config.threshold.metric,
      url: `${axios.defaults.baseURL || "/api"}/base/duplicate-stream`,
      method: "POST",
      headers: getStreamHeaders(context),
      body: JSON.stringify({
        fromBaseId: fixture.baseId,
        spaceId,
        withRecords: config.duplicate.withRecords,
        name: duplicateName,
      }),
      errorPrefix: "Duplicate base stream failed",
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
    (event): event is DuplicateBaseDoneEvent => event.type === "done",
  );

  if (!done) {
    throw new Error(firstErrorMessage(errors));
  }
  expect(errors).toHaveLength(0);

  const routing = assertEngineRouting(context, sseResult.headers, {
    feature: "duplicateBase",
    operation: "duplicateBaseStream",
  });
  // Report the created base id before verification so the caller can still clean
  // it up if verifyDuplicatedBase throws (otherwise the duplicated base leaks in
  // non-isolated runs, since the failed measurement never surfaces resultBaseId).
  onResultBaseCreated?.(done.data.id);
  const verification = await verifyDuplicatedBase(
    done.data.id,
    fixture,
    config,
  );

  return {
    operation: "duplicate-stream",
    requestMs: streamMeasurement.durationMs,
    status: sseResult.status,
    resultBaseId: done.data.id,
    resultBaseName: done.data.name,
    progressEventCount: progressEvents.length,
    doneEvent: done,
    responseHeaders: pickResponseHeaders(sseResult.headers),
    routing,
    verification,
  };
};

const exportBaseStream = async (
  context: PerfRunContext,
  perfCase: PerfCase,
  fixture: DuplicateBaseFixture,
  config: DuplicateBaseCaseConfig,
): Promise<DuplicateBasePrimaryResult> => {
  const url = axios.getUri({
    baseURL: axios.defaults.baseURL || "/api",
    url: `/base/${fixture.baseId}/export-stream`,
    params: { includeData: true },
  });
  const streamMeasurement = await measureAsync("exportBaseStream", () =>
    perfStreamSse<ExportBaseStreamEvent>({
      context,
      perfCase,
      stepId: config.threshold.metric,
      url,
      method: "GET",
      headers: getStreamHeaders(context),
      errorPrefix: "Export base stream failed",
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
    operation: "export-stream",
    requestMs: streamMeasurement.durationMs,
    status: sseResult.status,
    exportResult: done.data,
    progressEventCount: progressEvents.length,
    doneEvent: done,
    responseHeaders: pickResponseHeaders(sseResult.headers),
  };
};

const duplicateBaseAndVerify = async (
  context: PerfRunContext,
  spaceId: string,
  fixture: DuplicateBaseFixture,
  config: DuplicateBaseCaseConfig,
  onResultBaseCreated?: (baseId: string) => void,
): Promise<DuplicateBasePrimaryResult> => {
  const duplicateName = `${config.duplicate.namePrefix}-${Date.now()}`;
  const duplicateMeasurement = await measureAsync(
    "duplicateRequest",
    async () => {
      const response = (await axios.post(`/base/duplicate`, {
        fromBaseId: fixture.baseId,
        spaceId,
        withRecords: config.duplicate.withRecords,
        name: duplicateName,
      })) as DuplicateBaseResponse;
      expect([200, 201]).toContain(response.status);
      return response;
    },
  );
  const responseHeaders = pickResponseHeaders(
    duplicateMeasurement.result.headers,
  );
  const routing = assertEngineRouting(context, responseHeaders, {
    feature: "duplicateBase",
    operation: "duplicateBase",
  });

  const duplicateBaseId = duplicateMeasurement.result.data.id;
  // See duplicateBaseStreamAndVerify: surface the id before verification so a
  // verification failure does not leak the duplicated base.
  onResultBaseCreated?.(duplicateBaseId);
  const verification = await verifyDuplicatedBase(
    duplicateBaseId,
    fixture,
    config,
  );

  return {
    operation: "duplicate",
    requestMs: duplicateMeasurement.durationMs,
    status: duplicateMeasurement.result.status,
    resultBaseId: duplicateBaseId,
    resultBaseName: duplicateMeasurement.result.data.name,
    responseHeaders,
    routing,
    verification,
  };
};

const executeBaseOperation = async (
  context: PerfRunContext,
  perfCase: PerfCase,
  spaceId: string,
  fixture: DuplicateBaseFixture,
  config: DuplicateBaseCaseConfig,
  onResultBaseCreated?: (baseId: string) => void,
): Promise<DuplicateBasePrimaryResult> => {
  const operation = getBaseOperation(config);
  switch (operation) {
    case "duplicate":
      return duplicateBaseAndVerify(
        context,
        spaceId,
        fixture,
        config,
        onResultBaseCreated,
      );
    case "duplicate-stream":
      return duplicateBaseStreamAndVerify(
        context,
        perfCase,
        spaceId,
        fixture,
        config,
        onResultBaseCreated,
      );
    case "export-stream":
      // Export creates no new base, so there is nothing to register for cleanup.
      return exportBaseStream(context, perfCase, fixture, config);
  }
};

const buildDuplicateBaseCaseResult = ({
  context,
  config,
  prepareMeasurement,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  context?: PerfRunContext;
  config: DuplicateBaseCaseConfig;
  prepareMeasurement?: Measurement<DuplicateBaseFixture>;
  seedReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertSourceBaseReady>>
  >;
  primaryMeasurement?: Measurement<DuplicateBasePrimaryResult>;
  error?: unknown;
}): PerfRunResult => {
  const fixture = prepareMeasurement?.result;
  const primaryResult = primaryMeasurement?.result;
  const routing = primaryResult?.routing;
  const primaryMetric = getEffectiveThresholdMetric(config);
  const isTotalReadyMetric = primaryMetric.endsWith("TotalReadyMs");
  const fullScanReadyMs =
    primaryMeasurement && primaryResult?.verification
      ? roundMetric(primaryMeasurement.durationMs - primaryResult.requestMs)
      : undefined;

  return {
    metrics: {
      ...(prepareMeasurement
        ? { duplicateBasePrepareMs: prepareMeasurement.durationMs }
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
            [primaryMetric]: isTotalReadyMetric
              ? primaryMeasurement.durationMs
              : (primaryResult?.requestMs ?? 0),
            ...(isTotalReadyMetric && primaryResult
              ? { duplicateBaseStreamMs: primaryResult.requestMs }
              : {}),
            ...(primaryResult?.verification
              ? {
                  duplicateBaseFullScanReadyMs: fullScanReadyMs,
                  duplicateBaseTotalReadyMs: primaryMeasurement.durationMs,
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
      ...(primaryMeasurement
        ? [
            {
              name: primaryMetric,
              durationMs: isTotalReadyMetric
                ? primaryMeasurement.durationMs
                : (primaryResult?.requestMs ?? 0),
            },
            ...(primaryResult?.verification
              ? [
                  ...(isTotalReadyMetric && primaryResult
                    ? [
                        {
                          name: "duplicateBaseStream",
                          durationMs: primaryResult.requestMs,
                        },
                      ]
                    : []),
                  {
                    name: "duplicateBaseFullScanReady",
                    durationMs: fullScanReadyMs ?? 0,
                  },
                  {
                    name: "duplicateBaseTotalReady",
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
            tables: {
              main: {
                tableId: fixture.main.id,
                name: fixture.main.name,
                rowCount: config.mainTable.rowCount,
                fieldCount: Object.keys(fixture.main.fieldIdByName).length,
              },
              linked: {
                tableId: fixture.linked.id,
                name: fixture.linked.name,
                rowCount: config.linkedTable.rowCount,
                linkPermutation: config.linkedTable.permutation,
              },
              small: {
                tableId: fixture.small.id,
                name: fixture.small.name,
                rowCount: config.smallTable.rowCount,
              },
            },
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
      duplicate: primaryResult
        ? {
            operation: primaryResult.operation,
            status: primaryResult.status,
            requestMs: primaryResult.requestMs,
            baseId: primaryResult.resultBaseId,
            baseName: primaryResult.resultBaseName,
            withRecords: config.duplicate.withRecords,
            requestOnlyPrimaryMetric: primaryResult.operation === "duplicate",
            progressEventCount: primaryResult.progressEventCount,
            doneEvent: primaryResult.doneEvent,
            exportResult: primaryResult.exportResult,
            responseHeaders: primaryResult.responseHeaders,
            routing,
          }
        : undefined,
      routing,
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
        ? primaryResult.verification
          ? {
              durationMs: fullScanReadyMs,
              metric: "duplicateBaseFullScanReadyMs",
              participatesInThreshold: isTotalReadyMetric,
              checks: [
                "tableListResolved",
                "mainFullScanWithSamples",
                "linkFieldForeignTableRemap",
                "linkSampleTargetsInDuplicatedMain",
                "smallTableCountScan",
                "workflowCount(best-effort)",
              ],
            }
          : undefined
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

export const runDuplicateBaseCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as DuplicateBaseCaseConfig;
  const spaceId = globalThis.testConfig.spaceId;
  const thresholdMetric = getEffectiveThresholdMetric(config);
  let prepareMeasurement: Measurement<DuplicateBaseFixture> | undefined;
  let seedReadyMeasurement:
    | Measurement<Awaited<ReturnType<typeof assertSourceBaseReady>>>
    | undefined;
  let primaryMeasurement: Measurement<DuplicateBasePrimaryResult> | undefined;
  // Captured as soon as a result base is created, so the finally block can clean
  // it up even when post-create verification throws (primaryMeasurement stays
  // undefined in that path).
  let createdResultBaseId: string | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareDuplicateBaseFixture(spaceId, config, perfCase),
    );
    seedReadyMeasurement = await measureAsync("seedReady", () =>
      assertSourceBaseReady(prepareMeasurement!.result, config),
    );

    try {
      primaryMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        thresholdMetric,
        () =>
          measureAsync(`${getBaseOperation(config)}Ready`, () =>
            executeBaseOperation(
              context,
              perfCase,
              spaceId,
              prepareMeasurement!.result,
              config,
              (baseId) => {
                createdResultBaseId = baseId;
              },
            ),
          ),
      );
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildDuplicateBaseCaseResult({
          context,
          config,
          prepareMeasurement,
          seedReadyMeasurement,
          primaryMeasurement,
          error,
        }),
      );
    }

    return buildDuplicateBaseCaseResult({
      context,
      config,
      prepareMeasurement,
      seedReadyMeasurement,
      primaryMeasurement,
    });
  } finally {
    // CI execute jobs run on an isolated restored copy of the seed dump, so
    // the mutated database is simply discarded after the job.
    if (!isExecuteDbIsolated()) {
      // For export-stream the only side effect is a transient `.tea` preview file
      // in object storage (no result base); it is left to storage TTL/GC since no
      // stable delete handle is exposed here. duplicate/duplicate-stream create a
      // real base, cleaned up below.
      const resultBaseId =
        primaryMeasurement?.result.resultBaseId ?? createdResultBaseId;
      if (resultBaseId) {
        try {
          await permanentDeleteBase(resultBaseId);
        } catch (error) {
          console.warn(
            `Failed to cleanup perf result base ${resultBaseId}`,
            error,
          );
        }
      }

      const fixture = prepareMeasurement?.result;
      if (fixture?.baseId && !fixture.reusableSeed) {
        try {
          await permanentDeleteBase(fixture.baseId);
        } catch (error) {
          console.warn(`Failed to cleanup perf base ${fixture.baseId}`, error);
        }
      }
    }
  }
};

export const seedDuplicateBaseCase = async (
  perfCase: PerfCase,
  _context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as DuplicateBaseCaseConfig;
  const spaceId = globalThis.testConfig.spaceId;
  const prepareMeasurement = await measureAsync("prepare", () =>
    prepareDuplicateBaseFixture(spaceId, config, perfCase),
  );
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    assertSourceBaseReady(prepareMeasurement.result, config),
  );

  return buildDuplicateBaseCaseResult({
    config,
    prepareMeasurement,
    seedReadyMeasurement,
  });
};
