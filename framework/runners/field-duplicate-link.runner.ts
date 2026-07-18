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

type LinkCellItem = { id?: string; title?: string };

const normalizeLinkCellItems = (value: unknown): LinkCellItem[] => {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is LinkCellItem => typeof item === "object" && item !== null,
    );
  }
  return typeof value === "object" && value !== null
    ? [value as LinkCellItem]
    : [];
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
  fixture: TableLinkFixture,
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
    hostFieldNames,
    foreignFieldIds,
    verifiedSamples,
  };
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
}): PerfRunResult => ({
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
    ...(primary
      ? {
          duplicateLinkFieldMs: primary.duplicateFieldMeasurement.durationMs,
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
    sourceField: primary?.verifyDuplicatedFieldMeasurement.result.sourceField,
    duplicatedField:
      primary?.verifyDuplicatedFieldMeasurement.result.duplicatedField,
    foreignFieldIds:
      primary?.verifyDuplicatedFieldMeasurement.result.foreignFieldIds,
    response: primary
      ? {
          status: primary.duplicateFieldMeasurement.result.status,
          headers: primary.duplicateFieldMeasurement.result.responseHeaders,
          routing: primary.duplicateFieldMeasurement.result.routing,
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

const linkFieldDuplicateSpec: FieldAddLifecycleSpec<
  LinkFieldDuplicateCaseConfig,
  LinkFieldDuplicateFixture,
  LinkFieldDuplicateSeedReady,
  LinkFieldDuplicatePrimary
> = {
  prepareFixture: async ({ perfCase, baseId, config, seedMode }) => {
    const tableName = `${config.tableNamePrefix}-${seedMode ? "seed-" : ""}${Date.now()}`;
    const prepareMeasurement = await measureAsync("prepare", () =>
      prepareTableLinkFixture(
        baseId,
        tableName,
        config,
        perfCase,
        "field-duplicate",
      ),
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
