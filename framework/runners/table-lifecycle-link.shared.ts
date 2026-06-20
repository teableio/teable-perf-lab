import { FieldKeyType, FieldType, Relationship } from "@teable/core";
import {
  createRecords,
  createTable,
  getFields,
  getRecords,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { measureAsync, type Measurement } from "../metrics";
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
  type RecordUndoRedoFixture,
} from "./record-undo-redo.shared";
import {
  buildTableLifecycleSamplesResult,
  formatTableLifecycleSample,
  getTableLifecycleSampleCount,
  type TableLifecycleFixtureSample,
} from "./table-lifecycle.shared";

const TABLE_LINK_FIXTURE_VERSION = "table-lifecycle-link-v1";
const FOREIGN_KEY_FIELD = "Key";
const FOREIGN_NOTE_FIELD = "Note";

export type TableLinkLifecycleCaseConfig = RecordUndoRedoBaseCaseConfig & {
  samples?: number;
  link: TableLifecycleLinkConfig;
  threshold: { metric: string; maxMs: number };
};

export type TableLinkFixture = RecordUndoRedoFixture & {
  link: {
    fieldId: string;
    fieldName: string;
    foreignTableId: string;
    foreignTableName: string;
    foreignKeyFieldId: string;
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

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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
  const linkForeignTableId = (
    linkField.options as { foreignTableId?: string } | undefined
  )?.foreignTableId;
  if (linkForeignTableId !== foreignTableId) {
    throw new Error(
      `Link field ${config.link.fieldName} points at ${String(
        linkForeignTableId,
      )}, expected foreign table ${foreignTableId}`,
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
      foreignTableId,
      foreignTableName,
      foreignKeyFieldId: foreignKeyField.id,
      foreignRowCount: config.link.foreignTable.rowCount,
    },
  };
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

    const linkValue = record.fields[fixture.link.fieldId] as
      | { id?: string; title?: string }
      | undefined;
    if (!linkValue?.id) {
      throw new Error(`Main row ${rowNumber} has no link cell value`);
    }
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
          relationship: Relationship.ManyOne,
          foreignTableId,
          isOneWay: true,
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
        [config.link.fieldName]: { id: foreignRecordId },
      },
    };
  });
  const seedBatchDurations: number[] = [];
  for (const batch of chunk(records, config.batchSize)) {
    const batchMeasurement = await measureAsync("seedBatch", () =>
      createRecords(table.id, {
        fieldKeyType: FieldKeyType.Name,
        typecast: true,
        records: batch,
      }),
    );
    seedBatchDurations.push(batchMeasurement.durationMs);
    expect(batchMeasurement.result.records).toHaveLength(batch.length);
  }

  return { tableId: table.id, seedBatchDurations };
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
      new URL("./record-undo-redo.shared.ts", import.meta.url),
      runner === "table-delete-link"
        ? new URL("./table-delete-link.runner.ts", import.meta.url)
        : runner === "table-restore-link"
          ? new URL("./table-restore-link.runner.ts", import.meta.url)
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
    foreignRowCount: sample.fixture.link.foreignRowCount,
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
