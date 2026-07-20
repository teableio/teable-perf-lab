import { FieldKeyType } from "@teable/core";
import { createRecords, deleteRecords } from "@teable/openapi";
import {
  getFields,
  getRecords,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { chunk } from "../chunk";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, roundMetric, type Measurement } from "../metrics";
import { pollUntilReady } from "../readiness";
import { forEachRecordPage } from "../record-page-scan";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import { withPerfTraceStep } from "../trace-collector";
import type {
  ConditionalLookupRecordCreateCaseConfig,
  PerfCase,
  PerfCaseFor,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  buildConditionalLookupDirtyHostRows,
  lookupTextValues,
  type ConditionalLookupDirtyHostRow,
} from "./conditional-lookup-record-create-model";
import {
  assertConditionalLookupSeedReady,
  cleanupConditionalComputedFields,
  createConditionalLookupFieldWithRouting,
  getExpectedValue,
  getSourceRowNumberForHostRow,
  parseConditionalSeedRowNumber,
  prepareConditionalComputedSeedFixture,
  waitForConditionalLookupFullScan,
  type ConditionalLookupFullScan,
  type ConditionalLookupSeedFixture,
} from "./conditional-lookup.runner";
import {
  runRecordMutationLifecycle,
  seedRecordMutationLifecycle,
  shouldRestoreSharedMutableSeed,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

type LookupSetup = {
  fieldId: string;
  createFieldMeasurement: Measurement<{
    field: { id: string };
    responseHeaders: Record<string, string>;
    routing: EngineRouting;
  }>;
  readyMeasurement: Measurement<ConditionalLookupFullScan>;
};

type ConditionalLookupRecordCreateFixture = ConditionalLookupSeedFixture & {
  lookupSetup?: LookupSetup;
};

type DirtyVerification = {
  checkedRecords: number;
  verifiedSamples: Array<{
    dirtyOffset: number;
    hostRowNumber: number;
    sourceRowNumber: number;
    recordId: string;
    actual: string[];
    expected: string[];
  }>;
};

type FinalFullScan = {
  scannedRecords: number;
  pageCount: number;
  pageSize: number;
  seedRecords: number;
  dirtyRecords: number;
  verifiedSamples: Array<{
    kind: "seed" | "dirty";
    hostRowNumber: number;
    sourceRowNumber: number;
    recordId: string;
    actual: string[];
    expected: string[];
  }>;
};

type ConditionalLookupRecordCreatePrimary = {
  createStatus: number;
  createRequestMs: number;
  createdRecordIds: string[];
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
  dirtyRecordsReadyMs: number;
  dirtyVerification: DirtyVerification;
  finalFullScanMs: number;
  finalFullScan: FinalFullScan;
};

const V2_ONLY_REASON =
  "This regression targets the V2 sync computed-update dirty-host scope; V1 does not execute the same query-builder path.";
const CLEANUP_BATCH_SIZE = 100;

const sameTextValues = (actual: unknown, expected: string) => {
  const normalized = lookupTextValues(actual);
  if (JSON.stringify(normalized) !== JSON.stringify([expected])) {
    throw new Error(
      `Conditional lookup mismatch: expected ${JSON.stringify([expected])}, actual ${JSON.stringify(normalized)}`,
    );
  }
  return normalized;
};

const prepareFixture = async ({
  baseId,
  perfCase,
  context,
  config,
}: {
  baseId: string;
  perfCase: PerfCase;
  context: PerfRunContext;
  config: ConditionalLookupRecordCreateCaseConfig;
}): Promise<ConditionalLookupRecordCreateFixture> => {
  const seedMode = process.env.PERF_LAB_MODE === "seed";
  const fixture = await prepareConditionalComputedSeedFixture({
    perfCase,
    context,
    baseId,
    config,
    seedMode,
  });
  if (seedMode) {
    return fixture;
  }

  try {
    await cleanupConditionalComputedFields(
      fixture.hostTableId,
      await getFields(fixture.hostTableId),
    );
    await assertConditionalLookupSeedReady(
      fixture.sourceTableId,
      fixture.hostTableId,
      fixture.sourceFields,
      fixture.hostFields,
      config,
      fixture.sampleRecords,
    );
    const createFieldMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      "createLookupFieldSetup",
      () =>
        measureAsync("createLookupFieldSetup", () =>
          createConditionalLookupFieldWithRouting(
            context,
            fixture.hostTableId,
            fixture.sourceTableId,
            fixture.sourceFields,
            fixture.hostFields,
            config,
          ),
        ),
    );
    const readyMeasurement = await measureAsync("lookupSetupReady", () =>
      waitForConditionalLookupFullScan(
        fixture.hostTableId,
        createFieldMeasurement.result.field.id,
        config,
        fixture.hostFields,
      ),
    );
    return {
      ...fixture,
      lookupSetup: {
        fieldId: createFieldMeasurement.result.field.id,
        createFieldMeasurement,
        readyMeasurement,
      },
    };
  } catch (error) {
    try {
      await cleanupConditionalComputedFields(
        fixture.hostTableId,
        await getFields(fixture.hostTableId),
      );
    } catch (cleanupError) {
      console.warn(
        `Failed to clean conditional lookup setup on ${fixture.hostTableId}`,
        cleanupError,
      );
    }
    throw error;
  }
};

const assertDirtyRecordsReady = async (
  fixture: ConditionalLookupRecordCreateFixture,
  config: ConditionalLookupRecordCreateCaseConfig,
  dirtyRows: ConditionalLookupDirtyHostRow[],
  createdRecordIds: string[],
): Promise<DirtyVerification> => {
  const lookupFieldId = fixture.lookupSetup?.fieldId;
  if (!lookupFieldId) {
    throw new Error("Conditional lookup field setup is missing");
  }
  const result = await getRecords(fixture.hostTableId, {
    fieldKeyType: FieldKeyType.Id,
    projection: [
      fixture.hostFields.keyFieldId,
      fixture.hostFields.lookupKeyFieldId,
      lookupFieldId,
    ],
    selectedRecordIds: createdRecordIds,
  });
  if (result.records.length !== dirtyRows.length) {
    throw new Error(
      `Expected ${dirtyRows.length} dirty host records, got ${result.records.length}`,
    );
  }

  const dirtyByHostKey = new Map(dirtyRows.map((row) => [row.hostKey, row]));
  const wantedSamples = new Set(config.verify.dirtySampleRows);
  const seenHostKeys = new Set<string>();
  const verifiedSamples: DirtyVerification["verifiedSamples"] = [];
  for (const record of result.records) {
    const hostKey = record.fields[fixture.hostFields.keyFieldId];
    if (typeof hostKey !== "string") {
      throw new Error(`Dirty host key is not a string: ${String(hostKey)}`);
    }
    const expected = dirtyByHostKey.get(hostKey);
    if (!expected) {
      throw new Error(`Unexpected dirty host key ${hostKey}`);
    }
    if (seenHostKeys.has(hostKey)) {
      throw new Error(`Duplicate dirty host key ${hostKey}`);
    }
    seenHostKeys.add(hostKey);
    const actualLookupKey = record.fields[fixture.hostFields.lookupKeyFieldId];
    if (actualLookupKey !== expected.lookupKey) {
      throw new Error(
        `Dirty host ${hostKey} lookup key mismatch: expected ${expected.lookupKey}, actual ${String(actualLookupKey)}`,
      );
    }
    const actual = sameTextValues(
      record.fields[lookupFieldId],
      expected.expectedValue,
    );
    if (wantedSamples.has(expected.dirtyOffset)) {
      verifiedSamples.push({
        dirtyOffset: expected.dirtyOffset,
        hostRowNumber: expected.hostRowNumber,
        sourceRowNumber: expected.sourceRowNumber,
        recordId: record.id,
        actual,
        expected: [expected.expectedValue],
      });
    }
  }
  verifiedSamples.sort((left, right) => left.dirtyOffset - right.dirtyOffset);
  return { checkedRecords: seenHostKeys.size, verifiedSamples };
};

const assertFinalFullScan = async (
  fixture: ConditionalLookupRecordCreateFixture,
  config: ConditionalLookupRecordCreateCaseConfig,
  dirtyRows: ConditionalLookupDirtyHostRow[],
): Promise<FinalFullScan> => {
  const lookupFieldId = fixture.lookupSetup?.fieldId;
  if (!lookupFieldId) {
    throw new Error("Conditional lookup field setup is missing");
  }
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const totalRows = config.recordCount + config.mutation.recordCount;
  const seedSampleRows = new Set(config.verify.sampleRows);
  const dirtySampleRows = new Set(config.verify.dirtySampleRows);
  const dirtyByHostRow = new Map(
    dirtyRows.map((row) => [row.hostRowNumber, row]),
  );
  const seenHostRows = new Set<number>();
  const verifiedSamples: FinalFullScan["verifiedSamples"] = [];
  let seedRecords = 0;
  let dirtyRecords = 0;

  const scan = await forEachRecordPage(
    {
      totalRows,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(fixture.hostTableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: [
            fixture.hostFields.keyFieldId,
            fixture.hostFields.lookupKeyFieldId,
            lookupFieldId,
          ],
          skip,
          take,
        }),
    },
    (record) => {
      const hostRowNumber = parseConditionalSeedRowNumber(
        record.fields[fixture.hostFields.keyFieldId],
        config.generator.hostKeyPrefix,
      );
      if (seenHostRows.has(hostRowNumber)) {
        throw new Error(`Duplicate host row ${hostRowNumber} in final scan`);
      }
      seenHostRows.add(hostRowNumber);

      const dirty = dirtyByHostRow.get(hostRowNumber);
      const kind = dirty ? "dirty" : "seed";
      const sourceRowNumber = dirty
        ? dirty.sourceRowNumber
        : getSourceRowNumberForHostRow(hostRowNumber, config);
      const expectedLookupKey = dirty
        ? dirty.lookupKey
        : `${config.generator.sourceKeyPrefix}-${sourceRowNumber}`;
      const expectedValue = dirty
        ? dirty.expectedValue
        : getExpectedValue(sourceRowNumber, config);
      if (
        record.fields[fixture.hostFields.lookupKeyFieldId] !== expectedLookupKey
      ) {
        throw new Error(
          `Host row ${hostRowNumber} lookup key mismatch: expected ${expectedLookupKey}, actual ${String(record.fields[fixture.hostFields.lookupKeyFieldId])}`,
        );
      }
      const actual = sameTextValues(
        record.fields[lookupFieldId],
        expectedValue,
      );
      if (dirty) {
        dirtyRecords += 1;
      } else {
        if (hostRowNumber < 1 || hostRowNumber > config.recordCount) {
          throw new Error(`Unexpected host row ${hostRowNumber} in final scan`);
        }
        seedRecords += 1;
      }

      const sampleWanted = dirty
        ? dirtySampleRows.has(dirty.dirtyOffset)
        : seedSampleRows.has(hostRowNumber - 1);
      if (sampleWanted) {
        verifiedSamples.push({
          kind,
          hostRowNumber,
          sourceRowNumber,
          recordId: record.id,
          actual,
          expected: [expectedValue],
        });
      }
    },
  );

  if (
    scan.scannedRecords !== totalRows ||
    seedRecords !== config.recordCount ||
    dirtyRecords !== config.mutation.recordCount
  ) {
    throw new Error(
      `Final lookup scan count mismatch: total=${scan.scannedRecords}/${totalRows}, seed=${seedRecords}/${config.recordCount}, dirty=${dirtyRecords}/${config.mutation.recordCount}`,
    );
  }
  return {
    ...scan,
    pageSize,
    seedRecords,
    dirtyRecords,
    verifiedSamples,
  };
};

const runMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: ConditionalLookupRecordCreateCaseConfig,
  fixture: ConditionalLookupRecordCreateFixture,
) => {
  const lookupFieldId = fixture.lookupSetup?.fieldId;
  if (!lookupFieldId) {
    throw new Error("Conditional lookup field setup is missing before create");
  }
  const dirtyRows = buildConditionalLookupDirtyHostRows(config);
  return withPerfTraceStep(context, perfCase, config.threshold.metric, () =>
    measureAsync(config.threshold.metric, async () => {
      const createMeasurement = await measureAsync(
        "createDirtyHostRecords",
        () =>
          createRecords(fixture.hostTableId, {
            fieldKeyType: FieldKeyType.Id,
            typecast: false,
            records: dirtyRows.map((row) => ({
              fields: {
                [fixture.hostFields.keyFieldId]: row.hostKey,
                [fixture.hostFields.lookupKeyFieldId]: row.lookupKey,
              },
            })),
          }),
      );
      expect(createMeasurement.result.status).toBe(201);
      const createdRecordIds = createMeasurement.result.data.records.map(
        (record) => record.id,
      );
      if (createdRecordIds.length !== dirtyRows.length) {
        throw new Error(
          `Expected ${dirtyRows.length} created record ids, got ${createdRecordIds.length}`,
        );
      }
      const responseHeaders = pickRoutingResponseHeaders(
        createMeasurement.result.headers as Record<string, unknown>,
      );
      const routing = assertEngineRouting(context, responseHeaders, {
        operation: "conditional lookup dirty host createRecords",
      });
      const dirtyReadyMeasurement = await measureAsync(
        "dirtyRecordsReady",
        () =>
          pollUntilReady(
            {
              timeoutMs: config.verify.timeoutMs ?? 60_000,
              pollIntervalMs: config.verify.pollIntervalMs ?? 500,
              description: "conditional lookup values on dirty host records",
            },
            () =>
              assertDirtyRecordsReady(
                fixture,
                config,
                dirtyRows,
                createdRecordIds,
              ),
          ),
      );
      const finalFullScanMeasurement = await measureAsync("finalFullScan", () =>
        assertFinalFullScan(fixture, config, dirtyRows),
      );
      return {
        createStatus: createMeasurement.result.status,
        createRequestMs: createMeasurement.durationMs,
        createdRecordIds,
        responseHeaders,
        routing,
        dirtyRecordsReadyMs: dirtyReadyMeasurement.durationMs,
        dirtyVerification: dirtyReadyMeasurement.result,
        finalFullScanMs: finalFullScanMeasurement.durationMs,
        finalFullScan: finalFullScanMeasurement.result,
      };
    }),
  );
};

const buildResult = ({
  config,
  fixture,
  prepareMeasurement,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  config: ConditionalLookupRecordCreateCaseConfig;
  fixture?: ConditionalLookupRecordCreateFixture;
  prepareMeasurement?: Measurement<ConditionalLookupRecordCreateFixture>;
  seedReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertConditionalLookupSeedReady>>
  >;
  primaryMeasurement?: Measurement<ConditionalLookupRecordCreatePrimary>;
  error?: unknown;
}): PerfRunResult => {
  const setup = fixture?.lookupSetup;
  const primary = primaryMeasurement?.result;
  const seedBuildMs = fixture
    ? roundMetric(
        fixture.createTablesMeasurement.durationMs +
          fixture.seedSourceMeasurement.durationMs +
          fixture.seedHostMeasurement.durationMs,
      )
    : undefined;
  return {
    metrics: {
      ...(prepareMeasurement
        ? {
            conditionalLookupRecordCreatePrepareMs:
              prepareMeasurement.durationMs,
          }
        : {}),
      ...(fixture
        ? {
            seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
            seedCacheHit: fixture.seedCacheHit ? 1 : 0,
            ...(fixture.seedCacheHit
              ? { seedRestoreMs: fixture.createTablesMeasurement.durationMs }
              : fixture.seedCacheInfo.enabled && seedBuildMs != null
                ? { seedBuildMs }
                : {}),
            createTablesMs: fixture.createTablesMeasurement.durationMs,
            seedSourceRecordsMs: fixture.seedSourceMeasurement.durationMs,
            seedHostRecordsMs: fixture.seedHostMeasurement.durationMs,
            maxSeedBatchMs: roundMetric(
              Math.max(
                ...fixture.sourceBatchDurations,
                ...fixture.hostBatchDurations,
              ),
            ),
          }
        : {}),
      ...(seedReadyMeasurement
        ? { seedReadyMs: seedReadyMeasurement.durationMs }
        : {}),
      ...(setup
        ? {
            createLookupFieldSetupMs: setup.createFieldMeasurement.durationMs,
            lookupSetupReadyMs: setup.readyMeasurement.durationMs,
          }
        : {}),
      ...(primaryMeasurement
        ? {
            conditionalLookupRecordCreateReadyMs: primaryMeasurement.durationMs,
            createDirtyHostRecordsMs: primary?.createRequestMs ?? 0,
            dirtyRecordsReadyMs: primary?.dirtyRecordsReadyMs ?? 0,
            finalFullScanMs: primary?.finalFullScanMs ?? 0,
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
      ...(fixture
        ? [
            fixture.createTablesMeasurement,
            fixture.seedSourceMeasurement,
            fixture.seedHostMeasurement,
          ].map(({ name, durationMs }) => ({ name, durationMs }))
        : []),
      ...(setup
        ? [
            {
              name: setup.createFieldMeasurement.name,
              durationMs: setup.createFieldMeasurement.durationMs,
            },
            {
              name: setup.readyMeasurement.name,
              durationMs: setup.readyMeasurement.durationMs,
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
      ...(primaryMeasurement
        ? [
            {
              name: primaryMeasurement.name,
              durationMs: primaryMeasurement.durationMs,
            },
          ]
        : []),
    ],
    details: {
      operation: "conditional-lookup-record-create",
      sourceTableId: fixture?.sourceTableId,
      sourceTableName: fixture?.sourceTableName,
      hostTableId: fixture?.hostTableId,
      hostTableName: fixture?.hostTableName,
      seedRecordCount: config.recordCount,
      dirtyRecordCount: config.mutation.recordCount,
      totalRecordCount: config.recordCount + config.mutation.recordCount,
      cache: fixture
        ? {
            enabled: fixture.seedCacheInfo.enabled,
            cacheHit: fixture.seedCacheHit,
            reusable: fixture.reusable,
            sharedSeedIdentity: "conditional-computed/shared-10k-seed",
            seedHash: fixture.seedCacheInfo.seedHash,
            seedHashShort: fixture.seedCacheInfo.seedHashShort,
            schemaSignature: fixture.seedCacheInfo.schemaSignature,
          }
        : undefined,
      lookupSetup: setup
        ? {
            fieldId: setup.fieldId,
            createFieldMs: setup.createFieldMeasurement.durationMs,
            fullScanReadyMs: setup.readyMeasurement.durationMs,
            fullScan: setup.readyMeasurement.result,
            responseHeaders:
              setup.createFieldMeasurement.result.responseHeaders,
            routing: setup.createFieldMeasurement.result.routing,
          }
        : undefined,
      create: primary
        ? {
            status: primary.createStatus,
            requestMs: primary.createRequestMs,
            createdRecords: primary.createdRecordIds.length,
            responseHeaders: primary.responseHeaders,
            routing: primary.routing,
          }
        : undefined,
      verification: primary
        ? {
            dirtyRecordsReadyMs: primary.dirtyRecordsReadyMs,
            dirty: primary.dirtyVerification,
            finalFullScanMs: primary.finalFullScanMs,
            finalFullScan: primary.finalFullScan,
          }
        : undefined,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : undefined,
    },
  };
};

const deleteFixture = async (
  baseId: string,
  fixture: ConditionalLookupRecordCreateFixture,
) => {
  for (const tableId of [fixture.hostTableId, fixture.sourceTableId]) {
    try {
      await permanentDeleteTable(baseId, tableId);
    } catch (error) {
      console.warn(
        `Failed to delete conditional lookup table ${tableId}`,
        error,
      );
    }
  }
};

const cleanupFixture = async ({
  baseId,
  fixture,
  config,
  primaryMeasurement,
}: {
  baseId: string;
  fixture: ConditionalLookupRecordCreateFixture | undefined;
  config: ConditionalLookupRecordCreateCaseConfig;
  primaryMeasurement?: Measurement<ConditionalLookupRecordCreatePrimary>;
}) => {
  if (!fixture) return;
  const restoreSharedSeed = shouldRestoreSharedMutableSeed({
    reusableSeed: fixture.reusable,
    executeDbIsolated: isExecuteDbIsolated(),
    // This runner deliberately shares the physical conditional-computed seed
    // with lookup/conditional-10k and rollup/conditional-10k.
    sharedSeedIdentity: true,
  });
  if (restoreSharedSeed) {
    try {
      const createdRecordIds = primaryMeasurement?.result.createdRecordIds;
      if (
        fixture.lookupSetup &&
        (!createdRecordIds ||
          createdRecordIds.length !== config.mutation.recordCount)
      ) {
        throw new Error(
          "Cannot prove the exact dirty records to remove after execution",
        );
      }
      for (const recordIds of chunk(
        createdRecordIds ?? [],
        CLEANUP_BATCH_SIZE,
      )) {
        await deleteRecords(fixture.hostTableId, recordIds);
      }
      await cleanupConditionalComputedFields(
        fixture.hostTableId,
        await getFields(fixture.hostTableId),
      );
      await assertConditionalLookupSeedReady(
        fixture.sourceTableId,
        fixture.hostTableId,
        fixture.sourceFields,
        fixture.hostFields,
        config,
        fixture.sampleRecords,
      );
      return;
    } catch (error) {
      console.warn(
        `Failed to restore shared conditional lookup seed ${fixture.hostTableId}; deleting fixture`,
        error,
      );
      await deleteFixture(baseId, fixture);
      return;
    }
  }
  if (!fixture.reusable && !isExecuteDbIsolated()) {
    await deleteFixture(baseId, fixture);
  }
};

const lifecycleSpec: RecordMutationLifecycleSpec<
  ConditionalLookupRecordCreateCaseConfig,
  ConditionalLookupRecordCreateFixture,
  Awaited<ReturnType<typeof assertConditionalLookupSeedReady>>,
  ConditionalLookupRecordCreatePrimary
> = {
  resolveTableNamePrefix: (config) => config.hostTableNamePrefix,
  prepareFixture: ({ baseId, config, perfCase, context }) =>
    prepareFixture({ baseId, config, perfCase, context }),
  assertSeedReady: ({ fixture, config }) =>
    assertConditionalLookupSeedReady(
      fixture.sourceTableId,
      fixture.hostTableId,
      fixture.sourceFields,
      fixture.hostFields,
      config,
      fixture.sampleRecords,
    ),
  runMeasuredOperation: ({ perfCase, context, config, fixture }) =>
    runMeasuredOperation(perfCase, context, config, fixture),
  buildResult,
  cleanup: cleanupFixture,
};

export const seedConditionalLookupRecordCreateCase = (
  perfCase: PerfCaseFor<"conditional-lookup-record-create">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(perfCase, context, lifecycleSpec);

export const runConditionalLookupRecordCreateCase = (
  perfCase: PerfCaseFor<"conditional-lookup-record-create">,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  if (context.engine !== "v2") {
    return Promise.resolve({
      result: "skipped",
      metrics: {},
      thresholds: [],
      details: {
        operation: "conditional-lookup-record-create",
        skipped: true,
        skippedReason: V2_ONLY_REASON,
        requestedEngine: context.engine,
        seedRecordCount: perfCase.config.recordCount,
        dirtyRecordCount: perfCase.config.mutation.recordCount,
      },
    });
  }
  return runRecordMutationLifecycle(perfCase, context, lifecycleSpec);
};
