import { FieldKeyType, FieldType } from "@teable/core";
import { axios, updateRecords, X_CANARY_HEADER } from "@teable/openapi";
import type {
  IClearSelectionStreamDoneEvent,
  IClearSelectionStreamErrorEvent,
  IClearSelectionStreamEvent,
  IClearSelectionStreamProgressEvent,
} from "@teable/openapi";
import {
  createRecords,
  createTable,
  getFields,
  getRecords,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { chunk } from "../chunk";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { forEachRecordPage } from "../record-page-scan";
import { measureAsync, type Measurement } from "../metrics";
import { assertEngineRouting } from "../routing";
import {
  buildSeedCacheInfo,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { perfStreamSse } from "../sse";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  SelectionClearCaseConfig,
} from "../types";
import {
  runRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

type NamedField = {
  id: string;
  name: string;
};

type ClearField = SelectionClearCaseConfig["fields"][number] & {
  id: string;
  name: string;
};

type SeededRecord = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
};

type ClearFixture = {
  tableId: string;
  tableName: string;
  viewId: string;
  fields: ClearField[];
  projection: string[];
  seededRecords: SeededRecord[];
  seedBatchDurations: number[];
  seedCacheInfo?: SeedCacheInfo;
  seedCacheHit?: boolean;
  reusableSeed?: boolean;
};

type ExpectedCellValue = string | number | boolean | string[] | null;

const DEFAULT_GROUPS = ["A", "B", "C", "D", "E"];

const buildSyntheticSeededRecords = (rowCount: number): SeededRecord[] =>
  Array.from({ length: rowCount }, (_, index) => ({
    rowOffset: index,
    rowNumber: index + 1,
    recordId: "",
  }));

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const fieldNameKey = (fieldName: string) => fieldName.replace(/\s+/g, "-");

const selectChoices = (field: SelectionClearCaseConfig["fields"][number]) =>
  (
    field.options as
      | {
          choices?: Array<{ name: string }>;
        }
      | undefined
  )?.choices ?? [];

const ratingMax = (field: SelectionClearCaseConfig["fields"][number]) =>
  (
    field.options as
      | {
          max?: number;
        }
      | undefined
  )?.max ?? 5;

const dateOnlyForRow = (rowNumber: number, offsetDays = 0) => {
  const date = new Date(
    Date.UTC(2026, 0, 1 + offsetDays + ((rowNumber - 1) % 365)),
  );
  return date.toISOString().slice(0, 10);
};

const dateIsoForRow = (rowNumber: number, offsetDays = 0) =>
  `${dateOnlyForRow(rowNumber, offsetDays)}T00:00:00.000Z`;

const getGroups = (config: SelectionClearCaseConfig) =>
  config.generator.groups?.length ? config.generator.groups : DEFAULT_GROUPS;

const getGroupValue = (rowNumber: number, config: SelectionClearCaseConfig) => {
  const groups = getGroups(config);
  return groups[(rowNumber - 1) % groups.length];
};

const getExpectedCellValue = (
  field: SelectionClearCaseConfig["fields"][number],
  rowNumber: number,
  config: SelectionClearCaseConfig,
): ExpectedCellValue => {
  const padded = padRowNumber(rowNumber);
  const group = getGroupValue(rowNumber, config);

  if (field.name === "Name" || field.name === "Title") {
    return `${config.generator.titlePrefix} ${padded}`;
  }
  if (field.name === "Index") {
    return rowNumber;
  }
  if (field.name === "Group") {
    return group;
  }
  if (field.name === "Payload") {
    return `${config.generator.payloadPrefix}-${padded}-${group}`;
  }

  switch (field.type) {
    case FieldType.Number:
      return rowNumber;
    case FieldType.SingleSelect: {
      const choices = selectChoices(field);
      return choices.length
        ? choices[(rowNumber - 1) % choices.length].name
        : group;
    }
    case FieldType.MultipleSelect: {
      const choices = selectChoices(field);
      if (choices.length === 0) {
        return [];
      }
      const first = choices[(rowNumber - 1) % choices.length].name;
      const second = choices[rowNumber % choices.length].name;
      return first === second ? [first] : [first, second];
    }
    case FieldType.Date:
      return dateIsoForRow(
        rowNumber,
        field.name.toLowerCase().includes("due") ? 7 : 0,
      );
    case FieldType.Checkbox:
      return rowNumber % 2 === 1 ? true : null;
    case FieldType.Rating:
      return ((rowNumber - 1) % ratingMax(field)) + 1;
    case FieldType.LongText:
      return `${config.generator.payloadPrefix}-${padded}-${fieldNameKey(
        field.name,
      )}`;
    case FieldType.SingleLineText:
      return `${config.generator.titlePrefix} ${padded}-${fieldNameKey(
        field.name,
      )}`;
    default:
      return `${config.generator.payloadPrefix}-${padded}-${fieldNameKey(
        field.name,
      )}`;
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
  if (typeof expectedValue === "number") {
    return Number(actualValue) === expectedValue;
  }
  return actualValue === expectedValue;
};

const buildRecordFields = (
  config: SelectionClearCaseConfig,
  rowNumber: number,
) =>
  Object.fromEntries(
    config.fields.map((field) => [
      field.name,
      getExpectedCellValue(field, rowNumber, config),
    ]),
  );

const resolveClearFields = (
  fields: NamedField[],
  config: SelectionClearCaseConfig,
): ClearField[] => {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  return config.fields.map((field) => {
    const resolvedField = fieldByName.get(field.name);
    if (!resolvedField) {
      throw new Error(
        `Missing clear field ${field.name}; available fields: ${fields
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

const getStreamHeaders = (context: PerfRunContext) => ({
  ...(context.cookie ? { Cookie: context.cookie } : {}),
  [X_CANARY_HEADER]: context.engine === "v2" ? "true" : "false",
});

const seedRecords = async (
  fixture: Omit<ClearFixture, "seededRecords" | "seedBatchDurations">,
  config: SelectionClearCaseConfig,
) => {
  const records = Array.from({ length: config.rowCount }, (_, index) => {
    const rowNumber = index + 1;
    return {
      rowOffset: index,
      rowNumber,
      record: {
        fields: buildRecordFields(config, rowNumber),
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

const getSelectionClearSeedConfig = (config: SelectionClearCaseConfig) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  fields: config.fields,
  generator: config.generator,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: "selection-clear-v1",
});

const buildBaseFixture = async (
  tableId: string,
  tableName: string,
  config: SelectionClearCaseConfig,
): Promise<Omit<ClearFixture, "seededRecords" | "seedBatchDurations">> => {
  const tableFields = await getFields(tableId);
  const views = await getViews(tableId);
  const viewId = views[0]?.id;

  if (!viewId) {
    throw new Error(`No grid view found for selection clear table ${tableId}`);
  }

  const fields = resolveClearFields(tableFields, config);
  return {
    tableId,
    tableName,
    viewId,
    fields,
    projection: fields.map((field) => field.id),
  };
};

const prepareClearFixture = async (
  baseId: string,
  tableName: string,
  config: SelectionClearCaseConfig,
  perfCase: PerfCase,
): Promise<ClearFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "selection-clear",
    fixtureVersion: "selection-clear-v1",
    seedConfig: getSelectionClearSeedConfig(config),
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
      const cachedFixture: ClearFixture = {
        ...(await buildBaseFixture(cachedTable.id, cachedTable.name, config)),
        seededRecords: buildSyntheticSeededRecords(config.rowCount),
        seedBatchDurations: [0],
        seedCacheInfo,
        seedCacheHit: true,
        reusableSeed: true,
      };
      await assertCellsRestored(cachedFixture, config);
      return cachedFixture;
    } catch (error) {
      console.warn(
        `Invalid cached selection clear seed ${seedCacheInfo.seedTableName}; rebuilding`,
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

    return {
      ...baseFixture,
      seededRecords: seeded.seededRecords,
      seedBatchDurations: seeded.batchDurations,
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
          `Failed to cleanup incomplete selection clear seed ${createdTableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const buildAllCellsRange = (fixture: ClearFixture) => ({
  viewId: fixture.viewId,
  ranges: [
    [0, 0],
    [fixture.projection.length - 1, fixture.seededRecords.length - 1],
  ] as [[number, number], [number, number]],
  projection: fixture.projection,
});

// V2 by-id clear body (selectionIdsRoSchema). Use allRecords:true instead of an
// explicit recordIds list because a seed-cache hit hydrates seededRecords with
// synthetic empty ids (only the row COUNT is restored, not real ids), so the
// id-based selection must not depend on recordIds. fieldIds uses the real
// projection field ids (fetched from getFields, valid on cache hit too), so the
// cleared column set matches buildAllCellsRange exactly.
const buildAllCellsByIdBody = (fixture: ClearFixture) => ({
  viewId: fixture.viewId,
  selection: {
    allRecords: true,
    fieldIds: fixture.projection,
  },
});

const clearAllCells = async (
  fixture: ClearFixture,
  perfCase: PerfCase,
  context: PerfRunContext,
) => {
  // Same user behavior ("clear the selected cells"), engine-specific endpoint:
  // V1's grid drives the range-based clear-stream, V2's grid drives the by-id
  // clear-by-id-stream. Both emit IClearSelectionStreamEvent, so the done-event
  // assertions and routing check below are identical for both engines.
  const isV2 = context.engine === "v2";
  const url = axios.getUri({
    baseURL: axios.defaults.baseURL || "/api",
    url: `/table/${fixture.tableId}/selection/${
      isV2 ? "clear-by-id-stream" : "clear-stream"
    }`,
  });
  const sseResult = await perfStreamSse<IClearSelectionStreamEvent>({
    context,
    perfCase,
    stepId: "clear",
    url,
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...getStreamHeaders(context),
    },
    body: JSON.stringify(
      isV2 ? buildAllCellsByIdBody(fixture) : buildAllCellsRange(fixture),
    ),
    errorPrefix: "Clear selection stream failed",
  });
  const progressEvents = sseResult.events.filter(
    (event): event is IClearSelectionStreamProgressEvent =>
      event.id === "progress",
  );
  const errors = sseResult.events.filter(
    (event): event is IClearSelectionStreamErrorEvent => event.id === "error",
  );
  const done = sseResult.events.find(
    (event): event is IClearSelectionStreamDoneEvent => event.id === "done",
  );

  if (!done) {
    throw new Error(
      errors.at(-1)?.message ?? "Clear selection stream ended without result",
    );
  }

  expect(errors).toHaveLength(0);
  expect(done.totalCount).toBe(fixture.seededRecords.length);
  expect(done.processedCount).toBe(fixture.seededRecords.length);
  expect(done.clearedCount).toBe(fixture.seededRecords.length);

  const routing = assertEngineRouting(context, sseResult.headers, {
    operation: "clearSelection",
  });

  return {
    totalCount: done.totalCount,
    processedCount: done.processedCount,
    clearedCount: done.clearedCount,
    progressEventCount: progressEvents.length,
    status: sseResult.status,
    routing: {
      canaryHeader: context.engine === "v2" ? "true" : "false",
      ...routing,
    },
    trace: sseResult.trace,
  };
};

const assertCellsCleared = async (
  fixture: ClearFixture,
  config: SelectionClearCaseConfig,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleRowOffsets = new Set(config.verify.sampleRows);
  const verifiedSamples = [];

  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.rowCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          viewId: fixture.viewId,
          fieldKeyType: FieldKeyType.Id,
          projection: fixture.projection,
          skip,
          take,
        }),
    },
    (record, rowNumber) => {
      const actual: Record<string, unknown> = {};

      for (const field of fixture.fields) {
        const actualValue = record.fields[field.id];
        actual[field.name] = actualValue;

        if (actualValue != null) {
          throw new Error(
            `Row ${rowNumber} ${field.name} not cleared: actual ${String(
              actualValue,
            )}`,
          );
        }
      }

      const rowOffset = rowNumber - 1;
      if (sampleRowOffsets.has(rowOffset)) {
        verifiedSamples.push({
          rowOffset,
          rowNumber,
          recordId: record.id,
          actual,
        });
      }
    },
  );

  return {
    scannedRecords,
    pageSize,
    pageCount,
    verifiedSamples,
  };
};

const assertCellsRestored = async (
  fixture: ClearFixture,
  config: SelectionClearCaseConfig,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleRowOffsets = new Set(config.verify.sampleRows);
  const verifiedSamples = [];

  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.rowCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          viewId: fixture.viewId,
          fieldKeyType: FieldKeyType.Id,
          projection: fixture.projection,
          skip,
          take,
        }),
    },
    (record, rowNumber) => {
      const actual: Record<string, unknown> = {};
      const expected: Record<string, unknown> = {};

      for (const field of fixture.fields) {
        const expectedValue = getExpectedCellValue(field, rowNumber, config);
        const actualValue = record.fields[field.id];
        actual[field.name] = actualValue;
        expected[field.name] = expectedValue;

        if (!valuesMatch(expectedValue, actualValue)) {
          throw new Error(
            `Row ${rowNumber} ${field.name} mismatch in selection clear seed: expected ${String(
              expectedValue,
            )}, actual ${String(actualValue)}`,
          );
        }
      }

      const rowOffset = rowNumber - 1;
      if (sampleRowOffsets.has(rowOffset)) {
        verifiedSamples.push({
          rowOffset,
          rowNumber,
          recordId: record.id,
          actual,
          expected,
        });
      }
    },
  );

  return {
    scannedRecords,
    pageSize,
    pageCount,
    verifiedSamples,
  };
};

const restoreClearedCells = async (
  fixture: ClearFixture,
  config: SelectionClearCaseConfig,
) => {
  const pageSize = config.verify.fullScanPageSize ?? config.batchSize;
  const batchDurations: number[] = [];
  let restoredRecords = 0;
  let pageCount = 0;

  for (let skip = 0; skip < config.rowCount; skip += pageSize) {
    const expectedTake = Math.min(pageSize, config.rowCount - skip);
    const result = await getRecords(fixture.tableId, {
      viewId: fixture.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: fixture.projection,
      skip,
      take: expectedTake,
    });
    pageCount += 1;

    if (result.records.length !== expectedTake) {
      throw new Error(
        `Expected ${expectedTake} records to restore at skip ${skip}, got ${result.records.length}`,
      );
    }

    const updates = result.records.map((record, index) => {
      const rowNumber = skip + index + 1;
      return {
        id: record.id,
        fields: Object.fromEntries(
          fixture.fields.map((field) => [
            field.id,
            getExpectedCellValue(field, rowNumber, config),
          ]),
        ),
      };
    });

    const updateMeasurement = await measureAsync(
      `restoreBatch:${pageCount}`,
      () =>
        updateRecords(fixture.tableId, {
          fieldKeyType: FieldKeyType.Id,
          typecast: true,
          records: updates,
        }),
    );
    expect(updateMeasurement.result.status).toBe(200);
    expect(updateMeasurement.result.data).toHaveLength(updates.length);
    batchDurations.push(updateMeasurement.durationMs);
    restoredRecords += updates.length;
  }

  const verified = await assertCellsRestored(fixture, config);

  return {
    restoredRecords,
    pageCount,
    batchDurations,
    maxRestoreBatchMs: batchDurations.length
      ? Math.max(...batchDurations)
      : undefined,
    verified,
  };
};

const buildSelectionClearResult = ({
  config,
  fixture,
  prepareMeasurement,
  clearMeasurement,
  verifyMeasurement,
  error,
}: {
  config: SelectionClearCaseConfig;
  fixture?: ClearFixture;
  prepareMeasurement?: Measurement<ClearFixture>;
  clearMeasurement?: Measurement<Awaited<ReturnType<typeof clearAllCells>>>;
  verifyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertCellsCleared>>
  >;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    ...(prepareMeasurement ? { prepareMs: prepareMeasurement.durationMs } : {}),
    ...(fixture?.seedCacheInfo
      ? {
          seedCacheHit: fixture.seedCacheHit ? 1 : 0,
          seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
          ...(fixture.seedCacheHit
            ? { seedRestoreMs: prepareMeasurement?.durationMs ?? 0 }
            : fixture.seedCacheInfo.enabled
              ? { seedBuildMs: prepareMeasurement?.durationMs ?? 0 }
              : {}),
        }
      : {}),
    ...(clearMeasurement
      ? { [config.threshold.metric]: clearMeasurement.durationMs }
      : {}),
  },
  thresholds: clearMeasurement
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
    ...(clearMeasurement
      ? [
          {
            name: clearMeasurement.name,
            durationMs: clearMeasurement.durationMs,
          },
        ]
      : []),
    ...(verifyMeasurement
      ? [
          {
            name: verifyMeasurement.name,
            durationMs: verifyMeasurement.durationMs,
          },
        ]
      : []),
  ],
  details: {
    operation: "clear-stream",
    tableId: fixture?.tableId,
    tableName: fixture?.tableName,
    viewId: fixture?.viewId,
    rowCount: config.rowCount,
    batchSize: config.batchSize,
    request: fixture
      ? {
          method: "PATCH",
          path: `/api/table/${fixture.tableId}/selection/clear-stream`,
          ranges: buildAllCellsRange(fixture).ranges,
          projectionSize: fixture.projection.length,
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
        }
      : undefined,
    clearStream: clearMeasurement?.result,
    fullScan: verifyMeasurement?.result
      ? {
          scannedRecords: verifyMeasurement.result.scannedRecords,
          pageSize: verifyMeasurement.result.pageSize,
          pageCount: verifyMeasurement.result.pageCount,
        }
      : undefined,
    verifiedSamples: verifyMeasurement?.result.verifiedSamples,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
          }
        : undefined,
  },
});

type SelectionClearPrimaryResult = {
  clear: Awaited<ReturnType<typeof clearAllCells>>;
  verify: Measurement<Awaited<ReturnType<typeof assertCellsCleared>>>;
};

// The single measured operation: trace-wrapped clear-stream -> routing
// assertion (inside clearAllCells) -> post-clear full-scan verification. The
// clear duration is the primary metric (clear1kMs); verify is bundled into the
// primary result so buildResult can still emit it as the separate `verify`
// phase the legacy artifact had. selection-clear has no record window, so the
// driver invokes this directly.
const runSelectionClearMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: SelectionClearCaseConfig,
  fixture: ClearFixture,
): Promise<Measurement<SelectionClearPrimaryResult>> => {
  const clearMeasurement = await withPerfTraceStep(
    context,
    perfCase,
    "clear",
    () =>
      measureAsync("clear", () => clearAllCells(fixture, perfCase, context)),
  );
  const verifyMeasurement = await measureAsync("verify", () =>
    assertCellsCleared(fixture, config),
  );
  return {
    name: clearMeasurement.name,
    durationMs: clearMeasurement.durationMs,
    result: {
      clear: clearMeasurement.result,
      verify: verifyMeasurement,
    },
  };
};

// The measured clear empties the reusable seed's cells, so a shared
// (non-isolated) execute DB must be restored to the seed values — or the table
// dropped if restore fails — before the next run reuses it. Isolated CI execute
// DBs are discarded after the job, so no cleanup is needed there.
const cleanupSelectionClearFixture = async ({
  baseId,
  fixture,
  config,
}: {
  baseId: string;
  fixture: ClearFixture | undefined;
  config: SelectionClearCaseConfig;
}) => {
  if (!fixture || isExecuteDbIsolated()) {
    return;
  }
  if (fixture.reusableSeed) {
    try {
      const restoreMeasurement = await measureAsync("restoreSeed", () =>
        restoreClearedCells(fixture, config),
      );
      console.log(
        `[perf-lab] restored selection clear seed table=${fixture.tableId} durationMs=${Math.round(
          restoreMeasurement.durationMs,
        )}`,
      );
    } catch (error) {
      console.warn(
        `Failed to restore cached selection clear seed ${fixture.tableId}; deleting it`,
        error,
      );
      try {
        await permanentDeleteTable(baseId, fixture.tableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup perf table ${fixture.tableId}`,
          cleanupError,
        );
      }
    }
  } else if (fixture.tableId) {
    try {
      await permanentDeleteTable(baseId, fixture.tableId);
    } catch (error) {
      console.warn(`Failed to cleanup perf table ${fixture.tableId}`, error);
    }
  }
};

// selection-clear rides the record-mutation lifecycle: single seeded table, one
// measured clear, post-op verify, restore-or-delete. It omits assertSeedReady
// (seed readiness is confirmed inside prepareClearFixture, which re-verifies a
// cached seed before reuse) so the driver emits no seedReady phase, preserving
// the legacy [prepare, clear, verify] artifact. No record window.
const selectionClearLifecycleSpec: RecordMutationLifecycleSpec<
  SelectionClearCaseConfig,
  ClearFixture,
  never,
  SelectionClearPrimaryResult
> = {
  prepareFixture: ({ baseId, tableName, config, perfCase }) =>
    prepareClearFixture(baseId, tableName, config, perfCase),
  runMeasuredOperation: ({ perfCase, context, config, fixture }) =>
    runSelectionClearMeasuredOperation(perfCase, context, config, fixture),
  // Adapter: the driver hands back one primary measurement; split it back into
  // the legacy clear + verify measurements so buildSelectionClearResult — and
  // therefore the artifact shape — is unchanged.
  buildResult: ({
    config,
    fixture,
    prepareMeasurement,
    primaryMeasurement,
    error,
  }) =>
    buildSelectionClearResult({
      config,
      fixture,
      prepareMeasurement,
      clearMeasurement: primaryMeasurement
        ? {
            name: primaryMeasurement.name,
            durationMs: primaryMeasurement.durationMs,
            result: primaryMeasurement.result.clear,
          }
        : undefined,
      verifyMeasurement: primaryMeasurement?.result.verify,
      error,
    }),
  cleanup: cleanupSelectionClearFixture,
};

export const runSelectionClearCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, selectionClearLifecycleSpec);

// Seed mode stays bespoke (not on seedRecordMutationLifecycle): unlike the
// execute path, the seed artifact intentionally carries a `seedReady` phase
// (the assertCellsRestored full scan), which is exactly the seedReady hook the
// execute path omits. Routing both modes through one shared spec would force
// that asymmetry into the driver, so seed keeps its own thin orchestration here.
export const seedSelectionClearCase = async (
  perfCase: PerfCase,
  _context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as SelectionClearCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const prepareMeasurement = await measureAsync("prepare", () =>
    prepareClearFixture(baseId, tableName, config, perfCase),
  );
  const fixture = prepareMeasurement.result;
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    assertCellsRestored(fixture, config),
  );

  return buildSelectionClearResult({
    config,
    fixture,
    prepareMeasurement,
    verifyMeasurement: {
      name: seedReadyMeasurement.name,
      durationMs: seedReadyMeasurement.durationMs,
      result: {
        scannedRecords: seedReadyMeasurement.result.scannedRecords,
        pageSize: seedReadyMeasurement.result.pageSize,
        pageCount: seedReadyMeasurement.result.pageCount,
        verifiedSamples: seedReadyMeasurement.result.verifiedSamples.map(
          ({ rowOffset, rowNumber, recordId, actual }) => ({
            rowOffset,
            rowNumber,
            recordId,
            actual,
          }),
        ),
      },
    },
  });
};
