import { FieldKeyType } from "@teable/core";
import { axios, getTableList, getTrashItems, TrashType } from "@teable/openapi";
import { getRecords } from "../../../utils/init-app";
import { getPrimaryThresholdMs } from "../env";
import { measureAsync } from "../metrics";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  PerfRunnerKind,
  RecordUndoRedoBaseCaseConfig,
} from "../types";
import {
  assertRowsRestored,
  getExpectedCellValue,
  prepareRecordUndoRedoFixture,
  type Measurement,
  type RecordReplayVerification,
  type RecordUndoRedoFixture,
} from "./record-undo-redo.shared";

export type TableLifecycleRunnerKind = Extract<
  PerfRunnerKind,
  "table-delete" | "table-restore"
>;

export type TableLifecycleCaseConfig = RecordUndoRedoBaseCaseConfig & {
  threshold: { metric: string; maxMs: number };
};

export type TableLifecycleRoutingHeaders = {
  "x-teable-v2": string;
  "x-teable-v2-feature": string;
  "x-teable-v2-reason": string;
  traceparent: string;
};

export type TableLifecycleRequestResult = {
  status: number;
  responseHeaders: TableLifecycleRoutingHeaders;
};

export type TableTrashLookup = {
  trashId: string;
  deletedTime?: string;
  scannedPages: number;
};

export type TableLifecycleSampleVerification = {
  verifiedSamples: Array<{
    rowOffset: number;
    rowNumber: number;
    recordId: string;
    actual: Record<string, unknown>;
    expected: Record<string, unknown>;
  }>;
  verifiedFieldNames: string[];
};

const TRASH_SCAN_MAX_PAGES = 25;

// Text fields whose seeded values are plain strings, so post-restore sample
// checks stay format-stable across engines (dates/selects need normalization
// that the count-scan verification deliberately avoids).
const SAMPLE_TEXT_FIELD_NAMES = ["Title", "External ID"];

const getResponseHeader = (headers: Record<string, unknown>, name: string) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0]) : String(value ?? "");
};

export const pickTableLifecycleHeaders = (
  headers: Record<string, unknown>,
): TableLifecycleRoutingHeaders => ({
  "x-teable-v2": getResponseHeader(headers, "x-teable-v2"),
  "x-teable-v2-feature": getResponseHeader(headers, "x-teable-v2-feature"),
  "x-teable-v2-reason": getResponseHeader(headers, "x-teable-v2-reason"),
  traceparent: getResponseHeader(headers, "traceparent"),
});

export const prepareTableLifecycleFixture = async (
  baseId: string,
  tableName: string,
  config: TableLifecycleCaseConfig,
  perfCase: PerfCase,
  runner: TableLifecycleRunnerKind,
): Promise<RecordUndoRedoFixture> =>
  prepareRecordUndoRedoFixture(baseId, tableName, config, {
    perfCase,
    runner,
    seedCodeFiles: [
      new URL(import.meta.url),
      runner === "table-delete"
        ? new URL("./table-delete.runner.ts", import.meta.url)
        : new URL("./table-restore.runner.ts", import.meta.url),
    ],
  });

// Archive (move to trash) through the UI route, capturing routing headers.
export const archiveTable = async (
  baseId: string,
  tableId: string,
): Promise<TableLifecycleRequestResult> => {
  const response = await axios.delete(`/base/${baseId}/table/${tableId}`);
  expect(response.status).toBe(200);
  return {
    status: response.status,
    responseHeaders: pickTableLifecycleHeaders(
      response.headers as Record<string, unknown>,
    ),
  };
};

export const restoreTableTrash = async (
  trashId: string,
): Promise<TableLifecycleRequestResult> => {
  const response = await axios.post(`/trash/restore/${trashId}`);
  expect([200, 201]).toContain(response.status);
  return {
    status: response.status,
    responseHeaders: pickTableLifecycleHeaders(
      response.headers as Record<string, unknown>,
    ),
  };
};

export const assertTableNotListed = async (baseId: string, tableId: string) => {
  const response = await getTableList(baseId);
  const stillListed = response.data.some((table) => table.id === tableId);
  if (stillListed) {
    throw new Error(
      `Table ${tableId} is still listed in base ${baseId} after archive`,
    );
  }
  return { listedTables: response.data.length };
};

export const findTableTrashId = async (
  baseId: string,
  tableId: string,
): Promise<TableTrashLookup> => {
  let cursor: string | null | undefined;
  for (let page = 1; page <= TRASH_SCAN_MAX_PAGES; page += 1) {
    const response = await getTrashItems({
      resourceId: baseId,
      resourceType: TrashType.Base,
      cursor,
    });
    const items = response.data.trashItems as Array<{
      id: string;
      resourceId?: string;
      deletedTime?: string;
    }>;
    const match = items.find((item) => item.resourceId === tableId);
    if (match) {
      return {
        trashId: match.id,
        deletedTime: match.deletedTime,
        scannedPages: page,
      };
    }
    cursor = (response.data as { nextCursor?: string | null }).nextCursor;
    if (!cursor || items.length === 0) {
      break;
    }
  }
  throw new Error(
    `Trash item for table ${tableId} not found in base ${baseId} trash`,
  );
};

// Sample value evidence on plain text fields; rows are addressed by view
// offset, which archive/restore does not change.
export const assertSampleTextValues = async (
  fixture: RecordUndoRedoFixture,
  config: TableLifecycleCaseConfig,
): Promise<TableLifecycleSampleVerification> => {
  const sampleFields = fixture.fields.filter((field) =>
    SAMPLE_TEXT_FIELD_NAMES.includes(field.name),
  );
  if (sampleFields.length !== SAMPLE_TEXT_FIELD_NAMES.length) {
    throw new Error(
      `Sample fields ${SAMPLE_TEXT_FIELD_NAMES.join(", ")} not all present in fixture`,
    );
  }

  const verifiedSamples = [];
  for (const rowOffset of config.verify.sampleRows) {
    const rowNumber = rowOffset + 1;
    const result = await getRecords(fixture.tableId, {
      viewId: fixture.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: sampleFields.map((field) => field.id),
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(`Sample row at offset ${rowOffset} not found`);
    }

    const actual: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const field of sampleFields) {
      const expectedValue = getExpectedCellValue(field, rowNumber, config);
      const actualValue = record.fields[field.id];
      actual[field.name] = actualValue;
      expected[field.name] = expectedValue;
      if (actualValue !== expectedValue) {
        throw new Error(
          `Sample row ${rowNumber} ${field.name} mismatch: expected ${String(
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
    verifiedSamples,
    verifiedFieldNames: SAMPLE_TEXT_FIELD_NAMES,
  };
};

export const buildTableLifecycleResult = ({
  config,
  runner,
  prepareMeasurement,
  seedReadyMeasurement,
  setupMeasurements,
  primaryMeasurement,
  verifyMeasurement,
  trashLookup,
  details,
  error,
}: {
  config: TableLifecycleCaseConfig;
  runner: TableLifecycleRunnerKind;
  prepareMeasurement?: Measurement<RecordUndoRedoFixture>;
  seedReadyMeasurement?: Measurement<RecordReplayVerification>;
  setupMeasurements?: Array<Measurement<unknown>>;
  primaryMeasurement?: Measurement<TableLifecycleRequestResult>;
  verifyMeasurement?: Measurement<unknown>;
  trashLookup?: TableTrashLookup;
  details?: Record<string, unknown>;
  error?: unknown;
}): PerfRunResult => {
  const fixture = prepareMeasurement?.result;
  const responseHeaders = primaryMeasurement?.result.responseHeaders;
  const expectedFeature =
    runner === "table-delete" ? "deleteTable" : "restoreTable";
  const routing = responseHeaders
    ? {
        routeMatched:
          responseHeaders["x-teable-v2-feature"] === expectedFeature,
        requestedEngine: process.env.PERF_LAB_ENGINE ?? "local",
        actualV2Header: responseHeaders["x-teable-v2"],
        feature: responseHeaders["x-teable-v2-feature"],
        reason: responseHeaders["x-teable-v2-reason"],
      }
    : undefined;

  return {
    metrics: {
      ...(prepareMeasurement
        ? { prepareMs: prepareMeasurement.durationMs }
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
          }
        : {}),
      ...(seedReadyMeasurement
        ? { seedReadyMs: seedReadyMeasurement.durationMs }
        : {}),
      ...Object.fromEntries(
        (setupMeasurements ?? []).map((measurement) => [
          `${measurement.name}Ms`,
          measurement.durationMs,
        ]),
      ),
      ...(primaryMeasurement
        ? { [config.threshold.metric]: primaryMeasurement.durationMs }
        : {}),
      ...(verifyMeasurement
        ? { [`${verifyMeasurement.name}Ms`]: verifyMeasurement.durationMs }
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
      ...(setupMeasurements ?? []).map((measurement) => ({
        name: measurement.name,
        durationMs: measurement.durationMs,
      })),
      ...(primaryMeasurement
        ? [
            {
              name: config.threshold.metric.replace(/Ms$/, ""),
              durationMs: primaryMeasurement.durationMs,
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
      runner,
      tableId: fixture?.tableId,
      tableName: fixture?.tableName,
      viewId: fixture?.viewId,
      rowCount: config.rowCount,
      batchSize: config.batchSize,
      fieldCount: config.fields.length,
      seed: fixture
        ? {
            ready: seedReadyMeasurement?.result,
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
      trash: trashLookup,
      routing,
      request: primaryMeasurement
        ? {
            status: primaryMeasurement.result.status,
            requestMs: primaryMeasurement.durationMs,
            requestOnlyPrimaryMetric: true,
            responseHeaders,
            routing,
          }
        : undefined,
      ...details,
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

export const seedTableLifecycleCase = async (
  perfCase: PerfCase,
  _context: PerfRunContext,
  runner: TableLifecycleRunnerKind,
): Promise<PerfRunResult> => {
  const config = perfCase.config as TableLifecycleCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const prepareMeasurement = await measureAsync("prepare", () =>
    prepareTableLifecycleFixture(baseId, tableName, config, perfCase, runner),
  );
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    assertRowsRestored(prepareMeasurement.result, config),
  );

  return buildTableLifecycleResult({
    config,
    runner,
    prepareMeasurement,
    seedReadyMeasurement,
  });
};
