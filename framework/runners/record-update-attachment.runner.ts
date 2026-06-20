import { FieldKeyType, FieldType } from "@teable/core";
import {
  updateRecords,
  updateTableDescription,
  uploadAttachment,
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
import {
  getPositiveIntegerEnv,
  getPrimaryThresholdMs,
  isExecuteDbIsolated,
} from "../env";
import {
  measureAsync,
  roundMetric,
  summarizeDurations,
  type Measurement,
} from "../metrics";
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
import { chunk } from "../chunk";
import { forEachRecordPage } from "../record-page-scan";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordUpdateAttachmentCaseConfig,
} from "../types";
import {
  runRecordMutationLifecycle,
  seedRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

const ATTACHMENT_FIXTURE_VERSION = "record-update-attachment-v1";
const ATTACHMENT_METADATA_PREFIX = "perf-lab-record-update-attachment:";

type NamedField = { id: string; name: string; type?: string };

type SeededRecord = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
};

type UploadedAttachment = {
  token: string;
  name: string;
  id?: string;
  size?: number;
  mimetype?: string;
};

type AttachmentFixture = {
  tableId: string;
  tableName: string;
  viewId: string;
  titleFieldId: string;
  attachmentFieldId: string;
  seededRecords: SeededRecord[];
  seedBatchDurations: number[];
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
  // Parked by the measured operation (the execute-only attachment upload), read
  // by buildResult so the unmeasured upload cost is still reported even on the
  // diagnostic path when a later step throws.
  uploadSetupMs?: number;
};

type AttachmentPrimaryResult = {
  summary: ReturnType<typeof summarizeDurations>;
  samples: number;
  warmupUpdateMs: number;
  requestedRecords: number;
  updatedRecords: number;
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
  expectedTokens: string[];
  verified?: { checkedRecords: number };
  verifyUpdatedMs?: number;
  fullScan?: { scannedRecords: number; pageSize: number; pageCount: number };
};

const titleForRow = (
  config: RecordUpdateAttachmentCaseConfig,
  rowNumber: number,
) => `${config.generator.titlePrefix} ${rowNumber}`;

const parseTitleRowNumber = (
  value: unknown,
  config: RecordUpdateAttachmentCaseConfig,
) => {
  const prefix = `${config.generator.titlePrefix} `;
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error(
      `Expected Title "${prefix}<rowNumber>", got ${String(value)}`,
    );
  }
  const rowNumber = Number(value.slice(prefix.length));
  if (!Number.isInteger(rowNumber)) {
    throw new Error(
      `Expected integer row number in Title, got ${String(value)}`,
    );
  }
  return rowNumber;
};

const resolveNamedField = (fields: NamedField[], fieldName: string) => {
  const field = fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw new Error(
      `Missing field ${fieldName}; available fields: ${fields
        .map(({ name }) => name)
        .join(", ")}`,
    );
  }
  return field;
};

const isEmptyAttachmentCell = (value: unknown) =>
  value == null || (Array.isArray(value) && value.length === 0);

const getAttachmentSeedConfig = (config: RecordUpdateAttachmentCaseConfig) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  attachmentFieldName: config.attachmentFieldName,
  generator: config.generator,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: ATTACHMENT_FIXTURE_VERSION,
});

type CachedAttachmentSeed = {
  fixtureVersion: string;
  rowCount: number;
  attachmentFieldName: string;
  seededRecordIds: string[];
};

const parseCachedAttachmentSeed = (
  description: string | null | undefined,
): CachedAttachmentSeed | undefined => {
  if (!description?.startsWith(ATTACHMENT_METADATA_PREFIX)) {
    return;
  }
  try {
    return JSON.parse(
      description.slice(ATTACHMENT_METADATA_PREFIX.length),
    ) as CachedAttachmentSeed;
  } catch {
    return;
  }
};

const persistCachedAttachmentSeed = async (
  baseId: string,
  tableId: string,
  metadata: CachedAttachmentSeed,
) => {
  await updateTableDescription(baseId, tableId, {
    description: `${ATTACHMENT_METADATA_PREFIX}${JSON.stringify(metadata)}`,
  });
};

// Seed-ready: titles correct, row count exact, and the attachment column empty
// (a crashed prior run that left attachments behind fails this and rebuilds).
const assertSeedSamples = async (
  fixture: AttachmentFixture,
  config: RecordUpdateAttachmentCaseConfig,
) => {
  const verifiedSamples = [];
  for (const rowOffset of config.verify.sampleRows) {
    const seededRecord = fixture.seededRecords[rowOffset];
    if (!seededRecord) {
      throw new Error(
        `Missing seeded record metadata at row offset ${rowOffset}`,
      );
    }
    const result = await getRecords(fixture.tableId, {
      viewId: fixture.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: [fixture.titleFieldId, fixture.attachmentFieldId],
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(`Missing seed sample at row offset ${rowOffset}`);
    }
    if (record.id !== seededRecord.recordId) {
      throw new Error(
        `Seed sample row ${seededRecord.rowNumber} record id mismatch: expected ${seededRecord.recordId}, got ${record.id}`,
      );
    }
    if (
      parseTitleRowNumber(record.fields[fixture.titleFieldId], config) !==
      seededRecord.rowNumber
    ) {
      throw new Error(`Seed sample row title mismatch at offset ${rowOffset}`);
    }
    if (!isEmptyAttachmentCell(record.fields[fixture.attachmentFieldId])) {
      throw new Error(
        `Seed sample row ${seededRecord.rowNumber} attachment cell not empty (leftover from a prior run?)`,
      );
    }
    verifiedSamples.push({ rowOffset, rowNumber: seededRecord.rowNumber });
  }
  return { checkedRecords: verifiedSamples.length, verifiedSamples };
};

const prepareAttachmentFixture = async (
  baseId: string,
  tableName: string,
  config: RecordUpdateAttachmentCaseConfig,
  perfCase: PerfCase,
): Promise<AttachmentFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "record-update-attachment",
    fixtureVersion: ATTACHMENT_FIXTURE_VERSION,
    seedConfig: getAttachmentSeedConfig(config) as never,
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });

  const actualTableName = seedCacheInfo.enabled
    ? seedCacheInfo.seedTableName
    : tableName;

  if (seedCacheInfo.enabled) {
    const cachedTable = await findSeedTable(baseId, actualTableName);
    if (cachedTable) {
      try {
        const fields = (await getFields(cachedTable.id)) as NamedField[];
        const titleField = resolveNamedField(fields, "Title");
        const attachmentField = resolveNamedField(
          fields,
          config.attachmentFieldName,
        );
        if (attachmentField.type !== FieldType.Attachment) {
          throw new Error(
            `Cached attachment field ${config.attachmentFieldName} has type ${attachmentField.type}`,
          );
        }
        const views = await getViews(cachedTable.id);
        const viewId = views[0]?.id;
        if (!viewId) {
          throw new Error(
            `No grid view found for cached attachment host ${actualTableName}`,
          );
        }
        const tableMeta = await getTable(baseId, cachedTable.id);
        const cachedSeed = parseCachedAttachmentSeed(tableMeta.description);
        if (
          !cachedSeed ||
          cachedSeed.fixtureVersion !== ATTACHMENT_FIXTURE_VERSION ||
          cachedSeed.rowCount !== config.rowCount ||
          cachedSeed.attachmentFieldName !== config.attachmentFieldName ||
          cachedSeed.seededRecordIds.length !== config.rowCount
        ) {
          throw new Error(
            `Missing or stale cached attachment seed metadata for ${actualTableName}`,
          );
        }
        const fixture: AttachmentFixture = {
          tableId: cachedTable.id,
          tableName: cachedTable.name,
          viewId,
          titleFieldId: titleField.id,
          attachmentFieldId: attachmentField.id,
          seededRecords: cachedSeed.seededRecordIds.map((recordId, index) => ({
            rowOffset: index,
            rowNumber: index + 1,
            recordId,
          })),
          seedBatchDurations: [0],
          seedCacheInfo,
          seedCacheHit: true,
          reusableSeed: true,
        };
        await assertSeedSamples(fixture, config);
        return fixture;
      } catch (error) {
        console.warn(
          `Invalid cached attachment seed ${actualTableName}; rebuilding`,
          error,
        );
        await permanentDeleteTable(baseId, cachedTable.id);
      }
    }
  }

  let createdTableId = "";
  try {
    const table = await createTable(baseId, {
      name: actualTableName,
      fields: [
        { name: "Title", type: FieldType.SingleLineText },
        { name: config.attachmentFieldName, type: FieldType.Attachment },
      ],
      records: [],
    });
    createdTableId = table.id;
    const fields = (await getFields(table.id)) as NamedField[];
    const titleField = resolveNamedField(fields, "Title");
    const attachmentField = resolveNamedField(
      fields,
      config.attachmentFieldName,
    );
    const views = await getViews(table.id);
    const viewId = views[0]?.id;
    if (!viewId) {
      throw new Error(
        `No grid view found for attachment host ${actualTableName}`,
      );
    }

    const records = Array.from({ length: config.rowCount }, (_, index) => ({
      rowOffset: index,
      rowNumber: index + 1,
      record: { fields: { Title: titleForRow(config, index + 1) } },
    }));
    const seededRecords: SeededRecord[] = [];
    const seedBatchDurations: number[] = [];
    for (const batch of chunk(records, config.batchSize)) {
      const batchMeasurement = await measureAsync("seedBatch", () =>
        createRecords(table.id, {
          fieldKeyType: FieldKeyType.Name,
          typecast: true,
          records: batch.map((item) => item.record),
        }),
      );
      seedBatchDurations.push(batchMeasurement.durationMs);
      expect(batchMeasurement.result.records).toHaveLength(batch.length);
      batchMeasurement.result.records.forEach((record, index) => {
        const input = batch[index];
        if (input) {
          seededRecords.push({
            rowOffset: input.rowOffset,
            rowNumber: input.rowNumber,
            recordId: record.id,
          });
        }
      });
    }

    await persistCachedAttachmentSeed(baseId, table.id, {
      fixtureVersion: ATTACHMENT_FIXTURE_VERSION,
      rowCount: config.rowCount,
      attachmentFieldName: config.attachmentFieldName,
      seededRecordIds: seededRecords.map((record) => record.recordId),
    });

    return {
      tableId: table.id,
      tableName: actualTableName,
      viewId,
      titleFieldId: titleField.id,
      attachmentFieldId: attachmentField.id,
      seededRecords,
      seedBatchDurations,
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
          `Failed to cleanup incomplete attachment seed ${createdTableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

// Execute setup (not measured): upload the deterministic file set onto the
// first seeded record to obtain valid attachment tokens. Each token must exist
// in the attachments table for the bulk update to accept it.
const uploadAttachmentSet = async (
  fixture: AttachmentFixture,
  config: RecordUpdateAttachmentCaseConfig,
): Promise<UploadedAttachment[]> => {
  const hostRecordId = fixture.seededRecords[0]?.recordId;
  if (!hostRecordId) {
    throw new Error("No seeded record available to host uploaded attachments");
  }
  let lastCell: Array<Record<string, unknown>> = [];
  for (const attachment of config.attachments) {
    const response = await uploadAttachment(
      fixture.tableId,
      hostRecordId,
      fixture.attachmentFieldId,
      Buffer.from(attachment.content, "utf8"),
      { filename: attachment.filename, contentType: attachment.mimetype },
    );
    expect(response.status).toBe(201);
    lastCell = (response.data.fields[fixture.attachmentFieldId] ?? []) as Array<
      Record<string, unknown>
    >;
  }

  return config.attachments.map((attachment) => {
    const item = lastCell.find((entry) => entry.name === attachment.filename);
    if (!item || typeof item.token !== "string") {
      throw new Error(
        `Uploaded attachment ${attachment.filename} not found in upload response`,
      );
    }
    return {
      token: item.token,
      name: attachment.filename,
      id: typeof item.id === "string" ? item.id : undefined,
      size: typeof item.size === "number" ? item.size : undefined,
      mimetype: typeof item.mimetype === "string" ? item.mimetype : undefined,
    };
  });
};

const insertCellValue = (insertItems: UploadedAttachment[]) =>
  insertItems.map((item) => ({ token: item.token, name: item.name }));

const bulkInsertAttachments = async (
  fixture: AttachmentFixture,
  insertItems: UploadedAttachment[],
) => {
  const cellValue = insertCellValue(insertItems);
  const updates = fixture.seededRecords.map((record) => ({
    id: record.recordId,
    fields: { [fixture.attachmentFieldId]: cellValue },
  }));
  const response = await updateRecords(fixture.tableId, {
    fieldKeyType: FieldKeyType.Id,
    typecast: false,
    records: updates,
  });
  const data = response.data as unknown;
  const updatedRecords = Array.isArray(data)
    ? data.length
    : ((data as { records?: unknown[] })?.records?.length ?? 0);
  expect(response.status).toBe(200);
  expect(updatedRecords).toBe(updates.length);
  return {
    requestedRecords: updates.length,
    updatedRecords,
    responseHeaders: pickRoutingResponseHeaders(
      response.headers as Record<string, unknown>,
    ),
  };
};

const assertInsertedSample = (
  record: { fields: Record<string, unknown> },
  fixture: AttachmentFixture,
  expectedTokens: string[],
  rowNumber: number,
) => {
  const cell = record.fields[fixture.attachmentFieldId] as
    | Array<{ token?: string; name?: string }>
    | undefined;
  if (!Array.isArray(cell) || cell.length !== expectedTokens.length) {
    throw new Error(
      `Row ${rowNumber} attachment count mismatch: expected ${expectedTokens.length}, actual ${
        Array.isArray(cell) ? cell.length : "none"
      }`,
    );
  }
  const tokens = new Set(cell.map((item) => item.token));
  for (const token of expectedTokens) {
    if (!tokens.has(token)) {
      throw new Error(
        `Row ${rowNumber} missing expected attachment token ${token}`,
      );
    }
  }
};

const assertInsertedSamples = async (
  fixture: AttachmentFixture,
  config: RecordUpdateAttachmentCaseConfig,
  expectedTokens: string[],
) => {
  let checkedRecords = 0;
  for (const rowOffset of config.verify.sampleRows) {
    const seededRecord = fixture.seededRecords[rowOffset];
    if (!seededRecord) {
      throw new Error(
        `Missing seeded record metadata at row offset ${rowOffset}`,
      );
    }
    const result = await getRecords(fixture.tableId, {
      viewId: fixture.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: [fixture.attachmentFieldId],
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(`Missing inserted sample at row offset ${rowOffset}`);
    }
    assertInsertedSample(
      record,
      fixture,
      expectedTokens,
      seededRecord.rowNumber,
    );
    checkedRecords += 1;
  }
  return { checkedRecords };
};

const assertInsertedFullScan = async (
  fixture: AttachmentFixture,
  config: RecordUpdateAttachmentCaseConfig,
  expectedTokens: string[],
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.rowCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          viewId: fixture.viewId,
          fieldKeyType: FieldKeyType.Id,
          projection: [fixture.titleFieldId, fixture.attachmentFieldId],
          skip,
          take,
        }),
    },
    (record, rowNumber) => {
      assertInsertedSample(record, fixture, expectedTokens, rowNumber);
    },
  );
  if (scannedRecords !== config.rowCount) {
    throw new Error(
      `Attachment full scan count mismatch: expected ${config.rowCount}, scanned ${scannedRecords}`,
    );
  }
  return { scannedRecords, pageSize, pageCount };
};

const clearAttachmentCells = async (fixture: AttachmentFixture) => {
  const updates = fixture.seededRecords.map((record) => ({
    id: record.recordId,
    fields: { [fixture.attachmentFieldId]: null },
  }));
  const response = await updateRecords(fixture.tableId, {
    fieldKeyType: FieldKeyType.Id,
    typecast: false,
    records: updates,
  });
  expect(response.status).toBe(200);
};

const buildResult = ({
  config,
  fixture,
  prepareMeasurement,
  seedReadyMeasurement,
  uploadSetupMs,
  primaryMeasurement,
  error,
}: {
  config: RecordUpdateAttachmentCaseConfig;
  fixture?: AttachmentFixture;
  prepareMeasurement?: Measurement<AttachmentFixture>;
  seedReadyMeasurement?: Measurement<{ checkedRecords: number }>;
  uploadSetupMs?: number;
  primaryMeasurement?: Measurement<AttachmentPrimaryResult>;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    ...(prepareMeasurement ? { prepareMs: prepareMeasurement.durationMs } : {}),
    ...(fixture
      ? {
          maxSeedBatchMs: fixture.seedBatchDurations.length
            ? roundMetric(Math.max(...fixture.seedBatchDurations))
            : 0,
          seedCacheHit: fixture.seedCacheHit ? 1 : 0,
          seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
          ...(fixture.seedCacheHit
            ? { seedRestoreMs: prepareMeasurement?.durationMs ?? 0 }
            : fixture.seedCacheInfo.enabled
              ? { seedBuildMs: prepareMeasurement?.durationMs ?? 0 }
              : {}),
        }
      : {}),
    ...(seedReadyMeasurement
      ? { seedReadyMs: seedReadyMeasurement.durationMs }
      : {}),
    ...(uploadSetupMs != null
      ? { uploadSetupMs: roundMetric(uploadSetupMs) }
      : {}),
    ...(primaryMeasurement
      ? {
          [config.threshold.metric]: primaryMeasurement.durationMs,
          attachmentUpdateMinMs: primaryMeasurement.result.summary.minMs,
          attachmentUpdateP50Ms: primaryMeasurement.result.summary.p50Ms,
          attachmentUpdateMaxMs: primaryMeasurement.result.summary.maxMs,
          attachmentUpdateSamples: primaryMeasurement.result.samples,
          warmupUpdateMs: primaryMeasurement.result.warmupUpdateMs,
          ...(primaryMeasurement.result.verifyUpdatedMs != null
            ? { verifyUpdatedMs: primaryMeasurement.result.verifyUpdatedMs }
            : {}),
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
            durationMs: primaryMeasurement.durationMs,
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
  ],
  details: {
    operation: "bulk-update-attachment",
    tableId: fixture?.tableId,
    tableName: fixture?.tableName,
    viewId: fixture?.viewId,
    rowCount: config.rowCount,
    batchSize: config.batchSize,
    attachmentsPerCell: config.attachmentsPerCell,
    request: fixture
      ? {
          method: "PATCH",
          path: `/api/table/${fixture.tableId}/record`,
          fieldKeyType: "id",
          typecast: false,
          recordCount: fixture.seededRecords.length,
          attachmentFieldId: fixture.attachmentFieldId,
        }
      : undefined,
    update: primaryMeasurement
      ? {
          requestedRecords: primaryMeasurement.result.requestedRecords,
          updatedRecords: primaryMeasurement.result.updatedRecords,
          responseHeaders: primaryMeasurement.result.responseHeaders,
          expectedTokens: primaryMeasurement.result.expectedTokens,
        }
      : undefined,
    routing: primaryMeasurement?.result.routing,
    sampleVerification: primaryMeasurement?.result.verified,
    fullScan: primaryMeasurement?.result.fullScan,
    seed: fixture
      ? {
          seededRecords: fixture.seededRecords.length,
          batchCount: fixture.seedBatchDurations.length,
          ready: seedReadyMeasurement?.result,
          cache: {
            enabled: fixture.seedCacheInfo.enabled,
            cacheHit: fixture.seedCacheHit,
            reusable: fixture.reusableSeed,
            seedHash: fixture.seedCacheInfo.seedHash,
            seedHashShort: fixture.seedCacheInfo.seedHashShort,
            seedTableName: fixture.seedCacheInfo.seedTableName,
            schemaSignature: fixture.seedCacheInfo.schemaSignature,
          },
        }
      : undefined,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message }
        : undefined,
  },
});

// The single measured operation, run inside the driver's execute path only:
// upload tokens (execute-only setup) -> warmup -> p95-sampled bulk
// attachment-cell update -> routing assertion -> post-update verification + full
// scan, bundled into one synthetic primary measurement whose p95 duration is the
// primary metric. The attachment tokens MUST be uploaded here (execute), never
// seeded: the seed->execute cache carries only the DB dump, not the storage
// volume, so a cached token would 404 on the execute runner. uploadSetupMs is
// parked on the (mutable) fixture so buildResult still reports it even when a
// later step throws (the diagnostic path).
const runAttachmentMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: RecordUpdateAttachmentCaseConfig,
  fixture: AttachmentFixture,
): Promise<Measurement<AttachmentPrimaryResult>> => {
  const uploadMeasurement = await measureAsync("uploadSetup", () =>
    uploadAttachmentSet(fixture, config),
  );
  fixture.uploadSetupMs = uploadMeasurement.durationMs;
  const insertItems = uploadMeasurement.result.slice(
    0,
    config.attachmentsPerCell,
  );
  if (insertItems.length !== config.attachmentsPerCell) {
    throw new Error(
      `Uploaded ${uploadMeasurement.result.length} attachments, need ${config.attachmentsPerCell} per cell`,
    );
  }
  const expectedTokens = insertItems.map((item) => item.token);

  // Warmup: one unmeasured bulk insert so the per-request v2
  // container/context construction, prepared statements, and connection
  // pools are hot before the sampled requests. The update is idempotent
  // (the same tokens are written every time), so warmup and all samples
  // leave the same final state the verification then checks.
  const warmupMeasurement = await withPerfTraceStep(
    context,
    perfCase,
    "warmup",
    () =>
      measureAsync("warmupUpdate", () =>
        bulkInsertAttachments(fixture, insertItems),
      ),
  );

  const samples = getPositiveIntegerEnv("PERF_LAB_SAMPLES") ?? config.samples;
  const durations: number[] = [];
  let lastUpdate = warmupMeasurement.result;
  for (let iteration = 1; iteration <= samples; iteration += 1) {
    const sampleMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      `sample-${iteration}`,
      () =>
        measureAsync(`sample-${iteration}`, () =>
          bulkInsertAttachments(fixture, insertItems),
        ),
    );
    durations.push(sampleMeasurement.durationMs);
    lastUpdate = sampleMeasurement.result;
  }
  const summary = summarizeDurations(durations);
  const routing = assertEngineRouting(context, lastUpdate.responseHeaders, {
    operation: "updateRecords",
  });
  const verifyMeasurement = await measureAsync("verifyUpdated", () =>
    assertInsertedSamples(fixture, config, expectedTokens),
  );
  const fullScan = await assertInsertedFullScan(
    fixture,
    config,
    expectedTokens,
  );

  return {
    name: config.threshold.metric,
    durationMs: summary.p95Ms,
    result: {
      summary,
      samples,
      warmupUpdateMs: warmupMeasurement.durationMs,
      requestedRecords: lastUpdate.requestedRecords,
      updatedRecords: lastUpdate.updatedRecords,
      responseHeaders: lastUpdate.responseHeaders,
      routing,
      expectedTokens,
      verified: { checkedRecords: verifyMeasurement.result.checkedRecords },
      verifyUpdatedMs: verifyMeasurement.durationMs,
      fullScan,
    },
  };
};

// Class C cleanup: clear the inserted attachment cells so the cached seed
// returns to its empty-attachment state; if that fails, delete the table.
// Isolated CI execute DBs are discarded, so skip all cleanup there.
const cleanupAttachmentFixture = async ({
  baseId,
  fixture,
  config,
}: {
  baseId: string;
  fixture: AttachmentFixture | undefined;
  config: RecordUpdateAttachmentCaseConfig;
}) => {
  if (isExecuteDbIsolated()) {
    return;
  }
  if (fixture?.reusableSeed) {
    let restored = false;
    try {
      await clearAttachmentCells(fixture);
      await assertSeedSamples(fixture, config);
      restored = true;
    } catch (error) {
      console.warn(
        `Failed to restore cached attachment seed ${fixture.tableId}; deleting it`,
        error,
      );
    }
    if (!restored) {
      try {
        await permanentDeleteTable(baseId, fixture.tableId);
      } catch (error) {
        console.warn(
          `Failed to cleanup attachment table ${fixture.tableId}`,
          error,
        );
      }
    }
  } else if (fixture) {
    try {
      await permanentDeleteTable(baseId, fixture.tableId);
    } catch (error) {
      console.warn(
        `Failed to cleanup attachment table ${fixture.tableId}`,
        error,
      );
    }
  }
};

// record-update-attachment rides the record-mutation lifecycle: seed a Title +
// empty-Attachment table, assert the cells are empty, then run the single
// measured bulk attachment-cell update and restore-or-delete the seed. It varies
// from the scalar record-update member only in the measured operation (an
// execute-only upload + p95-sampled idempotent insert) and in opening no record
// window, so it expresses both as spec fields and the driver stays unchanged.
const recordUpdateAttachmentSpec: RecordMutationLifecycleSpec<
  RecordUpdateAttachmentCaseConfig,
  AttachmentFixture,
  Awaited<ReturnType<typeof assertSeedSamples>>,
  AttachmentPrimaryResult
> = {
  // The attachment bulk update is not grouped under a record window (matches the
  // legacy runner, which opened none).
  useRecordWindow: false,
  prepareFixture: ({ baseId, tableName, config, perfCase }) =>
    prepareAttachmentFixture(baseId, tableName, config, perfCase),
  assertSeedReady: ({ fixture, config }) => assertSeedSamples(fixture, config),
  runMeasuredOperation: ({ perfCase, context, config, fixture }) =>
    runAttachmentMeasuredOperation(perfCase, context, config, fixture),
  buildResult: ({
    config,
    fixture,
    prepareMeasurement,
    seedReadyMeasurement,
    primaryMeasurement,
    error,
  }) =>
    buildResult({
      config,
      fixture,
      prepareMeasurement,
      seedReadyMeasurement,
      uploadSetupMs: fixture?.uploadSetupMs,
      primaryMeasurement,
      error,
    }),
  cleanup: ({ baseId, fixture, config }) =>
    cleanupAttachmentFixture({ baseId, fixture, config }),
};

export const runRecordUpdateAttachmentCase = (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, recordUpdateAttachmentSpec);

export const seedRecordUpdateAttachmentCase = (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(perfCase, context, recordUpdateAttachmentSpec);
