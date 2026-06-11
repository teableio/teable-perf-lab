import { deleteFields as apiDeleteFields } from "@teable/openapi";
import { getFields, permanentDeleteTable } from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import type {
  FieldDeleteCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import { PerfRunDiagnosticError } from "../types";
import {
  assertRowsRestored,
  buildRecordWindowId,
  prepareRecordUndoRedoFixture,
  withRecordWindowId,
  type Measurement,
  type RecordReplayVerification,
  type RecordUndoRedoFixture,
} from "./record-undo-redo.shared";

type NamedField = {
  id: string;
  name: string;
  type?: string;
};

type FieldDeletePrimaryResult = {
  deletedFieldIds: string[];
  responseHeaders: Record<string, string>;
  routing: {
    requestedEngine: string;
    expectedXTeableV2: string;
    actualXTeableV2: string;
    routeMatched: boolean;
    xTeableV2Feature: string;
    xTeableV2Reason: string;
  };
};

type FieldDeleteVerification = RecordReplayVerification & {
  remainingFieldCount: number;
  remainingFieldNames: string[];
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

const assertExpectedRouting = (
  context: PerfRunContext,
  responseHeaders: Record<string, string>,
) => {
  const expectedXTeableV2 = context.engine === "v2" ? "true" : "false";
  const actualXTeableV2 = responseHeaders["x-teable-v2"];
  if (actualXTeableV2 !== expectedXTeableV2) {
    throw new Error(
      `Field delete did not use expected ${context.engine.toUpperCase()} route; expected x-teable-v2=${expectedXTeableV2}, got ${actualXTeableV2}; headers=${JSON.stringify(
        responseHeaders,
      )}`,
    );
  }

  return {
    requestedEngine: context.engine,
    expectedXTeableV2,
    actualXTeableV2,
    routeMatched: true,
    xTeableV2Feature: responseHeaders["x-teable-v2-feature"],
    xTeableV2Reason: responseHeaders["x-teable-v2-reason"],
  };
};

const resolveDeleteFieldIds = (
  fixture: RecordUndoRedoFixture,
  config: FieldDeleteCaseConfig,
) => {
  const fieldByName = new Map(
    fixture.fields.map((field) => [field.name, field]),
  );
  return config.delete.fieldNames.map((fieldName) => {
    const field = fieldByName.get(fieldName);
    if (!field) {
      throw new Error(
        `Missing deletable field ${fieldName}; available fields: ${fixture.fields
          .map(({ name }) => name)
          .join(", ")}`,
      );
    }
    return field.id;
  });
};

const runFieldDeletePrimary = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: RecordUndoRedoFixture,
  config: FieldDeleteCaseConfig,
  deleteFieldIds: string[],
): Promise<FieldDeletePrimaryResult> => {
  const deleteResponse = await withPerfTraceStep(
    context,
    perfCase,
    config.threshold.metric,
    () => apiDeleteFields(fixture.tableId, deleteFieldIds),
  );
  expect(deleteResponse.status).toBe(200);

  const responseHeaders = pickResponseHeaders(
    deleteResponse.headers as Record<string, unknown>,
  );
  const routing = assertExpectedRouting(context, responseHeaders);

  return {
    deletedFieldIds: deleteFieldIds,
    responseHeaders,
    routing,
  };
};

const assertFieldsDeleted = async (
  fixture: RecordUndoRedoFixture,
  config: FieldDeleteCaseConfig,
): Promise<FieldDeleteVerification> => {
  const fields = (await getFields(fixture.tableId)) as NamedField[];
  const remainingFieldNames = fields.map((field) => field.name);
  const deletedNames = new Set(config.delete.fieldNames);

  const stillPresent = remainingFieldNames.filter((name) =>
    deletedNames.has(name),
  );
  if (stillPresent.length > 0) {
    throw new Error(
      `Expected fields deleted but still present: ${stillPresent.join(", ")}`,
    );
  }

  const expectedRemaining = config.fields
    .map((field) => field.name)
    .filter((name) => !deletedNames.has(name));
  const missingRemaining = expectedRemaining.filter(
    (name) => !remainingFieldNames.includes(name),
  );
  if (missingRemaining.length > 0) {
    throw new Error(
      `Expected surviving fields missing after delete: ${missingRemaining.join(", ")}`,
    );
  }

  const survivingProjection = fixture.fields
    .filter((field) => !deletedNames.has(field.name))
    .map((field) => field.id);
  const rowScan = await assertRowsRestored(
    { ...fixture, projection: survivingProjection },
    config,
  );

  return {
    ...rowScan,
    remainingFieldCount: fields.length,
    remainingFieldNames,
  };
};

const cleanupFieldDeleteFixture = async (
  baseId: string,
  fixture: RecordUndoRedoFixture | undefined,
  options: {
    deleteAttempted: boolean;
  },
) => {
  if (!fixture?.tableId) {
    return;
  }

  // CI execute jobs run on an isolated restored copy of the seed dump, so the
  // mutated database is simply discarded after the job.
  if (fixture.reusableSeed && isExecuteDbIsolated()) {
    return;
  }

  if (fixture.reusableSeed && !options.deleteAttempted) {
    return;
  }

  // The measured operation dropped seed field columns. Verifying a partial
  // restore (field structure plus every cell value) costs more than rebuilding
  // the fixture, so delete the table and let the next local run reseed it.
  try {
    await permanentDeleteTable(baseId, fixture.tableId);
  } catch (error) {
    console.warn(
      `Failed to cleanup perf field delete table ${fixture.tableId}`,
      error,
    );
  }
};

const buildFieldDeleteResult = ({
  config,
  windowId,
  fixture,
  prepareMeasurement,
  seedReadyMeasurement,
  operationMeasurement,
  verifyMeasurement,
  error,
}: {
  config: FieldDeleteCaseConfig;
  windowId?: string;
  fixture?: RecordUndoRedoFixture;
  prepareMeasurement?: Measurement<RecordUndoRedoFixture>;
  seedReadyMeasurement?: Measurement<RecordReplayVerification>;
  operationMeasurement?: Measurement<FieldDeletePrimaryResult>;
  verifyMeasurement?: Measurement<FieldDeleteVerification>;
  error?: unknown;
}): PerfRunResult => {
  const primaryResult = operationMeasurement?.result;

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
      ...(operationMeasurement
        ? { [config.threshold.metric]: operationMeasurement.durationMs }
        : {}),
      ...(verifyMeasurement
        ? { verifyDeletedMs: verifyMeasurement.durationMs }
        : {}),
    },
    thresholds: operationMeasurement
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
      ...(operationMeasurement
        ? [
            {
              name: operationMeasurement.name,
              durationMs: operationMeasurement.durationMs,
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
      operation: "field-delete",
      windowId,
      tableId: fixture?.tableId,
      tableName: fixture?.tableName,
      viewId: fixture?.viewId,
      rowCount: config.rowCount,
      seedFieldCount: config.fields.length,
      deleteFieldCount: config.delete.fieldNames.length,
      deleteFieldNames: config.delete.fieldNames,
      deletedFieldIds: primaryResult?.deletedFieldIds,
      responseHeaders: primaryResult?.responseHeaders,
      routing: primaryResult?.routing,
      remainingFields: verifyMeasurement
        ? {
            count: verifyMeasurement.result.remainingFieldCount,
            names: verifyMeasurement.result.remainingFieldNames,
          }
        : undefined,
      seed: fixture
        ? {
            seededRecords: fixture.seededRecords.length,
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
      fullScan: verifyMeasurement?.result
        ? {
            scannedRecords: verifyMeasurement.result.scannedRecords,
            pageSize: verifyMeasurement.result.pageSize,
            pageCount: verifyMeasurement.result.pageCount,
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

export const seedFieldDeleteCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FieldDeleteCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const prepareMeasurement = await measureAsync("prepare", () =>
    prepareRecordUndoRedoFixture(baseId, tableName, config, {
      perfCase,
      runner: "field-delete",
      seedCodeFiles: [new URL(import.meta.url)],
    }),
  );
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    assertRowsRestored(prepareMeasurement.result, config),
  );

  return buildFieldDeleteResult({
    config,
    windowId: `seed-${context.runId}-${perfCase.id}`,
    fixture: prepareMeasurement.result,
    prepareMeasurement,
    seedReadyMeasurement,
  });
};

export const runFieldDeleteCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FieldDeleteCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const windowId = buildRecordWindowId(context, perfCase);
  let prepareMeasurement: Measurement<RecordUndoRedoFixture> | undefined;
  let deleteAttempted = false;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareRecordUndoRedoFixture(baseId, tableName, config, {
        perfCase,
        runner: "field-delete",
        seedCodeFiles: [new URL(import.meta.url)],
      }),
    );
    const fixture = prepareMeasurement.result;
    let seedReadyMeasurement: Measurement<RecordReplayVerification> | undefined;
    let operationMeasurement: Measurement<FieldDeletePrimaryResult> | undefined;
    let verifyMeasurement: Measurement<FieldDeleteVerification> | undefined;

    try {
      seedReadyMeasurement = await measureAsync("seedReady", () =>
        assertRowsRestored(fixture, config),
      );
      const deleteFieldIds = resolveDeleteFieldIds(fixture, config);

      await withRecordWindowId(windowId, async () => {
        deleteAttempted = true;
        operationMeasurement = await measureAsync(config.threshold.metric, () =>
          runFieldDeletePrimary(
            perfCase,
            context,
            fixture,
            config,
            deleteFieldIds,
          ),
        );
      });

      verifyMeasurement = await measureAsync("verifyDeleted", () =>
        assertFieldsDeleted(fixture, config),
      );
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildFieldDeleteResult({
          config,
          windowId,
          fixture,
          prepareMeasurement,
          seedReadyMeasurement,
          operationMeasurement,
          verifyMeasurement,
          error,
        }),
      );
    }

    return buildFieldDeleteResult({
      config,
      windowId,
      fixture,
      prepareMeasurement,
      seedReadyMeasurement,
      operationMeasurement,
      verifyMeasurement,
    });
  } finally {
    await cleanupFieldDeleteFixture(baseId, prepareMeasurement?.result, {
      deleteAttempted,
    });
  }
};
