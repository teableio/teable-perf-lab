import { FieldKeyType, FieldType } from "@teable/core";
import {
  duplicateField,
  updateRecords,
  uploadAttachment,
} from "@teable/openapi";
import {
  deleteField,
  getFields,
  getRecords,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { chunk } from "../chunk";
import { measureAsync, type Measurement } from "../metrics";
import { forEachRecordPage } from "../record-page-scan";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  PerfRunContext,
  PerfRunResult,
  StoredFieldDuplicateCaseConfig,
} from "../types";
import {
  assertRowsRestored,
  buildRecordFields,
  getExpectedCellValue,
  prepareRecordReplayFixture,
  type RecordReplayFixture,
  type RecordReplayVerification,
} from "./record-replay.shared";
import {
  runFieldAddLifecycle,
  seedFieldAddLifecycle,
  type FieldAddLifecycleSpec,
} from "./field-add-lifecycle";
import {
  getStoredFieldDuplicateSeedIdentity,
  getStoredFieldDuplicateSeedIdentityCase,
  shouldCleanupStoredFieldDuplicateFixture,
} from "./field-duplicate-stored-model";

type NamedField = {
  id: string;
  name: string;
  type?: string;
  isPrimary?: boolean;
};

type StoredFieldDuplicateFixture = RecordReplayFixture & {
  preparePhase: {
    name: string;
    durationMs: number;
  };
};

type StoredFieldDuplicateOperation = {
  field: NamedField;
  status: number;
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
};

type StoredFieldDuplicateVerification = {
  scannedRecords: number;
  pageSize: number;
  pageCount: number;
  sourceField: NamedField;
  duplicatedField: NamedField;
  fieldNames: string[];
  verifiedSamples: Array<{
    rowOffset: number;
    rowNumber: number;
    recordId: string;
    sourceValue: unknown;
    duplicatedValue: unknown;
  }>;
};

type StoredFieldDuplicatePrimary = {
  duplicateFieldMeasurement: Measurement<StoredFieldDuplicateOperation>;
  verifyDuplicatedFieldMeasurement: Measurement<StoredFieldDuplicateVerification>;
};

const buildStructuredSeedRecordFields = (
  config: StoredFieldDuplicateCaseConfig,
  rowNumber: number,
) =>
  config.mode !== "structured"
    ? buildRecordFields(config, rowNumber)
    : Object.fromEntries(
        config.fields
          .filter((field) => field.type !== FieldType.Attachment)
          .map((field) => [
            field.name,
            getExpectedCellValue(field, rowNumber, config),
          ]),
      );

const getUpdatedRecordCount = (data: unknown) =>
  Array.isArray(data)
    ? data.length
    : ((data as { records?: unknown[] })?.records?.length ?? 0);

const finalizeStructuredSeed = async (
  fixture: RecordReplayFixture,
  config: StoredFieldDuplicateCaseConfig,
) => {
  if (config.mode !== "structured") {
    return;
  }
  const sourceField = resolveSourceField(fixture, config);
  if (sourceField.type !== FieldType.Attachment) {
    return;
  }

  const hostRecordId = fixture.seededRecords[0]?.recordId;
  if (!hostRecordId) {
    throw new Error("No seeded record available to host the attachment token");
  }
  const uploaded = await uploadAttachment(
    fixture.tableId,
    hostRecordId,
    sourceField.id,
    Buffer.from("teable perf field duplicate attachment seed\n", "utf8"),
    {
      filename: "perf-attachment-seed.txt",
      contentType: "text/plain",
    },
  );
  expect(uploaded.status).toBe(201);
  const uploadedItems = (uploaded.data.fields[sourceField.id] ?? []) as Array<{
    token?: string;
  }>;
  const token = uploadedItems.find(
    (item) => typeof item.token === "string",
  )?.token;
  if (!token) {
    throw new Error("Attachment upload did not return a reusable token");
  }

  for (const batch of chunk(fixture.seededRecords, config.batchSize)) {
    const response = await updateRecords(fixture.tableId, {
      fieldKeyType: FieldKeyType.Id,
      typecast: false,
      records: batch.map((record) => {
        const expected = getExpectedCellValue(
          sourceField,
          record.rowNumber,
          config,
        ) as Array<{ name: string }>;
        return {
          id: record.recordId,
          fields: {
            [sourceField.id]: expected.map(({ name }) => ({ name, token })),
          },
        };
      }),
    });
    expect(response.status).toBe(200);
    expect(getUpdatedRecordCount(response.data)).toBe(batch.length);
  }
};

const assertExpectedRouting = (
  context: PerfRunContext,
  responseHeaders: Record<string, string>,
) =>
  assertEngineRouting(context, responseHeaders, {
    feature: "duplicateField",
    operation: "Field duplicate",
  });

const resolveSourceField = (
  fixture: RecordReplayFixture,
  config: StoredFieldDuplicateCaseConfig,
) => {
  const sourceField = fixture.fields.find(
    (field) => field.name === config.duplicate.sourceFieldName,
  );
  if (!sourceField) {
    throw new Error(
      `Missing duplicate source field ${config.duplicate.sourceFieldName}; available fields: ${fixture.fields
        .map(({ name }) => name)
        .join(", ")}`,
    );
  }
  return sourceField;
};

const valuesMatch = (left: unknown, right: unknown) =>
  Array.isArray(left) || Array.isArray(right)
    ? JSON.stringify(left) === JSON.stringify(right)
    : Object.is(left, right);

const assertStoredFieldDuplicated = async (
  fixture: RecordReplayFixture,
  config: StoredFieldDuplicateCaseConfig,
  operation: StoredFieldDuplicateOperation,
): Promise<StoredFieldDuplicateVerification> => {
  const fields = (await getFields(fixture.tableId)) as NamedField[];
  const sourceField = fields.find(
    (field) => field.name === config.duplicate.sourceFieldName,
  );
  const duplicatedField = fields.find(
    (field) => field.id === operation.field.id,
  );

  if (!sourceField) {
    throw new Error(
      `Source field ${config.duplicate.sourceFieldName} disappeared after duplicate`,
    );
  }
  if (!duplicatedField) {
    throw new Error(
      `Duplicated field ${operation.field.id} was not returned by field metadata`,
    );
  }

  expect(duplicatedField.name).toBe(config.duplicate.name);
  expect(duplicatedField.type).toBe(sourceField.type);
  expect(duplicatedField.isPrimary).not.toBe(true);

  const fieldNames = fields.map((field) => field.name);
  const expectedFieldNames = [
    ...config.fields.map((field) => field.name),
    config.duplicate.name,
  ];
  expect(fields).toHaveLength(expectedFieldNames.length);
  expect([...fieldNames].sort()).toEqual([...expectedFieldNames].sort());

  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleOffsets = new Set(config.verify.sampleRows);
  const verifiedSamples: StoredFieldDuplicateVerification["verifiedSamples"] =
    [];
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.rowCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          viewId: fixture.viewId,
          fieldKeyType: FieldKeyType.Id,
          projection: [sourceField.id, duplicatedField.id],
          skip,
          take,
        }),
    },
    (record, rowNumber) => {
      const sourceValue = record.fields[sourceField.id];
      const duplicatedValue = record.fields[duplicatedField.id];
      if (!valuesMatch(sourceValue, duplicatedValue)) {
        throw new Error(
          `Duplicated value mismatch at row ${rowNumber}: source ${JSON.stringify(
            sourceValue,
          )}, copy ${JSON.stringify(duplicatedValue)}`,
        );
      }
      if (sampleOffsets.has(rowNumber - 1)) {
        verifiedSamples.push({
          rowOffset: rowNumber - 1,
          rowNumber,
          recordId: record.id,
          sourceValue,
          duplicatedValue,
        });
      }
    },
  );

  const beyondLastPage = await getRecords(fixture.tableId, {
    viewId: fixture.viewId,
    fieldKeyType: FieldKeyType.Id,
    projection: [sourceField.id, duplicatedField.id],
    skip: config.rowCount,
    take: 1,
  });
  expect(beyondLastPage.records).toHaveLength(0);
  expect(verifiedSamples).toHaveLength(config.verify.sampleRows.length);

  return {
    scannedRecords,
    pageSize,
    pageCount,
    sourceField,
    duplicatedField,
    fieldNames,
    verifiedSamples,
  };
};

const buildStoredFieldDuplicateResult = ({
  config,
  fixture,
  seedReadyMeasurement,
  primary,
  error,
}: {
  config: StoredFieldDuplicateCaseConfig;
  fixture: StoredFieldDuplicateFixture;
  seedReadyMeasurement?: Measurement<RecordReplayVerification>;
  primary?: StoredFieldDuplicatePrimary;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    prepareMs: fixture.preparePhase.durationMs,
    ...(fixture.seedCacheInfo
      ? {
          seedCacheHit: fixture.seedCacheHit ? 1 : 0,
          seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
          ...(fixture.seedCacheHit
            ? { seedRestoreMs: fixture.preparePhase.durationMs }
            : fixture.seedCacheInfo.enabled
              ? { seedBuildMs: fixture.preparePhase.durationMs }
              : {}),
        }
      : {}),
    ...(seedReadyMeasurement
      ? { seedReadyMs: seedReadyMeasurement.durationMs }
      : {}),
    ...(primary
      ? {
          [config.threshold.metric]:
            primary.duplicateFieldMeasurement.durationMs,
          verifyDuplicatedFieldMs:
            primary.verifyDuplicatedFieldMeasurement.durationMs,
        }
      : {}),
  },
  thresholds: primary
    ? [
        {
          metric: config.threshold.metric,
          max: getPrimaryThresholdMs(config.threshold.maxMs),
          unit: "ms",
        },
      ]
    : [],
  phases: [
    fixture.preparePhase,
    ...(seedReadyMeasurement
      ? [
          {
            name: seedReadyMeasurement.name,
            durationMs: seedReadyMeasurement.durationMs,
          },
        ]
      : []),
    ...(primary
      ? [
          {
            name: primary.duplicateFieldMeasurement.name,
            durationMs: primary.duplicateFieldMeasurement.durationMs,
          },
          {
            name: primary.verifyDuplicatedFieldMeasurement.name,
            durationMs: primary.verifyDuplicatedFieldMeasurement.durationMs,
          },
        ]
      : []),
  ],
  details: {
    operation: `field-duplicate-${config.mode}`,
    tableId: fixture.tableId,
    tableName: fixture.tableName,
    viewId: fixture.viewId,
    rowCount: config.rowCount,
    batchSize: config.batchSize,
    sourceFieldName: config.duplicate.sourceFieldName,
    duplicatedFieldName: config.duplicate.name,
    sourceField: primary?.verifyDuplicatedFieldMeasurement.result.sourceField,
    duplicatedField:
      primary?.verifyDuplicatedFieldMeasurement.result.duplicatedField,
    response: primary
      ? {
          status: primary.duplicateFieldMeasurement.result.status,
          headers: primary.duplicateFieldMeasurement.result.responseHeaders,
          routing: primary.duplicateFieldMeasurement.result.routing,
        }
      : undefined,
    seed: {
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
    },
    fullScan: primary
      ? {
          scannedRecords:
            primary.verifyDuplicatedFieldMeasurement.result.scannedRecords,
          pageSize: primary.verifyDuplicatedFieldMeasurement.result.pageSize,
          pageCount: primary.verifyDuplicatedFieldMeasurement.result.pageCount,
        }
      : undefined,
    verifiedSamples:
      primary?.verifyDuplicatedFieldMeasurement.result.verifiedSamples,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
          }
        : undefined,
  },
});

const storedFieldDuplicateSpec: FieldAddLifecycleSpec<
  StoredFieldDuplicateCaseConfig,
  StoredFieldDuplicateFixture,
  RecordReplayVerification,
  StoredFieldDuplicatePrimary
> = {
  prepareFixture: async ({ perfCase, baseId, config, seedMode }) => {
    const tableName = `${config.tableNamePrefix}-${seedMode ? "seed-" : ""}${Date.now()}`;
    const prepareMeasurement = await measureAsync("prepare", () =>
      prepareRecordReplayFixture(baseId, tableName, config, {
        perfCase: getStoredFieldDuplicateSeedIdentityCase(
          perfCase,
          config.seedIdentity,
        ),
        runner: "field-duplicate",
        seedIdentity: getStoredFieldDuplicateSeedIdentity(config.seedIdentity),
        seedCodeFiles: [new URL(import.meta.url)],
        ...(config.mode === "structured"
          ? {
              buildSeedRecordFields: buildStructuredSeedRecordFields,
              finalizeSeed: finalizeStructuredSeed,
              verifyCachedSamples: true,
            }
          : {}),
      }),
    );
    return {
      ...prepareMeasurement.result,
      preparePhase: {
        name: prepareMeasurement.name,
        durationMs: prepareMeasurement.durationMs,
      },
    };
  },
  assertSeedReady: ({ fixture, config }) =>
    assertRowsRestored(fixture, config, { verifySamples: true }),
  runPrimary: async ({ perfCase, context, fixture, config }) => {
    const sourceField = resolveSourceField(fixture, config);
    const duplicateFieldMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      config.threshold.metric,
      () =>
        measureAsync(config.threshold.metric, async () => {
          const response = await duplicateField(
            fixture.tableId,
            sourceField.id,
            { name: config.duplicate.name },
          );
          expect([200, 201]).toContain(response.status);
          const responseHeaders = pickRoutingResponseHeaders(
            response.headers as Record<string, unknown>,
          );
          return {
            field: response.data,
            status: response.status,
            responseHeaders,
            routing: assertExpectedRouting(context, responseHeaders),
          };
        }),
    );
    const verifyDuplicatedFieldMeasurement = await measureAsync(
      "verifyDuplicatedField",
      () =>
        assertStoredFieldDuplicated(
          fixture,
          config,
          duplicateFieldMeasurement.result,
        ),
    );
    return { duplicateFieldMeasurement, verifyDuplicatedFieldMeasurement };
  },
  buildResult: ({ config, fixture, seedReadyMeasurement, primary, error }) => {
    if (!fixture) {
      throw new Error(
        "stored field-duplicate buildResult invoked without a fixture",
      );
    }
    return buildStoredFieldDuplicateResult({
      config,
      fixture,
      seedReadyMeasurement,
      primary,
      error,
    });
  },
  cleanup: async ({ baseId, fixture, config }) => {
    if (
      !fixture?.tableId ||
      !shouldCleanupStoredFieldDuplicateFixture({
        executeDbIsolated: isExecuteDbIsolated(),
        reusableSeed: fixture.reusableSeed,
      })
    ) {
      return;
    }
    if (fixture.reusableSeed) {
      try {
        const duplicatedField = (
          (await getFields(fixture.tableId)) as NamedField[]
        ).find((field) => field.name === config.duplicate.name);
        if (duplicatedField) {
          await deleteField(fixture.tableId, duplicatedField.id);
        }
      } catch (error) {
        console.warn(
          `Failed to cleanup duplicated stored field on ${fixture.tableId}`,
          error,
        );
      }
      return;
    }
    try {
      await permanentDeleteTable(baseId, fixture.tableId);
    } catch (error) {
      console.warn(
        `Failed to cleanup stored field-duplicate table ${fixture.tableId}`,
        error,
      );
    }
  },
};

export const seedStoredFieldDuplicateCase = (
  perfCase: PerfCaseFor<"field-duplicate">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedFieldAddLifecycle(perfCase, context, storedFieldDuplicateSpec);

export const runStoredFieldDuplicateCase = (
  perfCase: PerfCaseFor<"field-duplicate">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runFieldAddLifecycle(perfCase, context, storedFieldDuplicateSpec);
