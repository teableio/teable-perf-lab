import { FieldKeyType, FieldType, Relationship } from "@teable/core";
import { updateRecords, updateTableDescription } from "@teable/openapi";
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
import { measureAsync, roundMetric, type Measurement } from "../metrics";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import {
  buildSeedCacheInfo,
  buildSeedTableName,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordUpdateLinkCaseConfig,
} from "../types";
import {
  runRecordMutationLifecycle,
  seedRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";
import {
  expectedForeignTitle,
  fetchForeignIdByTitle,
  foreignRowForHostRow,
  resolveForeignKeyFieldId,
  seedForeignTable,
  type LinkPermutation,
} from "./link-fixture.shared";

const RECORD_UPDATE_LINK_FIXTURE_VERSION = "record-update-link-v1";
const RECORD_UPDATE_LINK_METADATA_PREFIX = "perf-lab-record-update-link:";

type Phase = "seed" | "updated";

type NamedField = { id: string; name: string; type?: string };

type SeededRecord = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
};

type RecordUpdateLinkFixture = {
  tableId: string;
  tableName: string;
  viewId: string;
  linkFieldId: string;
  titleFieldId: string;
  foreignTableId: string;
  foreignTableName: string;
  foreignKeyFieldId: string;
  seededRecords: SeededRecord[];
  seedBatchDurations: number[];
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
};

type LinkUpdatePrimaryResult = {
  updateRequestMs: number;
  requestedRecords: number;
  updatedRecords: number;
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
  verified?: { checkedRecords: number };
  verifyUpdatedMs?: number;
  fullScan?: { scannedRecords: number; pageSize: number; pageCount: number };
};

const permutationFor = (
  config: RecordUpdateLinkCaseConfig,
  phase: Phase,
): LinkPermutation =>
  phase === "seed"
    ? config.link.seedPermutation
    : config.link.updatePermutation;

const expectedTitleForRow = (
  config: RecordUpdateLinkCaseConfig,
  rowNumber: number,
  phase: Phase,
) =>
  expectedForeignTitle(
    foreignRowForHostRow(
      rowNumber,
      config.foreignTable.rowCount,
      permutationFor(config, phase),
    ),
    config.foreignTable.keyPrefix,
  );

// Host Title is `${titlePrefix} <rowNumber>`; parse it so the full scan can
// verify each link cell against its own row number instead of relying on the
// page order returned by getRecords.
const parseTitleRowNumber = (
  value: unknown,
  config: RecordUpdateLinkCaseConfig,
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

const getLinkSeedConfig = (config: RecordUpdateLinkCaseConfig) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  linkFieldName: config.linkFieldName,
  foreignTable: config.foreignTable,
  link: config.link,
  generator: config.generator,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: RECORD_UPDATE_LINK_FIXTURE_VERSION,
});

type CachedLinkSeed = {
  fixtureVersion: string;
  rowCount: number;
  linkFieldName: string;
  seededRecordIds: string[];
};

const parseCachedLinkSeed = (
  description: string | null | undefined,
): CachedLinkSeed | undefined => {
  if (!description?.startsWith(RECORD_UPDATE_LINK_METADATA_PREFIX)) {
    return;
  }
  try {
    return JSON.parse(
      description.slice(RECORD_UPDATE_LINK_METADATA_PREFIX.length),
    ) as CachedLinkSeed;
  } catch {
    return;
  }
};

const persistCachedLinkSeed = async (
  baseId: string,
  tableId: string,
  metadata: CachedLinkSeed,
) => {
  await updateTableDescription(baseId, tableId, {
    description: `${RECORD_UPDATE_LINK_METADATA_PREFIX}${JSON.stringify(metadata)}`,
  });
};

// Sample/full read of the link cells: each cell must resolve to the permuted
// foreign row for the given phase, proven by the link title (foreign primary).
const assertLinkSamples = async (
  fixture: RecordUpdateLinkFixture,
  config: RecordUpdateLinkCaseConfig,
  phase: Phase,
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
      projection: [fixture.linkFieldId],
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(`Missing link sample at row offset ${rowOffset}`);
    }
    if (record.id !== seededRecord.recordId) {
      throw new Error(
        `Link sample row ${seededRecord.rowNumber} record id mismatch: expected ${seededRecord.recordId}, got ${record.id}`,
      );
    }
    const linkValue = record.fields[fixture.linkFieldId] as
      | { id?: string; title?: string }
      | undefined;
    const expectedTitle = expectedTitleForRow(
      config,
      seededRecord.rowNumber,
      phase,
    );
    if (!linkValue?.id || linkValue.title !== expectedTitle) {
      throw new Error(
        `Link sample row ${seededRecord.rowNumber} title mismatch in ${phase} state: expected ${expectedTitle}, actual ${JSON.stringify(linkValue)}`,
      );
    }
    verifiedSamples.push({
      rowOffset,
      rowNumber: seededRecord.rowNumber,
      expectedTitle,
    });
  }
  return { checkedRecords: verifiedSamples.length, verifiedSamples };
};

const assertLinkFullScan = async (
  fixture: RecordUpdateLinkFixture,
  config: RecordUpdateLinkCaseConfig,
  phase: Phase,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const seenRowNumbers = new Set<number>();
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.rowCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          viewId: fixture.viewId,
          fieldKeyType: FieldKeyType.Id,
          projection: [fixture.titleFieldId, fixture.linkFieldId],
          skip,
          take,
        }),
    },
    (record) => {
      const rowNumber = parseTitleRowNumber(
        record.fields[fixture.titleFieldId],
        config,
      );
      if (seenRowNumbers.has(rowNumber)) {
        throw new Error(`Duplicate row number in link full scan: ${rowNumber}`);
      }
      seenRowNumbers.add(rowNumber);
      const linkValue = record.fields[fixture.linkFieldId] as
        | { id?: string; title?: string }
        | undefined;
      const expectedTitle = expectedTitleForRow(config, rowNumber, phase);
      if (!linkValue?.id || linkValue.title !== expectedTitle) {
        throw new Error(
          `Link full scan mismatch at row ${rowNumber} in ${phase} state: expected ${expectedTitle}, actual ${JSON.stringify(linkValue)}`,
        );
      }
    },
  );
  if (scannedRecords !== config.rowCount) {
    throw new Error(
      `Link full scan count mismatch: expected ${config.rowCount}, scanned ${scannedRecords}`,
    );
  }
  return { scannedRecords, pageSize, pageCount };
};

const prepareLinkFixture = async (
  baseId: string,
  tableName: string,
  config: RecordUpdateLinkCaseConfig,
  perfCase: PerfCase,
): Promise<RecordUpdateLinkFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "record-update-link",
    fixtureVersion: RECORD_UPDATE_LINK_FIXTURE_VERSION,
    seedConfig: getLinkSeedConfig(config) as never,
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
      new URL("./link-fixture.shared.ts", import.meta.url),
    ],
  });

  const hostTableName = seedCacheInfo.enabled
    ? seedCacheInfo.seedTableName
    : tableName;
  const foreignTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "fk")
    : `${tableName}-fk`;

  if (seedCacheInfo.enabled) {
    const cachedHost = await findSeedTable(baseId, hostTableName);
    const cachedForeign = await findSeedTable(baseId, foreignTableName);
    if (cachedHost && cachedForeign) {
      try {
        const hostFields = (await getFields(cachedHost.id)) as NamedField[];
        const titleField = resolveNamedField(hostFields, "Title");
        const linkField = resolveNamedField(hostFields, config.linkFieldName);
        if (linkField.type !== FieldType.Link) {
          throw new Error(
            `Cached link field ${config.linkFieldName} has type ${linkField.type}, expected ${FieldType.Link}`,
          );
        }
        const foreignFields = (await getFields(
          cachedForeign.id,
        )) as NamedField[];
        const tableMeta = await getTable(baseId, cachedHost.id);
        const cachedSeed = parseCachedLinkSeed(tableMeta.description);
        if (
          !cachedSeed ||
          cachedSeed.fixtureVersion !== RECORD_UPDATE_LINK_FIXTURE_VERSION ||
          cachedSeed.rowCount !== config.rowCount ||
          cachedSeed.linkFieldName !== config.linkFieldName ||
          cachedSeed.seededRecordIds.length !== config.rowCount
        ) {
          throw new Error(
            `Missing or stale cached link seed metadata for ${hostTableName}`,
          );
        }
        const views = await getViews(cachedHost.id);
        const viewId = views[0]?.id;
        if (!viewId) {
          throw new Error(
            `No grid view found for cached link host ${hostTableName}`,
          );
        }
        const fixture: RecordUpdateLinkFixture = {
          tableId: cachedHost.id,
          tableName: cachedHost.name,
          viewId,
          linkFieldId: linkField.id,
          titleFieldId: titleField.id,
          foreignTableId: cachedForeign.id,
          foreignTableName: cachedForeign.name,
          foreignKeyFieldId: resolveForeignKeyFieldId(
            foreignFields,
            cachedForeign.name,
          ),
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
        await assertLinkSamples(fixture, config, "seed");
        return fixture;
      } catch (error) {
        console.warn(
          `Invalid cached link seed ${hostTableName}; rebuilding`,
          error,
        );
        for (const table of [cachedHost, cachedForeign]) {
          try {
            await permanentDeleteTable(baseId, table.id);
          } catch (cleanupError) {
            console.warn(
              `Failed to delete stale seed table ${table.id}`,
              cleanupError,
            );
          }
        }
      }
    } else if (cachedHost || cachedForeign) {
      const orphan = cachedHost ?? cachedForeign;
      if (orphan) {
        try {
          await permanentDeleteTable(baseId, orphan.id);
        } catch (cleanupError) {
          console.warn(
            `Failed to delete orphan seed table ${orphan.id}`,
            cleanupError,
          );
        }
      }
    }
  }

  let foreignTableId = "";
  let hostTableId = "";
  try {
    const foreign = await seedForeignTable(baseId, foreignTableName, {
      rowCount: config.foreignTable.rowCount,
      batchSize: config.foreignTable.batchSize,
      keyPrefix: config.foreignTable.keyPrefix,
    });
    foreignTableId = foreign.tableId;
    const foreignIdByTitle = await fetchForeignIdByTitle(
      foreign.tableId,
      foreign.keyFieldId,
      config.foreignTable.rowCount,
    );

    const host = await createTable(baseId, {
      name: hostTableName,
      fields: [
        { name: "Title", type: FieldType.SingleLineText },
        {
          name: config.linkFieldName,
          type: FieldType.Link,
          options: {
            relationship: Relationship.ManyOne,
            foreignTableId: foreign.tableId,
            isOneWay: config.link.isOneWay,
          },
        },
      ],
      records: [],
    });
    hostTableId = host.id;

    const hostFields = (await getFields(host.id)) as NamedField[];
    const titleField = resolveNamedField(hostFields, "Title");
    const linkField = resolveNamedField(hostFields, config.linkFieldName);
    const views = await getViews(host.id);
    const viewId = views[0]?.id;
    if (!viewId) {
      throw new Error(`No grid view found for link host ${hostTableName}`);
    }

    const records = Array.from({ length: config.rowCount }, (_, index) => {
      const rowNumber = index + 1;
      const title = expectedTitleForRow(config, rowNumber, "seed");
      const foreignId = foreignIdByTitle.get(title);
      if (!foreignId) {
        throw new Error(
          `No foreign record id for host row ${rowNumber} (${title})`,
        );
      }
      return {
        rowOffset: index,
        rowNumber,
        record: {
          fields: {
            Title: `${config.generator.titlePrefix} ${rowNumber}`,
            [config.linkFieldName]: { id: foreignId },
          },
        },
      };
    });
    const seededRecords: SeededRecord[] = [];
    const seedBatchDurations: number[] = [];
    for (const batch of chunk(records, config.batchSize)) {
      const batchMeasurement = await measureAsync("seedBatch", () =>
        createRecords(host.id, {
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

    await persistCachedLinkSeed(baseId, host.id, {
      fixtureVersion: RECORD_UPDATE_LINK_FIXTURE_VERSION,
      rowCount: config.rowCount,
      linkFieldName: config.linkFieldName,
      seededRecordIds: seededRecords.map((record) => record.recordId),
    });

    return {
      tableId: host.id,
      tableName: hostTableName,
      viewId,
      linkFieldId: linkField.id,
      titleFieldId: titleField.id,
      foreignTableId: foreign.tableId,
      foreignTableName: foreign.tableName,
      foreignKeyFieldId: foreign.keyFieldId,
      seededRecords,
      seedBatchDurations,
      seedCacheInfo,
      seedCacheHit: false,
      reusableSeed: seedCacheInfo.enabled,
    };
  } catch (error) {
    for (const tableId of [hostTableId, foreignTableId]) {
      if (tableId) {
        try {
          await permanentDeleteTable(baseId, tableId);
        } catch (cleanupError) {
          console.warn(
            `Failed to cleanup incomplete link seed ${tableId}`,
            cleanupError,
          );
        }
      }
    }
    throw error;
  }
};

const updateAllLinks = async (
  fixture: RecordUpdateLinkFixture,
  config: RecordUpdateLinkCaseConfig,
  phase: Phase,
  foreignIdByTitle: Map<string, string>,
) => {
  const updates = fixture.seededRecords.map((record) => {
    const title = expectedTitleForRow(config, record.rowNumber, phase);
    const foreignId = foreignIdByTitle.get(title);
    if (!foreignId) {
      throw new Error(
        `No foreign record id for host row ${record.rowNumber} (${title})`,
      );
    }
    return {
      id: record.recordId,
      fields: { [fixture.linkFieldId]: { id: foreignId } },
    };
  });
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

const buildResult = ({
  config,
  fixture,
  prepareMeasurement,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  config: RecordUpdateLinkCaseConfig;
  fixture?: RecordUpdateLinkFixture;
  prepareMeasurement?: Measurement<RecordUpdateLinkFixture>;
  seedReadyMeasurement?: Measurement<{ checkedRecords: number }>;
  primaryMeasurement?: Measurement<LinkUpdatePrimaryResult>;
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
    ...(primaryMeasurement
      ? {
          [config.threshold.metric]: primaryMeasurement.durationMs,
          updateRequestMs: primaryMeasurement.result.updateRequestMs,
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
    operation: "bulk-update-link",
    tableId: fixture?.tableId,
    tableName: fixture?.tableName,
    viewId: fixture?.viewId,
    foreignTableId: fixture?.foreignTableId,
    foreignTableName: fixture?.foreignTableName,
    rowCount: config.rowCount,
    foreignRowCount: config.foreignTable.rowCount,
    batchSize: config.batchSize,
    request: fixture
      ? {
          method: "PATCH",
          path: `/api/table/${fixture.tableId}/record`,
          fieldKeyType: "id",
          typecast: false,
          recordCount: fixture.seededRecords.length,
          linkFieldId: fixture.linkFieldId,
        }
      : undefined,
    update: primaryMeasurement
      ? {
          requestedRecords: primaryMeasurement.result.requestedRecords,
          updatedRecords: primaryMeasurement.result.updatedRecords,
          responseHeaders: primaryMeasurement.result.responseHeaders,
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

// The single measured operation: resolve foreign ids (unmeasured setup) ->
// trace-wrapped bulk link-cell update -> routing assertion -> post-update
// sample + full-scan verification, bundled into one primary measurement whose
// duration is the primary metric. record-update-link has no record window, so
// the driver invokes this directly (no withRecordWindowId).
const runLinkUpdateMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: RecordUpdateLinkCaseConfig,
  fixture: RecordUpdateLinkFixture,
): Promise<Measurement<LinkUpdatePrimaryResult>> => {
  // Execute setup (not measured): resolve foreign titles -> record ids.
  const foreignIdByTitle = await fetchForeignIdByTitle(
    fixture.foreignTableId,
    fixture.foreignKeyFieldId,
    config.foreignTable.rowCount,
  );
  const updateMeasurement = await withPerfTraceStep(
    context,
    perfCase,
    config.threshold.metric,
    () =>
      measureAsync(config.threshold.metric, () =>
        updateAllLinks(fixture, config, "updated", foreignIdByTitle),
      ),
  );
  const routing = assertEngineRouting(
    context,
    updateMeasurement.result.responseHeaders,
    { operation: "updateRecords" },
  );
  const verifyMeasurement = await measureAsync("verifyUpdated", () =>
    assertLinkSamples(fixture, config, "updated"),
  );
  const fullScan = await assertLinkFullScan(fixture, config, "updated");
  return {
    ...updateMeasurement,
    result: {
      updateRequestMs: updateMeasurement.durationMs,
      requestedRecords: updateMeasurement.result.requestedRecords,
      updatedRecords: updateMeasurement.result.updatedRecords,
      responseHeaders: updateMeasurement.result.responseHeaders,
      routing,
      verified: { checkedRecords: verifyMeasurement.result.checkedRecords },
      verifyUpdatedMs: verifyMeasurement.durationMs,
      fullScan,
    },
  };
};

// Class C cleanup: the measured update repoints the reusable seed's link cells
// to the update permutation, so a shared (non-isolated) execute DB must be
// restored to the seed permutation — or both fixture tables dropped if restore
// fails — before the next run reuses it. foreignIdByTitle is re-resolved here
// (cleanup is unmeasured) instead of being threaded from the measured op.
// Isolated CI execute DBs are discarded after the job, so cleanup is skipped.
const cleanupRecordUpdateLinkFixture = async ({
  baseId,
  fixture,
  config,
}: {
  baseId: string;
  fixture: RecordUpdateLinkFixture | undefined;
  config: RecordUpdateLinkCaseConfig;
}) => {
  if (!fixture || isExecuteDbIsolated()) {
    return;
  }
  if (fixture.reusableSeed) {
    let restored = false;
    try {
      const foreignIdByTitle = await fetchForeignIdByTitle(
        fixture.foreignTableId,
        fixture.foreignKeyFieldId,
        config.foreignTable.rowCount,
      );
      await updateAllLinks(fixture, config, "seed", foreignIdByTitle);
      await assertLinkSamples(fixture, config, "seed");
      restored = true;
    } catch (error) {
      console.warn(
        `Failed to restore cached link seed ${fixture.tableId}; deleting it`,
        error,
      );
    }
    if (restored) {
      return;
    }
  }
  for (const tableId of [fixture.tableId, fixture.foreignTableId]) {
    try {
      await permanentDeleteTable(baseId, tableId);
    } catch (error) {
      console.warn(`Failed to cleanup link table ${tableId}`, error);
    }
  }
};

// record-update-link rides the record-mutation lifecycle: seed a host + linked
// foreign fixture, run one measured bulk link-cell update inside the family's
// prepare -> seedReady -> measured op -> restore-or-delete skeleton. It is the
// first member whose fixture spans more than one table; the driver treats the
// fixture opaquely, so no driver code changes — only the scope note. No window.
const recordUpdateLinkLifecycleSpec: RecordMutationLifecycleSpec<
  RecordUpdateLinkCaseConfig,
  RecordUpdateLinkFixture,
  Awaited<ReturnType<typeof assertLinkSamples>>,
  LinkUpdatePrimaryResult
> = {
  prepareFixture: ({ baseId, tableName, config, perfCase }) =>
    prepareLinkFixture(baseId, tableName, config, perfCase),
  assertSeedReady: ({ fixture, config }) =>
    assertLinkSamples(fixture, config, "seed"),
  runMeasuredOperation: ({ perfCase, context, config, fixture }) =>
    runLinkUpdateMeasuredOperation(perfCase, context, config, fixture),
  // buildResult already matches the driver arg shape; drop the unused windowId
  // (no record window) and delegate to the existing assembler unchanged.
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
      primaryMeasurement,
      error,
    }),
  cleanup: cleanupRecordUpdateLinkFixture,
};

export const runRecordUpdateLinkCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, recordUpdateLinkLifecycleSpec);

export const seedRecordUpdateLinkCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(perfCase, context, recordUpdateLinkLifecycleSpec);
