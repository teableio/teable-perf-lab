import { deleteFields as apiDeleteFields } from "@teable/openapi";
import { getFields, permanentDeleteTable } from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  FieldDeleteCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import { type Measurement } from "../metrics";
import {
  assertRowsRestored,
  type RecordReplayVerification,
  type RecordReplayFixture,
} from "./record-replay.shared";
import {
  runFieldDeleteLifecycle,
  seedFieldDeleteLifecycle,
  type FieldDeleteLifecycleSpec,
} from "./field-delete-lifecycle";

type NamedField = {
  id: string;
  name: string;
  type?: string;
};

type FieldDeletePrimaryResult = {
  deletedFieldIds: string[];
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
};

type FieldDeleteVerification = RecordReplayVerification & {
  remainingFieldCount: number;
  remainingFieldNames: string[];
};

const pickResponseHeaders = pickRoutingResponseHeaders;

const assertExpectedRouting = (
  context: PerfRunContext,
  responseHeaders: Record<string, string>,
) =>
  assertEngineRouting(context, responseHeaders, {
    feature: "deleteField",
    operation: "Field delete",
  });

const resolveDeleteFieldIds = (
  fixture: RecordReplayFixture,
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
  fixture: RecordReplayFixture,
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
  fixture: RecordReplayFixture,
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
  fixture: RecordReplayFixture | undefined,
  options: {
    deleteAttempted: boolean;
  },
) => {
  if (!fixture?.tableId) {
    return;
  }

  // CI execute jobs run on an isolated restored copy of the seed dump, so the
  // mutated database is simply discarded after the job.
  if (isExecuteDbIsolated()) {
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
  fixture?: RecordReplayFixture;
  prepareMeasurement?: Measurement<RecordReplayFixture>;
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

const fieldDeleteLifecycleSpec: FieldDeleteLifecycleSpec<
  FieldDeletePrimaryResult,
  FieldDeleteVerification,
  string[]
> = {
  seedCodeFile: new URL(import.meta.url),
  resolveOperationInput: ({ fixture, config }) =>
    resolveDeleteFieldIds(fixture, config),
  runOperation: ({ perfCase, context, fixture, config, operationInput }) =>
    runFieldDeletePrimary(perfCase, context, fixture, config, operationInput),
  verify: ({ fixture, config }) => assertFieldsDeleted(fixture, config),
  buildResult: buildFieldDeleteResult,
  cleanup: cleanupFieldDeleteFixture,
};

export const seedFieldDeleteCase = async (
  perfCase: PerfCaseFor<"field-delete">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedFieldDeleteLifecycle(perfCase, context, fieldDeleteLifecycleSpec);

export const runFieldDeleteCase = async (
  perfCase: PerfCaseFor<"field-delete">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runFieldDeleteLifecycle(perfCase, context, fieldDeleteLifecycleSpec);
