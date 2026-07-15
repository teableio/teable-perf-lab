import { FieldKeyType } from "@teable/core";
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
import { measureAsync, type Measurement } from "../metrics";
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
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordUpdateCaseConfig,
} from "../types";
import { withRecordWindowId } from "./record-replay.shared";
import {
  runRecordMutationLifecycle,
  seedRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

type UpdateField = RecordUpdateCaseConfig["fields"][number] & {
  id: string;
  name: string;
};

type SeededRecord = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
};

type RecordUpdateFixture = {
  tableId: string;
  tableName: string;
  viewId: string;
  fields: UpdateField[];
  projection: string[];
  seededRecords: SeededRecord[];
  seedBatchDurations: number[];
  seedCacheInfo?: SeedCacheInfo;
  seedCacheHit?: boolean;
  recordIdCacheHit?: boolean;
  reusableSeed?: boolean;
};

type ExpectedCellValue = string | number | boolean | string[] | null;

type SampleVerification = {
  checkedRecords: number;
  verifiedSamples: Array<{
    rowOffset: number;
    rowNumber: number;
    recordId: string;
    actual: Record<string, unknown>;
    expected: Record<string, unknown>;
  }>;
};

type RecordUpdatePrimaryResult = {
  updateRequestMs: number;
  update: Awaited<ReturnType<typeof updateAllRecords>> & {
    routing: EngineRouting;
  };
  verified?: SampleVerification;
  verifyUpdatedMs?: number;
};

const RECORD_UPDATE_FIXTURE_VERSION = "record-update-v1";
const RECORD_UPDATE_METADATA_PREFIX = "perf-lab-record-update:";
const STATUS_CHOICES = ["Todo", "Doing", "Done"];
const PRIORITY_CHOICES = ["P0", "P1", "P2"];
const TAG_CHOICES = ["Alpha", "Beta", "Gamma", "Delta"];
const CATEGORY_CHOICES = ["A", "B", "C"];
const LABEL_CHOICES = ["Red", "Blue", "Green"];

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const dateOnlyForRow = (rowNumber: number, offsetDays = 0) => {
  const date = new Date(
    Date.UTC(2026, 0, 1 + offsetDays + ((rowNumber - 1) % 365)),
  );
  return date.toISOString().slice(0, 10);
};

const getChoice = (choices: string[], rowNumber: number, phaseOffset: number) =>
  choices[(rowNumber - 1 + phaseOffset) % choices.length];

const getMultiChoices = (
  choices: string[],
  rowNumber: number,
  phaseOffset: number,
) => {
  const first = choices[(rowNumber - 1 + phaseOffset) % choices.length];
  const second = choices[(rowNumber + phaseOffset) % choices.length];
  return first === second ? [first] : [first, second];
};

const getExpectedCellValue = (
  field: RecordUpdateCaseConfig["fields"][number],
  rowNumber: number,
  config: RecordUpdateCaseConfig,
  phase: "seed" | "updated",
): ExpectedCellValue => {
  const prefix =
    phase === "seed"
      ? config.generator.seedPrefix
      : config.generator.updatePrefix;
  const phaseOffset = phase === "seed" ? 0 : 1;
  const padded = padRowNumber(rowNumber);

  switch (field.name) {
    case "Title":
      return `${prefix}-title-${padded}`;
    case "Description":
    case "Notes":
    case "Comment":
      return `${prefix}-${field.name.replace(/\s+/g, "-")}-${padded}-payload`;
    case "Owner Text":
    case "External ID":
    case "Source":
      return `${prefix}-${field.name.replace(/\s+/g, "-")}-${padded}`;
    case "Status":
      return getChoice(STATUS_CHOICES, rowNumber, phaseOffset);
    case "Priority":
      return getChoice(PRIORITY_CHOICES, rowNumber, phaseOffset);
    case "Tags":
      return getMultiChoices(TAG_CHOICES, rowNumber, phaseOffset);
    case "Category":
      return getChoice(CATEGORY_CHOICES, rowNumber, phaseOffset);
    case "Labels":
      return getMultiChoices(LABEL_CHOICES, rowNumber, phaseOffset);
    case "Amount":
      return Number(
        (rowNumber * 7 + (phase === "seed" ? 0.25 : 0.75)).toFixed(2),
      );
    case "Quantity":
      return phase === "seed" ? rowNumber * 3 : rowNumber * 5;
    case "Percent":
      return Number((((rowNumber + phaseOffset) % 100) / 100).toFixed(2));
    case "Start Date":
      return dateOnlyForRow(rowNumber, phaseOffset);
    case "Due Date":
      return dateOnlyForRow(rowNumber, 7 + phaseOffset);
    case "Active":
      return phase === "seed" ? rowNumber % 2 === 1 : rowNumber % 2 === 0;
    case "Approved":
      return phase === "seed" ? rowNumber % 3 === 0 : rowNumber % 3 !== 0;
    case "Score":
      return ((rowNumber - 1 + phaseOffset) % 5) + 1;
    default:
      return null;
  }
};

const valuesMatch = (
  expectedValue: ExpectedCellValue,
  actualValue: unknown,
) => {
  if (expectedValue == null) {
    return actualValue == null;
  }
  if (Array.isArray(expectedValue)) {
    return JSON.stringify(actualValue) === JSON.stringify(expectedValue);
  }
  if (typeof expectedValue === "boolean" && actualValue == null) {
    return expectedValue === false;
  }
  if (typeof expectedValue === "number") {
    return Number(actualValue) === expectedValue;
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

const buildRecordFields = (
  fields: UpdateField[] | RecordUpdateCaseConfig["fields"],
  rowNumber: number,
  config: RecordUpdateCaseConfig,
  phase: "seed" | "updated",
  keyType: "name" | "id",
) =>
  Object.fromEntries(
    fields.map((field) => [
      keyType === "id" && "id" in field ? field.id : field.name,
      getExpectedCellValue(field, rowNumber, config, phase),
    ]),
  );

const resolveUpdateFields = (
  fields: Array<{ id: string; name: string }>,
  config: RecordUpdateCaseConfig,
): UpdateField[] => {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  return config.fields.map((field) => {
    const resolvedField = fieldByName.get(field.name);
    if (!resolvedField) {
      throw new Error(
        `Missing record update field ${field.name}; available fields: ${fields
          .map(({ name }) => name)
          .join(", ")}`,
      );
    }
    return {
      ...field,
      id: resolvedField.id,
      name: resolvedField.name,
    };
  });
};

const buildBaseFixture = async (
  tableId: string,
  tableName: string,
  config: RecordUpdateCaseConfig,
): Promise<
  Omit<RecordUpdateFixture, "seededRecords" | "seedBatchDurations">
> => {
  const tableFields = await getFields(tableId);
  const views = await getViews(tableId);
  const viewId = views[0]?.id;

  if (!viewId) {
    throw new Error(`No grid view found for record update table ${tableId}`);
  }

  const fields = resolveUpdateFields(tableFields, config);
  return {
    tableId,
    tableName,
    viewId,
    fields,
    projection: fields.map((field) => field.id),
  };
};

const seedRecords = async (
  fixture: Omit<RecordUpdateFixture, "seededRecords" | "seedBatchDurations">,
  config: RecordUpdateCaseConfig,
) => {
  const records = Array.from({ length: config.rowCount }, (_, index) => {
    const rowNumber = index + 1;
    return {
      rowOffset: index,
      rowNumber,
      record: {
        fields: buildRecordFields(
          config.fields,
          rowNumber,
          config,
          "seed",
          "name",
        ),
      },
    };
  });
  const batches = chunk(records, config.batchSize);
  const seededRecords: SeededRecord[] = [];
  const batchDurations: number[] = [];

  for (const [batchIndex, batch] of batches.entries()) {
    const batchMeasurement = await measureAsync(
      `seedBatch:${batchIndex + 1}`,
      () =>
        createRecords(fixture.tableId, {
          fieldKeyType: FieldKeyType.Name,
          typecast: true,
          records: batch.map((item) => item.record),
        }),
    );
    batchDurations.push(batchMeasurement.durationMs);
    expect(batchMeasurement.result.records).toHaveLength(batch.length);
    batchMeasurement.result.records.forEach((record, index) => {
      const input = batch[index];
      if (!input) {
        return;
      }
      seededRecords.push({
        rowOffset: input.rowOffset,
        rowNumber: input.rowNumber,
        recordId: record.id,
      });
    });
  }

  return { seededRecords, batchDurations };
};

type CachedRecordUpdateSeed = {
  fixtureVersion: string;
  rowCount: number;
  fieldIds: string[];
  seededRecords: SeededRecord[];
};

const parseCachedRecordUpdateSeed = (
  description: string | null | undefined,
): CachedRecordUpdateSeed | undefined => {
  if (!description?.startsWith(RECORD_UPDATE_METADATA_PREFIX)) {
    return;
  }
  try {
    return JSON.parse(
      description.slice(RECORD_UPDATE_METADATA_PREFIX.length),
    ) as CachedRecordUpdateSeed;
  } catch {
    return;
  }
};

const persistCachedRecordUpdateSeed = async (
  baseId: string,
  tableId: string,
  metadata: CachedRecordUpdateSeed,
) => {
  await updateTableDescription(baseId, tableId, {
    description: `${RECORD_UPDATE_METADATA_PREFIX}${JSON.stringify(metadata)}`,
  });
};

const getFieldIds = (fixture: Pick<RecordUpdateFixture, "fields">) =>
  fixture.fields.map((field) => field.id);

const resolveCachedSeededRecords = (
  fixture: Pick<RecordUpdateFixture, "fields">,
  config: RecordUpdateCaseConfig,
  cachedSeed?: CachedRecordUpdateSeed,
) => {
  if (
    cachedSeed?.fixtureVersion === RECORD_UPDATE_FIXTURE_VERSION &&
    cachedSeed.rowCount === config.rowCount &&
    cachedSeed.seededRecords.length === config.rowCount &&
    JSON.stringify(cachedSeed.fieldIds) === JSON.stringify(getFieldIds(fixture))
  ) {
    return cachedSeed.seededRecords;
  }
};

const getRecordUpdateSeedConfig = (config: RecordUpdateCaseConfig) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  fields: config.fields,
  generator: config.generator,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: RECORD_UPDATE_FIXTURE_VERSION,
});

const prepareRecordUpdateFixture = async (
  baseId: string,
  tableName: string,
  config: RecordUpdateCaseConfig,
  perfCase: PerfCase,
): Promise<RecordUpdateFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "record-update" as never,
    fixtureVersion: RECORD_UPDATE_FIXTURE_VERSION,
    seedConfig: getRecordUpdateSeedConfig(config),
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
      const cachedFixture: RecordUpdateFixture = {
        ...(await buildBaseFixture(cachedTable.id, cachedTable.name, config)),
        seededRecords: [],
        seedBatchDurations: [0],
        seedCacheInfo,
        seedCacheHit: true,
        reusableSeed: true,
      };
      const cachedSeededRecords = resolveCachedSeededRecords(
        cachedFixture,
        config,
        parseCachedRecordUpdateSeed(tableMeta.description),
      );
      if (!cachedSeededRecords) {
        throw new Error(
          `Missing cached record update ids for ${seedCacheInfo.seedTableName}`,
        );
      }
      const fixture = {
        ...cachedFixture,
        seededRecords: cachedSeededRecords,
        recordIdCacheHit: true,
      };
      await assertSampleRecordsState(fixture, config, "seed");
      return fixture;
    } catch (error) {
      console.warn(
        `Invalid cached record update seed ${seedCacheInfo.seedTableName}; rebuilding`,
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
    const baseFixture = await buildBaseFixture(
      table.id,
      actualTableName,
      config,
    );
    const seeded = await seedRecords(baseFixture, config);
    await persistCachedRecordUpdateSeed(baseId, table.id, {
      fixtureVersion: RECORD_UPDATE_FIXTURE_VERSION,
      rowCount: config.rowCount,
      fieldIds: getFieldIds(baseFixture),
      seededRecords: seeded.seededRecords,
    });

    return {
      ...baseFixture,
      seededRecords: seeded.seededRecords,
      seedBatchDurations: seeded.batchDurations,
      seedCacheInfo,
      seedCacheHit: false,
      recordIdCacheHit: false,
      reusableSeed: seedCacheInfo.enabled,
    };
  } catch (error) {
    if (createdTableId) {
      try {
        await permanentDeleteTable(baseId, createdTableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup incomplete record update seed ${createdTableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const assertSampleRecordsState = async (
  fixture: RecordUpdateFixture,
  config: RecordUpdateCaseConfig,
  phase: "seed" | "updated",
): Promise<SampleVerification> => {
  const verifiedSamples: SampleVerification["verifiedSamples"] = [];
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
      projection: fixture.projection,
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(
        `Expected sample record at row offset ${rowOffset}, got ${result.records.length}`,
      );
    }

    if (record.id !== seededRecord.recordId) {
      throw new Error(
        `Sample row ${seededRecord.rowNumber} record id mismatch: expected ${seededRecord.recordId}, got ${record.id}`,
      );
    }

    const actual: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const field of fixture.fields) {
      const expectedValue = getExpectedCellValue(
        field,
        seededRecord.rowNumber,
        config,
        phase,
      );
      const actualValue = record.fields[field.id];
      actual[field.name] = actualValue;
      expected[field.name] = expectedValue;

      if (!valuesMatch(expectedValue, actualValue)) {
        throw new Error(
          `Row ${seededRecord.rowNumber} ${field.name} mismatch in ${phase} state: expected ${String(
            expectedValue,
          )}, actual ${String(actualValue)}`,
        );
      }
    }

    verifiedSamples.push({
      rowOffset,
      rowNumber: seededRecord.rowNumber,
      recordId: record.id,
      actual,
      expected,
    });
  }

  return {
    checkedRecords: verifiedSamples.length,
    verifiedSamples,
  };
};

const getUpdatedRecordIds = (
  response: Awaited<ReturnType<typeof updateRecords>>,
) => {
  const data = response.data as unknown;
  if (Array.isArray(data)) {
    return data.map((record) => (record as { id?: string }).id).filter(Boolean);
  }
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { records?: unknown[] }).records)
  ) {
    return (data as { records: Array<{ id?: string }> }).records
      .map((record) => record.id)
      .filter(Boolean);
  }
  return [];
};

const pickResponseHeaders = pickRoutingResponseHeaders;

const updateAllRecords = async (
  fixture: RecordUpdateFixture,
  config: RecordUpdateCaseConfig,
  phase: "seed" | "updated",
) => {
  const updates = fixture.seededRecords.map((record) => ({
    id: record.recordId,
    fields: buildRecordFields(
      fixture.fields,
      record.rowNumber,
      config,
      phase,
      "id",
    ),
  }));
  const response = await updateRecords(fixture.tableId, {
    fieldKeyType: FieldKeyType.Id,
    typecast: false,
    records: updates,
  });
  const updatedRecordIds = getUpdatedRecordIds(response);

  expect(response.status).toBe(200);
  expect(updatedRecordIds).toHaveLength(updates.length);

  return {
    status: response.status,
    requestedRecords: updates.length,
    updatedRecords: updatedRecordIds.length,
    responseHeaders: pickResponseHeaders(
      response.headers as Record<string, unknown>,
    ),
  };
};

const verifyUpdatedRecords = async (
  fixture: RecordUpdateFixture,
  config: RecordUpdateCaseConfig,
) => {
  const verifyMeasurement = await measureAsync("verifyUpdated", () =>
    assertSampleRecordsState(fixture, config, "updated"),
  );

  return {
    verified: verifyMeasurement.result,
    verifyUpdatedMs: verifyMeasurement.durationMs,
  };
};

const buildRecordUpdateResult = ({
  config,
  fixture,
  windowId,
  prepareMeasurement,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  config: RecordUpdateCaseConfig;
  fixture?: RecordUpdateFixture;
  windowId?: string;
  prepareMeasurement?: Measurement<RecordUpdateFixture>;
  seedReadyMeasurement?: Measurement<SampleVerification>;
  primaryMeasurement?: Measurement<RecordUpdatePrimaryResult>;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    ...(prepareMeasurement ? { prepareMs: prepareMeasurement.durationMs } : {}),
    ...(fixture?.seedCacheInfo
      ? {
          seedCacheHit: fixture.seedCacheHit ? 1 : 0,
          seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
          recordIdCacheHit: fixture.recordIdCacheHit ? 1 : 0,
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
          [config.threshold.metric]: primaryMeasurement.durationMs,
          updateRequestMs: primaryMeasurement.durationMs,
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
    operation: "bulk-update",
    windowId,
    tableId: fixture?.tableId,
    tableName: fixture?.tableName,
    viewId: fixture?.viewId,
    rowCount: config.rowCount,
    batchSize: config.batchSize,
    request: fixture
      ? {
          method: "PATCH",
          path: `/api/table/${fixture.tableId}/record`,
          fieldKeyType: "id",
          typecast: false,
          recordCount: fixture.seededRecords.length,
          fieldCount: fixture.fields.length,
        }
      : undefined,
    fields: fixture?.fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
    })),
    seed: fixture
      ? {
          seededRecords: fixture.seededRecords.length,
          batchCount: fixture.seedBatchDurations.length,
          maxSeedBatchMs: fixture.seedBatchDurations.length
            ? Math.max(...fixture.seedBatchDurations)
            : undefined,
          ready: seedReadyMeasurement?.result,
          cache: fixture.seedCacheInfo
            ? {
                enabled: fixture.seedCacheInfo.enabled,
                cacheHit: Boolean(fixture.seedCacheHit),
                recordIdCacheHit: Boolean(fixture.recordIdCacheHit),
                reusable: Boolean(fixture.reusableSeed),
                seedHash: fixture.seedCacheInfo.seedHash,
                seedHashShort: fixture.seedCacheInfo.seedHashShort,
                seedTableName: fixture.seedCacheInfo.seedTableName,
                schemaSignature: fixture.seedCacheInfo.schemaSignature,
              }
            : undefined,
        }
      : undefined,
    update: primaryMeasurement?.result.update,
    routing: primaryMeasurement?.result.update.routing,
    sampleVerification: primaryMeasurement?.result.verified
      ? {
          checkedRecords: primaryMeasurement.result.verified.checkedRecords,
        }
      : undefined,
    verifiedSamples: primaryMeasurement?.result.verified?.verifiedSamples,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
          }
        : undefined,
  },
});

// The single measured window: trace-wrapped bulk update -> routing assertion ->
// post-update verification, all bundled into one primary measurement whose
// duration is the primary metric. Runs inside the driver's window, so it must
// not re-open one here.
const runRecordUpdateMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: RecordUpdateCaseConfig,
  fixture: RecordUpdateFixture,
): Promise<Measurement<RecordUpdatePrimaryResult>> => {
  const updateMeasurement = await withPerfTraceStep(
    context,
    perfCase,
    config.threshold.metric,
    () =>
      measureAsync(config.threshold.metric, () =>
        updateAllRecords(fixture, config, "updated"),
      ),
  );
  let primaryMeasurement: Measurement<RecordUpdatePrimaryResult> = {
    ...updateMeasurement,
    result: {
      updateRequestMs: updateMeasurement.durationMs,
      update: {
        ...updateMeasurement.result,
        routing: assertEngineRouting(
          context,
          updateMeasurement.result.responseHeaders,
          {
            operation: "updateRecords",
          },
        ),
      },
    },
  };
  const verification = await verifyUpdatedRecords(fixture, config);
  primaryMeasurement = {
    ...primaryMeasurement,
    result: {
      ...primaryMeasurement.result,
      ...verification,
    },
  };
  return primaryMeasurement;
};

// The measured bulk update overwrites the reusable seed values, so a shared
// (non-isolated) execute DB must be restored to the seed state — or the table
// dropped if restore fails — before the next run reuses it. Isolated CI execute
// DBs are discarded after the job, so no cleanup is needed there.
const cleanupRecordUpdateFixture = async ({
  baseId,
  fixture,
  config,
  windowId,
}: {
  baseId: string;
  fixture: RecordUpdateFixture | undefined;
  config: RecordUpdateCaseConfig;
  windowId: string;
}) => {
  if (fixture?.reusableSeed) {
    if (!isExecuteDbIsolated()) {
      let restored = false;
      try {
        await withRecordWindowId(windowId, async () => {
          await updateAllRecords(fixture, config, "seed");
        });
        await assertSampleRecordsState(fixture, config, "seed");
        restored = true;
      } catch (error) {
        console.warn(
          `Failed to restore cached record update seed ${fixture.tableId}; deleting it`,
          error,
        );
      }

      if (!restored && fixture?.tableId) {
        try {
          await permanentDeleteTable(baseId, fixture.tableId);
        } catch (error) {
          console.warn(
            `Failed to cleanup perf table ${fixture.tableId}`,
            error,
          );
        }
      }
    }
  } else if (fixture?.tableId && !isExecuteDbIsolated()) {
    try {
      await permanentDeleteTable(baseId, fixture.tableId);
    } catch (error) {
      console.warn(`Failed to cleanup perf table ${fixture.tableId}`, error);
    }
  }
};

const recordUpdateLifecycleSpec: RecordMutationLifecycleSpec<
  RecordUpdateCaseConfig,
  RecordUpdateFixture,
  SampleVerification,
  RecordUpdatePrimaryResult
> = {
  // Group the bulk update under one record window id (mirrors the legacy
  // runner; record-create has no window and omits this).
  useRecordWindow: true,
  prepareFixture: ({ baseId, tableName, config, perfCase }) =>
    prepareRecordUpdateFixture(baseId, tableName, config, perfCase),
  assertSeedReady: ({ fixture, config }) =>
    assertSampleRecordsState(fixture, config, "seed"),
  runMeasuredOperation: ({ perfCase, context, config, fixture }) =>
    runRecordUpdateMeasuredOperation(perfCase, context, config, fixture),
  buildResult: buildRecordUpdateResult,
  cleanup: cleanupRecordUpdateFixture,
};

export const runRecordUpdateCase = async (
  perfCase: PerfCaseFor<"record-update">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, recordUpdateLifecycleSpec);

export const seedRecordUpdateCase = async (
  perfCase: PerfCaseFor<"record-update">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(perfCase, context, recordUpdateLifecycleSpec);
