import { FieldKeyType, FieldType } from "@teable/core";
import { duplicateField } from "@teable/openapi";
import { deleteField, getFields, getRecords } from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, type Measurement } from "../metrics";
import { forEachRecordPage } from "../record-page-scan";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import { withPerfTraceStep } from "../trace-collector";
import type {
  LinkFieldDuplicateCaseConfig,
  PerfCaseFor,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  runFieldAddLifecycle,
  seedFieldAddLifecycle,
  type FieldAddLifecycleSpec,
} from "./field-add-lifecycle";
import { assertRowsRestored } from "./record-replay.shared";
import {
  assertLinkCellSamples,
  expectedForeignKey,
  foreignRowForMainRow,
  normalizeLinkCellItems,
  permanentDeleteLinkFixture,
  prepareTableLinkFixture,
  type TableLinkFixture,
} from "./table-lifecycle-link.shared";

type NamedLinkField = {
  id: string;
  name: string;
  type?: string;
  isPrimary?: boolean;
  options?: {
    relationship?: string;
    isOneWay?: boolean;
    foreignTableId?: string;
    symmetricFieldId?: string;
  };
};

type LinkFieldDuplicateFixture = TableLinkFixture & {
  preparePhase: {
    name: string;
    durationMs: number;
  };
  completedDuplicateFieldMeasurement?: Measurement<LinkFieldDuplicateOperation>;
  verificationProgress?: LinkFieldDuplicateVerification;
  v2NativeFixture?: {
    reason: string;
    sharedSeedCacheBypassed: boolean;
  };
};

type LinkFieldDuplicateSeedReady = Awaited<
  ReturnType<typeof assertLinkDuplicateSeedReady>
>;

type LinkFieldDuplicateOperation = {
  field: NamedLinkField;
  status: number;
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
};

type LinkFieldDuplicateVerification = {
  scannedRecords: number;
  pageSize: number;
  pageCount: number;
  sourceField: NamedLinkField;
  duplicatedField: NamedLinkField;
  hostFieldNames: string[];
  foreignFieldIds: string[];
  verifiedSamples: Array<{
    rowOffset: number;
    rowNumber: number;
    recordId: string;
    linkTargetId: string;
    linkTargetTitle: string;
    sourceValue: unknown;
    duplicatedValue: unknown;
  }>;
};

type LinkFieldDuplicatePrimary = {
  duplicateFieldMeasurement: Measurement<LinkFieldDuplicateOperation>;
  verifyDuplicatedFieldMeasurement: Measurement<LinkFieldDuplicateVerification>;
};

const assertExpectedRouting = (
  context: PerfRunContext,
  responseHeaders: Record<string, string>,
) =>
  assertEngineRouting(context, responseHeaders, {
    feature: "duplicateField",
    operation: "Link field duplicate",
  });

const resolveSourceField = (
  fixture: TableLinkFixture,
  config: LinkFieldDuplicateCaseConfig,
) => {
  if (fixture.link.fieldName !== config.duplicate.sourceFieldName) {
    throw new Error(
      `Link fixture source ${fixture.link.fieldName} does not match duplicate source ${config.duplicate.sourceFieldName}`,
    );
  }
  return fixture.link.fieldId;
};

const shouldBuildV2NativeFkFixture = (
  config: LinkFieldDuplicateCaseConfig,
  context: PerfRunContext,
) =>
  context.engine === "v2" &&
  (config.link.relationship === "manyOne" ||
    config.link.relationship === "oneOne");

// CI seeds one shared database through the legacy bootstrap engine. An
// FK-backed Link's metadata includes physical host-table identity. V1 bootstrap
// seeds persist that identity in a legacy form that V2 treats as one quoted
// relation name. Rebuilding only the field is insufficient because the host
// table remains legacy. Build the complete deterministic table pair through
// V2 in unmeasured prepare instead; duplicate remains the only primary metric.

const assertLinkDuplicateSeedReady = async (
  fixture: TableLinkFixture,
  config: LinkFieldDuplicateCaseConfig,
) => {
  const rows = await assertRowsRestored(fixture, config, {
    verifySamples: true,
  });
  const links = await assertLinkCellSamples(fixture, config);
  return { ...rows, ...links };
};

const assertLinkFieldDuplicated = async (
  fixture: LinkFieldDuplicateFixture,
  config: LinkFieldDuplicateCaseConfig,
  operation: LinkFieldDuplicateOperation,
): Promise<LinkFieldDuplicateVerification> => {
  const hostFields = (await getFields(fixture.tableId)) as NamedLinkField[];
  const sourceField = hostFields.find(
    (field) => field.id === fixture.link.fieldId,
  );
  const duplicatedField = hostFields.find(
    (field) => field.id === operation.field.id,
  );
  if (!sourceField) {
    throw new Error(`Source Link field ${fixture.link.fieldId} disappeared`);
  }
  if (!duplicatedField) {
    throw new Error(
      `Duplicated Link field ${operation.field.id} was not returned by metadata`,
    );
  }

  expect(sourceField.name).toBe(config.duplicate.sourceFieldName);
  expect(sourceField.type).toBe(FieldType.Link);
  expect(sourceField.options?.relationship).toBe(config.link.relationship);
  expect(Boolean(sourceField.options?.isOneWay)).toBe(config.link.isOneWay);
  expect(sourceField.options?.foreignTableId).toBe(fixture.link.foreignTableId);
  if (config.link.isOneWay) {
    expect(sourceField.options?.symmetricFieldId).toBeUndefined();
  } else {
    expect(sourceField.options?.symmetricFieldId).toBeTruthy();
  }

  expect(duplicatedField.name).toBe(config.duplicate.name);
  expect(duplicatedField.type).toBe(FieldType.Link);
  expect(duplicatedField.isPrimary).not.toBe(true);
  expect(duplicatedField.options?.relationship).toBe(config.link.relationship);
  expect(duplicatedField.options?.foreignTableId).toBe(
    fixture.link.foreignTableId,
  );
  expect(duplicatedField.options?.isOneWay).toBe(true);
  expect(duplicatedField.options?.symmetricFieldId).toBeUndefined();

  const hostFieldNames = hostFields.map((field) => field.name);
  const expectedHostFieldNames = [
    ...config.fields.map((field) => field.name),
    config.duplicate.sourceFieldName,
    config.duplicate.name,
  ];
  expect([...hostFieldNames].sort()).toEqual(
    [...expectedHostFieldNames].sort(),
  );

  const foreignFields = (await getFields(
    fixture.link.foreignTableId,
  )) as NamedLinkField[];
  const foreignFieldIds = foreignFields.map((field) => field.id).sort();
  expect(foreignFieldIds).toEqual([...fixture.link.foreignFieldIds].sort());

  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleOffsets = new Set(config.verify.sampleRows);
  const verifiedSamples: LinkFieldDuplicateVerification["verifiedSamples"] = [];
  const verificationProgress: LinkFieldDuplicateVerification = {
    scannedRecords: 0,
    pageSize,
    pageCount: 0,
    sourceField,
    duplicatedField,
    hostFieldNames,
    foreignFieldIds,
    verifiedSamples,
  };
  fixture.verificationProgress = verificationProgress;
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
      const sourceItems = normalizeLinkCellItems(sourceValue);
      const duplicatedItems = normalizeLinkCellItems(duplicatedValue);
      const sourceIds = sourceItems.map((item) => item.id);
      const duplicatedIds = duplicatedItems.map((item) => item.id);

      if (
        sourceIds.length !== 1 ||
        !sourceIds[0] ||
        JSON.stringify(sourceIds) !== JSON.stringify(duplicatedIds)
      ) {
        throw new Error(
          `Duplicated Link mismatch at row ${rowNumber}: source ${JSON.stringify(
            sourceValue,
          )}, copy ${JSON.stringify(duplicatedValue)}`,
        );
      }

      if (sampleOffsets.has(rowNumber - 1)) {
        const expectedTitle = expectedForeignKey(
          foreignRowForMainRow(rowNumber, config),
          config,
        );
        const sourceTitle = sourceItems[0]?.title;
        const duplicatedTitle = duplicatedItems[0]?.title;
        expect(sourceTitle).toBe(expectedTitle);
        expect(duplicatedTitle).toBe(expectedTitle);
        verifiedSamples.push({
          rowOffset: rowNumber - 1,
          rowNumber,
          recordId: record.id,
          linkTargetId: sourceIds[0],
          linkTargetTitle: expectedTitle,
          sourceValue,
          duplicatedValue,
        });
      }
      verificationProgress.scannedRecords = rowNumber;
      verificationProgress.pageCount = Math.ceil(rowNumber / pageSize);
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

  verificationProgress.scannedRecords = scannedRecords;
  verificationProgress.pageCount = pageCount;
  return verificationProgress;
};

const buildLinkFieldDuplicateResult = ({
  config,
  fixture,
  seedReadyMeasurement,
  primary,
  error,
}: {
  config: LinkFieldDuplicateCaseConfig;
  fixture: LinkFieldDuplicateFixture;
  seedReadyMeasurement?: Measurement<LinkFieldDuplicateSeedReady>;
  primary?: LinkFieldDuplicatePrimary;
  error?: unknown;
}): PerfRunResult => {
  const duplicateFieldMeasurement =
    primary?.duplicateFieldMeasurement ??
    fixture.completedDuplicateFieldMeasurement;
  const verification =
    primary?.verifyDuplicatedFieldMeasurement.result ??
    fixture.verificationProgress;

  return {
    metrics: {
      prepareMs: fixture.preparePhase.durationMs,
      seedCacheHit: fixture.seedCacheHit ? 1 : 0,
      seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
      ...(fixture.seedCacheHit
        ? { seedRestoreMs: fixture.preparePhase.durationMs }
        : fixture.seedCacheInfo.enabled
          ? { seedBuildMs: fixture.preparePhase.durationMs }
          : {}),
      ...(seedReadyMeasurement
        ? { seedReadyMs: seedReadyMeasurement.durationMs }
        : {}),
      ...(duplicateFieldMeasurement
        ? {
            duplicateLinkFieldMs: duplicateFieldMeasurement.durationMs,
          }
        : {}),
      ...(primary
        ? {
            verifyDuplicatedFieldMs:
              primary.verifyDuplicatedFieldMeasurement.durationMs,
          }
        : {}),
    },
    thresholds: duplicateFieldMeasurement
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
      ...(duplicateFieldMeasurement
        ? [
            {
              name: duplicateFieldMeasurement.name,
              durationMs: duplicateFieldMeasurement.durationMs,
            },
          ]
        : []),
      ...(primary
        ? [
            {
              name: primary.verifyDuplicatedFieldMeasurement.name,
              durationMs: primary.verifyDuplicatedFieldMeasurement.durationMs,
            },
          ]
        : []),
    ],
    details: {
      operation: "field-duplicate-link",
      relationship: config.link.relationship,
      sourceIsOneWay: config.link.isOneWay,
      hostTableId: fixture.tableId,
      hostTableName: fixture.tableName,
      foreignTableId: fixture.link.foreignTableId,
      foreignTableName: fixture.link.foreignTableName,
      viewId: fixture.viewId,
      rowCount: config.rowCount,
      foreignRowCount: config.link.foreignTable.rowCount,
      edgeCount: config.rowCount,
      batchSize: config.batchSize,
      sourceField: verification?.sourceField,
      duplicatedField: verification?.duplicatedField,
      foreignFieldIds: verification?.foreignFieldIds,
      response: duplicateFieldMeasurement
        ? {
            status: duplicateFieldMeasurement.result.status,
            headers: duplicateFieldMeasurement.result.responseHeaders,
            routing: duplicateFieldMeasurement.result.routing,
          }
        : undefined,
      seed: {
        cacheHit: fixture.seedCacheHit,
        reusable: fixture.reusableSeed,
        seedHash: fixture.seedCacheInfo.seedHash,
        seedHashShort: fixture.seedCacheInfo.seedHashShort,
        seedTableName: fixture.seedCacheInfo.seedTableName,
        schemaSignature: fixture.seedCacheInfo.schemaSignature,
        ready: seedReadyMeasurement?.result,
      },
      v2NativeFixture: fixture.v2NativeFixture,
      fullScan: verification
        ? {
            scannedRecords: verification.scannedRecords,
            pageSize: verification.pageSize,
            pageCount: verification.pageCount,
            complete: Boolean(primary),
          }
        : undefined,
      verifiedSamples: verification?.verifiedSamples,
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

const linkFieldDuplicateSpec: FieldAddLifecycleSpec<
  LinkFieldDuplicateCaseConfig,
  LinkFieldDuplicateFixture,
  LinkFieldDuplicateSeedReady,
  LinkFieldDuplicatePrimary
> = {
  prepareFixture: async ({ perfCase, context, baseId, config, seedMode }) => {
    const tableName = `${config.tableNamePrefix}-${seedMode ? "seed-" : ""}${Date.now()}`;
    const prepareMeasurement = await measureAsync("prepare", async () => {
      const buildV2NativeFixture =
        !seedMode && shouldBuildV2NativeFkFixture(config, context);
      const fixture = (await prepareTableLinkFixture(
        baseId,
        tableName,
        config,
        perfCase,
        "field-duplicate",
        undefined,
        { bypassSeedCache: buildV2NativeFixture },
      )) as LinkFieldDuplicateFixture;
      if (buildV2NativeFixture) {
        fixture.v2NativeFixture = {
          reason:
            "FK-backed Link duplicate requires V2-native host and foreign table metadata",
          sharedSeedCacheBypassed: Boolean(fixture.seedCacheInfo.enabled),
        };
      }
      return fixture;
    });
    return {
      ...prepareMeasurement.result,
      preparePhase: {
        name: prepareMeasurement.name,
        durationMs: prepareMeasurement.durationMs,
      },
    };
  },
  assertSeedReady: ({ fixture, config }) =>
    assertLinkDuplicateSeedReady(fixture, config),
  runPrimary: async ({ perfCase, context, fixture, config }) => {
    const sourceFieldId = resolveSourceField(fixture, config);
    const duplicateFieldMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      config.threshold.metric,
      () =>
        measureAsync(config.threshold.metric, async () => {
          const response = await duplicateField(
            fixture.tableId,
            sourceFieldId,
            {
              name: config.duplicate.name,
            },
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
    fixture.completedDuplicateFieldMeasurement = duplicateFieldMeasurement;
    const verifyDuplicatedFieldMeasurement = await measureAsync(
      "verifyDuplicatedField",
      () =>
        assertLinkFieldDuplicated(
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
        "link field-duplicate buildResult invoked without a fixture",
      );
    }
    return buildLinkFieldDuplicateResult({
      config,
      fixture,
      seedReadyMeasurement,
      primary,
      error,
    });
  },
  cleanup: async ({ baseId, fixture, config }) => {
    if (isExecuteDbIsolated() || !fixture) {
      return;
    }
    if (fixture.reusableSeed) {
      try {
        const duplicatedField = (
          (await getFields(fixture.tableId)) as NamedLinkField[]
        ).find((field) => field.name === config.duplicate.name);
        if (duplicatedField) {
          await deleteField(fixture.tableId, duplicatedField.id);
        }
      } catch (error) {
        console.warn(
          `Failed to cleanup duplicated Link field on ${fixture.tableId}`,
          error,
        );
      }
      return;
    }
    try {
      const hostFields = (await getFields(fixture.tableId)) as NamedLinkField[];
      const duplicatedField = hostFields.find(
        (field) => field.name === config.duplicate.name,
      );
      if (duplicatedField) {
        await deleteField(fixture.tableId, duplicatedField.id);
      }
      const sourceField = hostFields.find(
        (field) => field.id === fixture.link.fieldId,
      );
      if (sourceField) {
        await deleteField(fixture.tableId, sourceField.id);
      }
    } catch (error) {
      console.warn(
        `Failed to detach Link fields before deleting scratch tables ${fixture.tableId}`,
        error,
      );
    }
    await permanentDeleteLinkFixture(baseId, fixture);
  },
};

export const seedLinkFieldDuplicateCase = (
  perfCase: PerfCaseFor<"field-duplicate">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedFieldAddLifecycle(perfCase, context, linkFieldDuplicateSpec);

export const runLinkFieldDuplicateCase = (
  perfCase: PerfCaseFor<"field-duplicate">,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as LinkFieldDuplicateCaseConfig;
  if (config.v2Only && context.engine !== "v2") {
    return Promise.resolve({
      result: "skipped",
      metrics: {},
      thresholds: [],
      details: {
        operation: "field-duplicate-link",
        skipped: true,
        skippedReason: config.v2Only.reason,
        requestedEngine: context.engine,
        relationship: config.link.relationship,
        sourceIsOneWay: config.link.isOneWay,
        rowCount: config.rowCount,
      },
    });
  }
  return runFieldAddLifecycle(perfCase, context, linkFieldDuplicateSpec);
};
