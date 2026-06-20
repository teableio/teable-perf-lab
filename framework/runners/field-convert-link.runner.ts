import { FieldKeyType, FieldType, Relationship } from "@teable/core";
import { convertField as apiConvertField } from "@teable/openapi";
import {
  createRecords,
  createTable,
  getFields,
  getRecords,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs } from "../env";
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
import { pollUntilReady } from "../readiness";
import { forEachRecordPage } from "../record-page-scan";
import { withPerfTraceStep } from "../trace-collector";
import type {
  FieldConvertLinkCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  expectedForeignTitle,
  fetchForeignIdByTitle,
  foreignRowForHostRow,
  resolveForeignKeyFieldId,
  seedForeignTable,
} from "./link-fixture.shared";
import {
  runFieldConvertLifecycle,
  seedFieldConvertLifecycle,
  type FieldConvertLifecycleSpec,
} from "./field-convert-lifecycle";

const FIELD_CONVERT_LINK_FIXTURE_VERSION = "field-convert-link-v1";

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

type NamedField = { id: string; name: string; type?: string };

type FieldConvertLinkFixture = {
  tableId: string;
  tableName: string;
  foreignTableId: string;
  foreignTableName: string;
  foreignKeyFieldId: string;
  titleField: NamedField;
  sourceField: NamedField;
  createTableMeasurement: Measurement<unknown>;
  seedMeasurement: Measurement<unknown>;
  batchDurations: number[];
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
};

type ConvertLinkPrimaryResult = {
  convertRequestMs: number;
  samplesReadyMs: number;
  fullScanReadyMs: number;
  convertedField: { id: string; name: string; type: string };
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
  verifiedSamples: Array<{
    rowOffset: number;
    rowNumber: number;
    expectedTitle: string;
    actual: unknown;
  }>;
  fullScan: { scannedRecords: number; pageSize: number; pageCount: number };
};

const titlePrefix = (config: FieldConvertLinkCaseConfig) =>
  config.generator.titlePrefix;

const expectedTitleForRow = (
  config: FieldConvertLinkCaseConfig,
  rowNumber: number,
) =>
  expectedForeignTitle(
    foreignRowForHostRow(
      rowNumber,
      config.foreignTable.rowCount,
      config.link.permutation,
    ),
    config.foreignTable.keyPrefix,
  );

const parseTitleRowNumber = (
  value: unknown,
  config: FieldConvertLinkCaseConfig,
) => {
  const prefix = `${titlePrefix(config)} `;
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

// Expected source field type before conversion, used to revalidate cache hits.
const sourceSeedType = (config: FieldConvertLinkCaseConfig) =>
  config.direction === "link-to-text"
    ? FieldType.Link
    : FieldType.SingleLineText;

const buildHostFields = (
  config: FieldConvertLinkCaseConfig,
  foreignTableId: string,
) => {
  const sourceField =
    config.direction === "link-to-text"
      ? {
          name: config.sourceFieldName,
          type: FieldType.Link,
          options: {
            relationship: Relationship.ManyOne,
            foreignTableId,
            isOneWay: config.link.isOneWay,
          },
        }
      : { name: config.sourceFieldName, type: FieldType.SingleLineText };
  return [{ name: "Title", type: FieldType.SingleLineText }, sourceField];
};

const buildHostRecordFields = (
  config: FieldConvertLinkCaseConfig,
  rowNumber: number,
  foreignIdByTitle: Map<string, string>,
) => {
  const expected = expectedTitleForRow(config, rowNumber);
  if (config.direction === "link-to-text") {
    const foreignId = foreignIdByTitle.get(expected);
    if (!foreignId) {
      throw new Error(
        `No foreign record id for host row ${rowNumber} (${expected})`,
      );
    }
    return {
      Title: `${titlePrefix(config)} ${rowNumber}`,
      [config.sourceFieldName]: { id: foreignId },
    };
  }
  return {
    Title: `${titlePrefix(config)} ${rowNumber}`,
    [config.sourceFieldName]: expected,
  };
};

const getConvertLinkSeedConfig = (config: FieldConvertLinkCaseConfig) => ({
  baseId: config.baseId,
  direction: config.direction,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  sourceFieldName: config.sourceFieldName,
  foreignTable: config.foreignTable,
  link: config.link,
  generator: config.generator,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: FIELD_CONVERT_LINK_FIXTURE_VERSION,
});

const createEmptyMeasurement = <T>(
  name: string,
  result: T,
): Measurement<T> => ({
  name,
  durationMs: 0,
  result,
});

const readSourceValue = (
  record: { fields: Record<string, unknown> },
  fieldId: string,
) => record.fields[fieldId];

// Source field still holds the seeded value: a link cell whose title is the
// permuted foreign title (link-to-text), or the matching text (text-to-link).
const assertSeedSamples = async (
  fixture: FieldConvertLinkFixture,
  config: FieldConvertLinkCaseConfig,
) => {
  const verifiedSamples = [];
  for (const rowOffset of config.verify.sampleRows) {
    const rowNumber = rowOffset + 1;
    const result = await getRecords(fixture.tableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [fixture.titleField.id, fixture.sourceField.id],
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(`Missing seed sample at row offset ${rowOffset}`);
    }
    const actualRowNumber = parseTitleRowNumber(
      record.fields[fixture.titleField.id],
      config,
    );
    if (actualRowNumber !== rowNumber) {
      throw new Error(
        `Seed sample row mismatch: expected ${rowNumber}, got ${actualRowNumber}`,
      );
    }
    const expectedTitle = expectedTitleForRow(config, rowNumber);
    const sourceValue = readSourceValue(record, fixture.sourceField.id);
    const actualTitle =
      config.direction === "link-to-text"
        ? (sourceValue as { title?: string } | undefined)?.title
        : sourceValue;
    if (actualTitle !== expectedTitle) {
      throw new Error(
        `Seed source mismatch at row ${rowNumber}: expected ${expectedTitle}, actual ${String(actualTitle)}`,
      );
    }
    verifiedSamples.push({ rowOffset, rowNumber, expectedTitle });
  }

  const lastPage = await getRecords(fixture.tableId, {
    fieldKeyType: FieldKeyType.Id,
    projection: [fixture.titleField.id],
    skip: config.rowCount - 1,
    take: 1,
  });
  const lastRecord = lastPage.records[0];
  if (!lastRecord) {
    throw new Error(`Missing final seed row at offset ${config.rowCount - 1}`);
  }
  if (
    parseTitleRowNumber(lastRecord.fields[fixture.titleField.id], config) !==
    config.rowCount
  ) {
    throw new Error(`Final seed row mismatch: expected row ${config.rowCount}`);
  }
  const beyondLastPage = await getRecords(fixture.tableId, {
    fieldKeyType: FieldKeyType.Id,
    projection: [fixture.titleField.id],
    skip: config.rowCount,
    take: 1,
  });
  if (beyondLastPage.records.length !== 0) {
    throw new Error(
      `Seed table has extra rows after rowCount=${config.rowCount}`,
    );
  }

  return verifiedSamples;
};

const prepareFieldConvertLinkFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  tableName: string,
  config: FieldConvertLinkCaseConfig,
): Promise<FieldConvertLinkFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "field-convert-link",
    fixtureVersion: FIELD_CONVERT_LINK_FIXTURE_VERSION,
    seedConfig: getConvertLinkSeedConfig(config) as never,
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
        const sourceField = resolveNamedField(
          hostFields,
          config.sourceFieldName,
        );
        if (sourceField.type !== sourceSeedType(config)) {
          throw new Error(
            `Cached source field ${config.sourceFieldName} has type ${sourceField.type}, expected ${sourceSeedType(config)} (leftover converted column?)`,
          );
        }
        const foreignFields = (await getFields(
          cachedForeign.id,
        )) as NamedField[];
        const fixture: FieldConvertLinkFixture = {
          tableId: cachedHost.id,
          tableName: cachedHost.name,
          foreignTableId: cachedForeign.id,
          foreignTableName: cachedForeign.name,
          foreignKeyFieldId: resolveForeignKeyFieldId(
            foreignFields,
            cachedForeign.name,
          ),
          titleField,
          sourceField,
          createTableMeasurement: createEmptyMeasurement("seedRestore", {
            id: cachedHost.id,
          }),
          seedMeasurement: createEmptyMeasurement(
            "seedBuildSkipped",
            undefined,
          ),
          batchDurations: [0],
          seedCacheInfo,
          seedCacheHit: true,
          reusableSeed: true,
        };
        await assertSeedSamples(fixture, config);
        return fixture;
      } catch (error) {
        console.warn(
          `Invalid cached field-convert-link seed ${hostTableName}; rebuilding`,
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
    const createTableMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      seedCacheInfo.enabled ? "seedBuild:createTables" : "createTables",
      () =>
        measureAsync(
          seedCacheInfo.enabled ? "seedBuild" : "createTables",
          async () => {
            const foreign = await seedForeignTable(baseId, foreignTableName, {
              rowCount: config.foreignTable.rowCount,
              batchSize: config.foreignTable.batchSize,
              keyPrefix: config.foreignTable.keyPrefix,
            });
            foreignTableId = foreign.tableId;
            const host = await createTable(baseId, {
              name: hostTableName,
              fields: buildHostFields(config, foreign.tableId),
              records: [],
            });
            hostTableId = host.id;
            return { foreign, host };
          },
        ),
    );
    const { foreign, host } = createTableMeasurement.result;

    const hostFields = (await getFields(host.id)) as NamedField[];
    const titleField = resolveNamedField(hostFields, "Title");
    const sourceField = resolveNamedField(hostFields, config.sourceFieldName);

    const foreignIdByTitle =
      config.direction === "link-to-text"
        ? await fetchForeignIdByTitle(
            foreign.tableId,
            foreign.keyFieldId,
            config.foreignTable.rowCount,
          )
        : new Map<string, string>();

    const records = Array.from({ length: config.rowCount }, (_, index) => ({
      fields: buildHostRecordFields(config, index + 1, foreignIdByTitle),
    }));
    const batches = chunk(records, config.batchSize);
    const batchDurations: number[] = [];
    const seedMeasurement = await measureAsync("seedRecords", async () => {
      for (const [batchIndex, batch] of batches.entries()) {
        const batchMeasurement = await measureAsync(
          `seedBatch:${batchIndex + 1}`,
          () =>
            withPerfTraceStep(
              context,
              perfCase,
              `seedBatch:${batchIndex + 1}`,
              () =>
                createRecords(host.id, {
                  fieldKeyType: FieldKeyType.Name,
                  typecast: true,
                  records: batch,
                }),
            ),
        );
        batchDurations.push(batchMeasurement.durationMs);
        expect(batchMeasurement.result.records).toHaveLength(batch.length);
      }
    });

    return {
      tableId: host.id,
      tableName: hostTableName,
      foreignTableId: foreign.tableId,
      foreignTableName: foreign.tableName,
      foreignKeyFieldId: foreign.keyFieldId,
      titleField,
      sourceField,
      createTableMeasurement,
      seedMeasurement,
      batchDurations,
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
            `Failed to cleanup incomplete seed table ${tableId}`,
            cleanupError,
          );
        }
      }
    }
    throw error;
  }
};

const buildConvertRo = (
  config: FieldConvertLinkCaseConfig,
  fixture: FieldConvertLinkFixture,
) => {
  if (config.direction === "link-to-text") {
    return { type: FieldType.SingleLineText, name: config.sourceFieldName };
  }
  return {
    type: FieldType.Link,
    name: config.sourceFieldName,
    options: {
      relationship: Relationship.ManyOne,
      foreignTableId: fixture.foreignTableId,
      isOneWay: config.link.isOneWay,
    },
  };
};

const matchesConverted = (
  config: FieldConvertLinkCaseConfig,
  actual: unknown,
  expectedTitle: string,
) => {
  if (config.direction === "link-to-text") {
    return actual === expectedTitle;
  }
  const linkValue = actual as { id?: string; title?: string } | undefined;
  return Boolean(linkValue?.id) && linkValue?.title === expectedTitle;
};

const assertConvertedSamples = async (
  fixture: FieldConvertLinkFixture,
  config: FieldConvertLinkCaseConfig,
  convertedFieldId: string,
) => {
  const verifiedSamples = [];
  for (const rowOffset of config.verify.sampleRows) {
    const rowNumber = rowOffset + 1;
    const result = await getRecords(fixture.tableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [fixture.titleField.id, convertedFieldId],
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(`Missing converted sample at row offset ${rowOffset}`);
    }
    const expectedTitle = expectedTitleForRow(config, rowNumber);
    const actual = record.fields[convertedFieldId];
    if (!matchesConverted(config, actual, expectedTitle)) {
      throw new Error(
        `Converted sample mismatch at row ${rowNumber}: expected title ${expectedTitle}, actual ${JSON.stringify(actual)}`,
      );
    }
    verifiedSamples.push({ rowOffset, rowNumber, expectedTitle, actual });
  }
  return verifiedSamples;
};

const waitFor = <T>(
  config: FieldConvertLinkCaseConfig,
  label: string,
  fn: () => Promise<T>,
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 30_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 200,
      description: label,
    },
    fn,
  );

const assertConvertedFullScan = async (
  fixture: FieldConvertLinkFixture,
  config: FieldConvertLinkCaseConfig,
  convertedFieldId: string,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const seenRowNumbers = new Set<number>();
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.rowCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: [fixture.titleField.id, convertedFieldId],
          skip,
          take,
        }),
    },
    (record) => {
      const rowNumber = parseTitleRowNumber(
        record.fields[fixture.titleField.id],
        config,
      );
      if (seenRowNumbers.has(rowNumber)) {
        throw new Error(
          `Duplicate row number in converted full scan: ${rowNumber}`,
        );
      }
      seenRowNumbers.add(rowNumber);
      const expectedTitle = expectedTitleForRow(config, rowNumber);
      const actual = record.fields[convertedFieldId];
      if (!matchesConverted(config, actual, expectedTitle)) {
        throw new Error(
          `Converted full scan mismatch at row ${rowNumber}: expected title ${expectedTitle}, actual ${JSON.stringify(actual)}`,
        );
      }
    },
  );

  if (scannedRecords !== config.rowCount) {
    throw new Error(
      `Converted full scan count mismatch: expected ${config.rowCount}, scanned ${scannedRecords}`,
    );
  }
  return { scannedRecords, pageSize, pageCount };
};

const runConvertLinkPrimary = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: FieldConvertLinkFixture,
  config: FieldConvertLinkCaseConfig,
): Promise<ConvertLinkPrimaryResult> => {
  const convertRo = buildConvertRo(config, fixture);
  const convertMeasurement = await measureAsync("convertRequest", () =>
    withPerfTraceStep(context, perfCase, config.threshold.metric, () =>
      apiConvertField(
        fixture.tableId,
        fixture.sourceField.id,
        convertRo as Parameters<typeof apiConvertField>[2],
      ),
    ),
  );
  const response = convertMeasurement.result;
  expect(response.status).toBe(200);

  const responseHeaders = pickRoutingResponseHeaders(
    response.headers as Record<string, unknown>,
  );
  const routing = assertEngineRouting(context, responseHeaders, {
    operation: "Field convert link",
  });

  const convertedField = response.data;
  const expectedType =
    config.direction === "link-to-text"
      ? FieldType.SingleLineText
      : FieldType.Link;
  if (convertedField.type !== expectedType) {
    throw new Error(
      `Converted field type mismatch: expected ${expectedType}, got ${convertedField.type}`,
    );
  }

  const samplesMeasurement = await measureAsync("convertedSamplesReady", () =>
    waitFor(config, "converted samples", () =>
      assertConvertedSamples(fixture, config, convertedField.id),
    ),
  );
  const fullScanMeasurement = await measureAsync("convertedFullScanReady", () =>
    waitFor(config, "converted full scan", () =>
      assertConvertedFullScan(fixture, config, convertedField.id),
    ),
  );

  return {
    convertRequestMs: convertMeasurement.durationMs,
    samplesReadyMs: samplesMeasurement.durationMs,
    fullScanReadyMs: fullScanMeasurement.durationMs,
    convertedField: {
      id: convertedField.id,
      name: convertedField.name,
      type: convertedField.type,
    },
    responseHeaders,
    routing,
    verifiedSamples: samplesMeasurement.result,
    fullScan: fullScanMeasurement.result,
  };
};

const buildResult = ({
  config,
  fixture,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  config: FieldConvertLinkCaseConfig;
  fixture?: FieldConvertLinkFixture;
  seedReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertSeedSamples>>
  >;
  primaryMeasurement?: Measurement<ConvertLinkPrimaryResult>;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    ...(fixture
      ? {
          createTableMs: fixture.createTableMeasurement.durationMs,
          seedRecordsMs: fixture.seedMeasurement.durationMs,
          maxSeedBatchMs: roundMetric(Math.max(...fixture.batchDurations)),
          seedCacheHit: fixture.seedCacheHit ? 1 : 0,
          seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
          ...(fixture.seedCacheHit
            ? { seedRestoreMs: fixture.createTableMeasurement.durationMs }
            : fixture.seedCacheInfo.enabled
              ? {
                  seedBuildMs: roundMetric(
                    fixture.createTableMeasurement.durationMs +
                      fixture.seedMeasurement.durationMs,
                  ),
                }
              : {}),
        }
      : {}),
    ...(seedReadyMeasurement
      ? { seedReadyMs: seedReadyMeasurement.durationMs }
      : {}),
    ...(primaryMeasurement
      ? {
          [config.threshold.metric]: primaryMeasurement.durationMs,
          convertRequestMs: primaryMeasurement.result.convertRequestMs,
          convertedSamplesReadyMs: primaryMeasurement.result.samplesReadyMs,
          convertedFullScanReadyMs: primaryMeasurement.result.fullScanReadyMs,
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
          {
            name: fixture.createTableMeasurement.name,
            durationMs: fixture.createTableMeasurement.durationMs,
          },
          {
            name: fixture.seedMeasurement.name,
            durationMs: fixture.seedMeasurement.durationMs,
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
    operation: "field-convert-link",
    direction: config.direction,
    tableId: fixture?.tableId,
    tableName: fixture?.tableName,
    foreignTableId: fixture?.foreignTableId,
    foreignTableName: fixture?.foreignTableName,
    rowCount: config.rowCount,
    foreignRowCount: config.foreignTable.rowCount,
    batchSize: config.batchSize,
    convert: {
      sourceFieldName: config.sourceFieldName,
      sourceFieldId: fixture?.sourceField.id,
      sourceType: fixture ? sourceSeedType(config) : undefined,
      targetType:
        config.direction === "link-to-text"
          ? FieldType.SingleLineText
          : FieldType.Link,
      isOneWay: config.link.isOneWay,
    },
    convertedField: primaryMeasurement?.result.convertedField,
    responseHeaders: primaryMeasurement?.result.responseHeaders,
    routing: primaryMeasurement?.result.routing,
    seed: fixture
      ? {
          seededRecords: config.rowCount,
          batchCount: fixture.batchDurations.length,
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
    verifiedSamples: primaryMeasurement?.result.verifiedSamples,
    fullScan: primaryMeasurement?.result.fullScan,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message }
        : undefined,
  },
});

// Class D cleanup: the conversion rewrites the source column in place
// (link <-> text), so a cached seed cannot be cheaply restored. Delete both the
// host and foreign fixture tables so the next run reseeds.
const cleanupFieldConvertLinkFixture = async ({
  baseId,
  fixture,
}: {
  baseId: string;
  fixture: FieldConvertLinkFixture;
}) => {
  for (const tableId of [fixture.tableId, fixture.foreignTableId]) {
    try {
      await permanentDeleteTable(baseId, tableId);
    } catch (error) {
      console.warn(
        `Failed to cleanup field-convert-link table ${tableId}`,
        error,
      );
    }
  }
};

const fieldConvertLinkLifecycleSpec: FieldConvertLifecycleSpec<
  FieldConvertLinkCaseConfig,
  FieldConvertLinkFixture,
  Awaited<ReturnType<typeof assertSeedSamples>>,
  ConvertLinkPrimaryResult
> = {
  prepareFixture: ({ perfCase, context, baseId, tableName, config }) =>
    prepareFieldConvertLinkFixture(
      perfCase,
      context,
      baseId,
      tableName,
      config,
    ),
  assertSeedReady: ({ fixture, config }) => assertSeedSamples(fixture, config),
  runPrimary: ({ perfCase, context, fixture, config }) =>
    runConvertLinkPrimary(perfCase, context, fixture, config),
  buildResult: buildResult,
  cleanupConvertedFixture: cleanupFieldConvertLinkFixture,
};

export const seedFieldConvertLinkCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedFieldConvertLifecycle(perfCase, context, fieldConvertLinkLifecycleSpec);

export const runFieldConvertLinkCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runFieldConvertLifecycle(perfCase, context, fieldConvertLinkLifecycleSpec);
