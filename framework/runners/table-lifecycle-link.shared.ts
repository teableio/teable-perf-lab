import { FieldKeyType, FieldType, Relationship } from "@teable/core";
import { createRecords as apiCreateRecords } from "@teable/openapi";
import {
  createRecords,
  createTable,
  getFields,
  getRecords,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { chunk } from "../chunk";
import { measureAsync, type Measurement } from "../metrics";
import { pickRoutingResponseHeaders } from "../routing";
import { buildSeedCacheInfo, findSeedTable } from "../seed-cache";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  PerfRunnerKind,
  RecordUndoRedoBaseCaseConfig,
  TableLifecycleLinkConfig,
} from "../types";
import {
  assertRowsRestored,
  buildRecordFields,
  type RecordReplayVerification,
  type RecordReplayFixture,
} from "./record-replay.shared";
import {
  buildTableLifecycleSamplesResult,
  formatTableLifecycleSample,
  getTableLifecycleSampleCount,
  type TableLifecycleFixtureSample,
} from "./table-lifecycle.shared";

const TABLE_LINK_FIXTURE_VERSION = "table-lifecycle-link-v1";
const FOREIGN_KEY_FIELD = "Key";
const FOREIGN_NOTE_FIELD = "Note";

// Seed construction is infrastructure, not the measured engine comparison.
// V1 link-aware createRecord performs the same row-dependent maintenance that
// these lifecycle cases are meant to measure later on archive/restore, making
// a cold 30k fixture exceed the 30-minute case timeout. Force only the batched
// host inserts through V2 while PERF_LAB_MODE=seed; execute-mode routing remains
// owned by the requested engine and is asserted by each measured operation.
const withV2LinkSeedRecordRoute = async <T>(fn: () => Promise<T>) => {
  if (process.env.PERF_LAB_MODE !== "seed") {
    return fn();
  }

  const previousForceV2All = process.env.FORCE_V2_ALL;
  process.env.FORCE_V2_ALL = "true";
  try {
    return await fn();
  } finally {
    if (previousForceV2All == null) {
      delete process.env.FORCE_V2_ALL;
    } else {
      process.env.FORCE_V2_ALL = previousForceV2All;
    }
  }
};

export type TableLinkLifecycleCaseConfig = RecordUndoRedoBaseCaseConfig & {
  samples?: number;
  samplesMode?: "environment" | "fixed";
  link: TableLifecycleLinkConfig;
  threshold: { metric: string; maxMs: number };
};

export type TableLinkFixture = RecordReplayFixture & {
  seedRecordRouting?: Record<string, string>;
  link: {
    fieldId: string;
    fieldName: string;
    relationship: string;
    isOneWay: boolean;
    foreignTableId: string;
    foreignTableName: string;
    foreignKeyFieldId: string;
    foreignFieldIds: string[];
    foreignRowCount: number;
  };
};

export type TableLinkFixtureSample = TableLifecycleFixtureSample & {
  fixture: TableLinkFixture;
};

export type LinkFieldState = {
  exists: boolean;
  type?: string;
  foreignTableId?: string;
};

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const configuredRelationship = (config: TableLinkLifecycleCaseConfig) =>
  config.link.relationship ?? "manyOne";

const relationshipValue = (config: TableLinkLifecycleCaseConfig) => {
  switch (configuredRelationship(config)) {
    case "manyMany":
      return Relationship.ManyMany;
    case "oneMany":
      return Relationship.OneMany;
    case "manyOne":
      return Relationship.ManyOne;
    case "oneOne":
      return Relationship.OneOne;
  }
};

const configuredIsOneWay = (config: TableLinkLifecycleCaseConfig) =>
  config.link.isOneWay ?? true;

const isMultipleLinkValue = (config: TableLinkLifecycleCaseConfig) => {
  const relationship = configuredRelationship(config);
  return relationship === "manyMany" || relationship === "oneMany";
};

export const foreignRowForMainRow = (
  mainRowNumber: number,
  config: TableLinkLifecycleCaseConfig,
) =>
  (((mainRowNumber - 1) * config.link.permutation.multiplier +
    config.link.permutation.offset) %
    config.link.foreignTable.rowCount) +
  1;

export const expectedForeignKey = (
  foreignRowNumber: number,
  config: TableLinkLifecycleCaseConfig,
) => `${config.link.foreignTable.keyPrefix}-${padRowNumber(foreignRowNumber)}`;

const getTableLinkSeedConfig = (
  config: TableLinkLifecycleCaseConfig,
  seedIdentity?: Record<string, string | number | boolean>,
) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  fields: config.fields,
  generator: config.generator,
  link: config.link,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: TABLE_LINK_FIXTURE_VERSION,
  seedIdentity,
});

// The standalone type check stubs the e2e utils module, degrading getFields
// to an untyped result; the cast restores the shape used at runtime.
type SeedFieldVo = {
  id: string;
  name: string;
  type?: string;
  options?: unknown;
};

const resolveLinkFixture = async (
  mainTableId: string,
  mainTableName: string,
  foreignTableId: string,
  foreignTableName: string,
  config: TableLinkLifecycleCaseConfig,
): Promise<Omit<TableLinkFixture, "seededRecords" | "seedBatchDurations">> => {
  const mainFields = (await getFields(mainTableId)) as SeedFieldVo[];
  const fieldByName = new Map(mainFields.map((field) => [field.name, field]));

  const fields = config.fields.map((field) => {
    const resolved = fieldByName.get(field.name);
    if (!resolved) {
      throw new Error(
        `Missing field ${field.name} in link fixture main table ${mainTableName}`,
      );
    }
    return { ...field, id: resolved.id, name: resolved.name };
  });

  const linkField = fieldByName.get(config.link.fieldName);
  if (!linkField) {
    throw new Error(
      `Link field ${config.link.fieldName} missing in main table ${mainTableName}`,
    );
  }
  if (linkField.type !== FieldType.Link) {
    throw new Error(
      `Link field ${config.link.fieldName} has type ${linkField.type}; it was likely detached by a previous v1 delete run`,
    );
  }
  const linkOptions = linkField.options as
    | {
        foreignTableId?: string;
        relationship?: string;
        isOneWay?: boolean;
      }
    | undefined;
  const linkForeignTableId = linkOptions?.foreignTableId;
  if (linkForeignTableId !== foreignTableId) {
    throw new Error(
      `Link field ${config.link.fieldName} points at ${String(
        linkForeignTableId,
      )}, expected foreign table ${foreignTableId}`,
    );
  }
  const expectedRelationship = configuredRelationship(config);
  if (linkOptions?.relationship !== expectedRelationship) {
    throw new Error(
      `Link field ${config.link.fieldName} relationship is ${String(
        linkOptions?.relationship,
      )}; expected ${expectedRelationship}`,
    );
  }
  const expectedIsOneWay = configuredIsOneWay(config);
  if (Boolean(linkOptions?.isOneWay) !== expectedIsOneWay) {
    throw new Error(
      `Link field ${config.link.fieldName} isOneWay is ${String(
        linkOptions?.isOneWay,
      )}; expected ${expectedIsOneWay}`,
    );
  }

  const views = await getViews(mainTableId);
  const viewId = views[0]?.id;
  if (!viewId) {
    throw new Error(`No grid view found for link fixture ${mainTableName}`);
  }

  const foreignFields = (await getFields(foreignTableId)) as SeedFieldVo[];
  const foreignKeyField = foreignFields.find(
    (field) => field.name === FOREIGN_KEY_FIELD,
  );
  if (!foreignKeyField) {
    throw new Error(
      `Foreign table ${foreignTableName} is missing field ${FOREIGN_KEY_FIELD}`,
    );
  }

  return {
    tableId: mainTableId,
    tableName: mainTableName,
    viewId,
    fields,
    projection: fields.map((field) => field.id),
    link: {
      fieldId: linkField.id,
      fieldName: config.link.fieldName,
      relationship: expectedRelationship,
      isOneWay: expectedIsOneWay,
      foreignTableId,
      foreignTableName,
      foreignKeyFieldId: foreignKeyField.id,
      foreignFieldIds: foreignFields.map((field) => field.id),
      foreignRowCount: config.link.foreignTable.rowCount,
    },
  };
};

export type LinkCellItem = { id?: string; title?: string };

export const normalizeLinkCellItems = (value: unknown): LinkCellItem[] => {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is LinkCellItem => typeof item === "object" && item !== null,
    );
  }
  return typeof value === "object" && value !== null
    ? [value as LinkCellItem]
    : [];
};

// Link cell evidence on sample rows: the cell must resolve to the permuted
// foreign row, proven by the link title (the foreign table's primary Key).
export const assertLinkCellSamples = async (
  fixture: TableLinkFixture,
  config: TableLinkLifecycleCaseConfig,
) => {
  const verifiedSamples = [];
  for (const rowOffset of config.verify.sampleRows) {
    const rowNumber = rowOffset + 1;
    const result = await getRecords(fixture.tableId, {
      viewId: fixture.viewId,
      fieldKeyType: FieldKeyType.Id,
      projection: [fixture.link.fieldId],
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(`Link sample row at offset ${rowOffset} not found`);
    }

    const linkItems = normalizeLinkCellItems(
      record.fields[fixture.link.fieldId],
    );
    if (linkItems.length !== 1 || !linkItems[0]?.id) {
      throw new Error(
        `Main row ${rowNumber} expected one link cell value, got ${JSON.stringify(
          record.fields[fixture.link.fieldId],
        )}`,
      );
    }
    const linkValue = linkItems[0];
    const expectedTitle = expectedForeignKey(
      foreignRowForMainRow(rowNumber, config),
      config,
    );
    if (linkValue.title !== expectedTitle) {
      throw new Error(
        `Main row ${rowNumber} link title mismatch: expected ${expectedTitle}, actual ${String(
          linkValue.title,
        )}`,
      );
    }

    verifiedSamples.push({
      rowOffset,
      rowNumber,
      recordId: record.id,
      linkTargetId: linkValue.id,
      linkTargetTitle: String(linkValue.title),
    });
  }

  return { verifiedSamples, linkFieldId: fixture.link.fieldId };
};

export const getLinkFieldState = async (
  fixture: TableLinkFixture,
): Promise<LinkFieldState> => {
  const fields = (await getFields(fixture.tableId)) as SeedFieldVo[];
  const linkField = fields.find(
    (field) => field.name === fixture.link.fieldName,
  );
  if (!linkField) {
    return { exists: false };
  }
  return {
    exists: true,
    type: linkField.type,
    foreignTableId: (
      linkField.options as { foreignTableId?: string } | undefined
    )?.foreignTableId,
  };
};

const seedForeignTable = async (
  baseId: string,
  foreignTableName: string,
  config: TableLinkLifecycleCaseConfig,
) => {
  const table = await createTable(baseId, {
    name: foreignTableName,
    fields: [
      { name: FOREIGN_KEY_FIELD, type: FieldType.SingleLineText },
      { name: FOREIGN_NOTE_FIELD, type: FieldType.SingleLineText },
    ],
    records: [],
  });

  const records = Array.from(
    { length: config.link.foreignTable.rowCount },
    (_, index) => {
      const rowNumber = index + 1;
      return {
        fields: {
          [FOREIGN_KEY_FIELD]: expectedForeignKey(rowNumber, config),
          [FOREIGN_NOTE_FIELD]: `${config.link.foreignTable.keyPrefix}-note-${padRowNumber(
            rowNumber,
          )}`,
        },
      };
    },
  );
  const foreignRecordIds: string[] = [];
  for (const batch of chunk(records, config.link.foreignTable.batchSize)) {
    const response = await createRecords(table.id, {
      fieldKeyType: FieldKeyType.Name,
      typecast: true,
      records: batch,
    });
    for (const record of response.records) {
      foreignRecordIds.push(record.id);
    }
  }

  return { tableId: table.id, foreignRecordIds };
};

const seedMainTable = async (
  baseId: string,
  mainTableName: string,
  foreignTableId: string,
  foreignRecordIds: string[],
  config: TableLinkLifecycleCaseConfig,
) => {
  const table = await createTable(baseId, {
    name: mainTableName,
    fields: [
      ...config.fields,
      {
        name: config.link.fieldName,
        type: FieldType.Link,
        options: {
          relationship: relationshipValue(config),
          foreignTableId,
          isOneWay: configuredIsOneWay(config),
        },
      },
    ],
    records: [],
  });

  const records = Array.from({ length: config.rowCount }, (_, index) => {
    const rowNumber = index + 1;
    const foreignRowNumber = foreignRowForMainRow(rowNumber, config);
    const foreignRecordId = foreignRecordIds[foreignRowNumber - 1];
    if (!foreignRecordId) {
      throw new Error(
        `No foreign record id for main row ${rowNumber} -> foreign row ${foreignRowNumber}`,
      );
    }
    return {
      fields: {
        ...buildRecordFields(config, rowNumber),
        [config.link.fieldName]: isMultipleLinkValue(config)
          ? [{ id: foreignRecordId }]
          : { id: foreignRecordId },
      },
    };
  });
  const seedBatchDurations: number[] = [];
  let seedRecordRouting: Record<string, string> | undefined;
  await withV2LinkSeedRecordRoute(async () => {
    for (const batch of chunk(records, config.batchSize)) {
      const batchMeasurement = await measureAsync("seedBatch", () =>
        apiCreateRecords(table.id, {
          fieldKeyType: FieldKeyType.Name,
          typecast: true,
          records: batch,
        }),
      );
      expect(batchMeasurement.result.status).toBe(201);
      seedBatchDurations.push(batchMeasurement.durationMs);
      expect(batchMeasurement.result.data.records).toHaveLength(batch.length);
      seedRecordRouting = pickRoutingResponseHeaders(
        batchMeasurement.result.headers,
      );
      if (
        process.env.PERF_LAB_MODE === "seed" &&
        seedRecordRouting["x-teable-v2"] !== "true"
      ) {
        throw new Error(
          `Linked-table seed createRecord did not use V2; headers=${JSON.stringify(
            seedRecordRouting,
          )}`,
        );
      }
    }
  });

  if (seedRecordRouting) {
    console.log(
      `[perf-lab] linked-table seed record route table=${table.id} headers=${JSON.stringify(
        seedRecordRouting,
      )}`,
    );
  }

  return { tableId: table.id, seedBatchDurations, seedRecordRouting };
};

const syntheticSeededRecords = (rowCount: number) =>
  Array.from({ length: rowCount }, (_, index) => ({
    rowOffset: index,
    rowNumber: index + 1,
    recordId: "",
  }));

export const prepareTableLinkFixture = async (
  baseId: string,
  tableName: string,
  config: TableLinkLifecycleCaseConfig,
  perfCase: PerfCase,
  runner: PerfRunnerKind,
  seedIdentity?: Record<string, string | number | boolean>,
): Promise<TableLinkFixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner,
    fixtureVersion: TABLE_LINK_FIXTURE_VERSION,
    seedConfig: getTableLinkSeedConfig(config, seedIdentity),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
      new URL("./record-replay.shared.ts", import.meta.url),
      runner === "table-delete-link"
        ? new URL("./table-delete-link.runner.ts", import.meta.url)
        : runner === "table-restore-link"
          ? new URL("./table-restore-link.runner.ts", import.meta.url)
          : runner === "field-duplicate"
            ? new URL("./field-duplicate-link.runner.ts", import.meta.url)
            : new URL("./record-delete-link.runner.ts", import.meta.url),
    ],
  });

  const mainTableName = seedCacheInfo.enabled
    ? seedCacheInfo.seedTableName
    : tableName;
  const foreignTableName = `${mainTableName}-fk`;

  if (seedCacheInfo.enabled) {
    const cachedMain = await findSeedTable(baseId, mainTableName);
    const cachedForeign = await findSeedTable(baseId, foreignTableName);
    if (cachedMain && cachedForeign) {
      try {
        const cachedFixture: TableLinkFixture = {
          ...(await resolveLinkFixture(
            cachedMain.id,
            cachedMain.name,
            cachedForeign.id,
            cachedForeign.name,
            config,
          )),
          seededRecords: syntheticSeededRecords(config.rowCount),
          seedBatchDurations: [0],
          seedCacheInfo,
          seedCacheHit: true,
          reusableSeed: true,
        };
        await assertRowsRestored(cachedFixture, config);
        await assertLinkCellSamples(cachedFixture, config);
        return cachedFixture;
      } catch (error) {
        // A v1 delete run converts the surviving link field to text, which
        // poisons the cached pair; rebuild from scratch.
        console.warn(
          `Invalid cached link seed ${mainTableName}; rebuilding`,
          error,
        );
        for (const table of [cachedMain, cachedForeign]) {
          try {
            await permanentDeleteTable(baseId, table.id);
          } catch (cleanupError) {
            console.warn(
              `Failed to delete stale link seed table ${table.id}`,
              cleanupError,
            );
          }
        }
      }
    } else if (cachedMain || cachedForeign) {
      const orphan = cachedMain ?? cachedForeign;
      if (orphan) {
        try {
          await permanentDeleteTable(baseId, orphan.id);
        } catch (cleanupError) {
          console.warn(
            `Failed to delete orphan link seed table ${orphan.id}`,
            cleanupError,
          );
        }
      }
    }
  }

  let foreignTableId = "";
  let mainTableId = "";
  try {
    const foreign = await seedForeignTable(baseId, foreignTableName, config);
    foreignTableId = foreign.tableId;
    const main = await seedMainTable(
      baseId,
      mainTableName,
      foreign.tableId,
      foreign.foreignRecordIds,
      config,
    );
    mainTableId = main.tableId;

    const fixture: TableLinkFixture = {
      ...(await resolveLinkFixture(
        main.tableId,
        mainTableName,
        foreign.tableId,
        foreignTableName,
        config,
      )),
      seededRecords: syntheticSeededRecords(config.rowCount),
      seedBatchDurations: main.seedBatchDurations,
      seedRecordRouting: main.seedRecordRouting,
      seedCacheInfo,
      seedCacheHit: false,
      reusableSeed: seedCacheInfo.enabled,
    };
    await assertLinkCellSamples(fixture, config);
    return fixture;
  } catch (error) {
    for (const tableId of [mainTableId, foreignTableId]) {
      if (tableId) {
        try {
          await permanentDeleteTable(baseId, tableId);
        } catch (cleanupError) {
          console.warn(
            `Failed to cleanup incomplete link seed ${tableId}`,
            cleanupError,
          );
        }
      }
    }
    throw error;
  }
};

export const prepareTableLinkFixtures = async (
  baseId: string,
  config: TableLinkLifecycleCaseConfig,
  perfCase: PerfCase,
  runner: PerfRunnerKind,
): Promise<TableLinkFixtureSample[]> => {
  const samples = getTableLifecycleSampleCount(config);
  const fixtures: TableLinkFixtureSample[] = [];
  const runSuffix = `${Date.now()}`;

  for (let iteration = 1; iteration <= samples; iteration += 1) {
    const sampleLabel = formatTableLifecycleSample(iteration);
    const tableName = `${config.tableNamePrefix}-${runSuffix}-${sampleLabel}`;
    const prepareMeasurement = await measureAsync(
      `prepare-${sampleLabel}`,
      () =>
        prepareTableLinkFixture(baseId, tableName, config, perfCase, runner, {
          sample: iteration,
        }),
    );
    const seedReadyMeasurement = await measureAsync(
      `seedReady-${sampleLabel}`,
      () => assertRowsRestored(prepareMeasurement.result, config),
    );

    fixtures.push({
      iteration,
      fixture: prepareMeasurement.result,
      prepareMeasurement,
      seedReadyMeasurement,
    });
  }

  return fixtures;
};

export const permanentDeleteLinkFixture = async (
  baseId: string,
  fixture: TableLinkFixture,
) => {
  for (const tableId of [fixture.tableId, fixture.link.foreignTableId]) {
    try {
      await permanentDeleteTable(baseId, tableId);
    } catch (error) {
      console.warn(`Failed to cleanup link fixture table ${tableId}`, error);
    }
  }
};

export const buildLinkFixtureSeedDetails = (
  fixtureSamples: TableLinkFixtureSample[],
) => ({
  linkFixtures: fixtureSamples.map((sample) => ({
    iteration: sample.iteration,
    mainTableId: sample.fixture.tableId,
    foreignTableId: sample.fixture.link.foreignTableId,
    foreignTableName: sample.fixture.link.foreignTableName,
    linkFieldId: sample.fixture.link.fieldId,
    relationship: sample.fixture.link.relationship,
    isOneWay: sample.fixture.link.isOneWay,
    foreignRowCount: sample.fixture.link.foreignRowCount,
    seedRecordRouting: sample.fixture.seedRecordRouting,
  })),
});

export const seedTableLinkLifecycleCase = async (
  perfCase: PerfCase,
  _context: PerfRunContext,
  runner: Extract<
    PerfRunnerKind,
    "table-delete-link" | "table-restore-link" | "record-delete-link"
  >,
): Promise<PerfRunResult> => {
  const config = perfCase.config as TableLinkLifecycleCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const fixtureSamples = await prepareTableLinkFixtures(
    baseId,
    config,
    perfCase,
    runner,
  );

  return buildTableLifecycleSamplesResult({
    config,
    runner: runner === "table-delete-link" ? "table-delete" : "table-restore",
    fixtureSamples,
    requestSamples: [],
    details: {
      runner,
      ...buildLinkFixtureSeedDetails(fixtureSamples),
    },
  });
};

export type { Measurement, RecordReplayVerification };
