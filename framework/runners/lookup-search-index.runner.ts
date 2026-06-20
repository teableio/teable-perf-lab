import { performance } from "node:perf_hooks";
import { FieldKeyType, FieldType } from "@teable/core";
import { PrismaService } from "@teable/db-main-prisma";
import { TableIndex, axios } from "@teable/openapi";
import bcrypt from "bcrypt";
import {
  createField,
  createRecords,
  createTable,
  getFields,
  getRecord,
  getRecords,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { TableIndexService } from "../../../../src/features/table/table-index.service";
import { getPositiveIntegerEnv, getPrimaryThresholdMs } from "../env";
import {
  type Measurement,
  measureAsync,
  roundMetric,
  summarizeDurations,
} from "../metrics";
import {
  buildSeedCacheInfo,
  buildSeedTableName,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { withPerfTraceStep } from "../trace-collector";
import type {
  LookupSearchIndexCaseConfig,
  LookupSearchKeywordConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  runReadLifecycle,
  seedReadLifecycle,
  type ReadLifecycleSpec,
} from "./read-lifecycle";

type FieldIds = Record<string, string>;

type LookupSearchIndexFixture = {
  sourceTableId: string;
  offTableId: string;
  onTableId: string;
  offViewId: string;
  onViewId: string;
  sourceFieldIds: FieldIds;
  offFieldIds: FieldIds;
  onFieldIds: FieldIds;
  userIds: string[];
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  createTablesMeasurement: Measurement<unknown>;
  seedUsersMeasurement: Measurement<unknown>;
  seedSourceMeasurement: Measurement<unknown>;
  seedOffMeasurement: Measurement<unknown>;
  seedOnMeasurement: Measurement<unknown>;
  createLookupFieldsMeasurement: Measurement<unknown>;
  indexOnMeasurement: Measurement<unknown>;
};

const SOURCE_KEY = "Source Key";
const HOST_KEY = "Host Key";
const SHARED_SEED_CASE_ID = "search/search-index-10k-20search-fields-seed";

const sourceTextName = (index: number) => `Source Text ${index}`;
const sourceNumberName = (index: number) => `Source Number ${index}`;
const sourceDateName = (index: number) => `Source Date ${index}`;
const sourceStatusName = () => `Source Status`;
const sourceTagsName = () => `Source Tags`;
const sourceUserName = (index: number) => `Source User ${index}`;
const lookupKeyName = (index: number) => `Lookup Key ${index}`;
const ownTextName = (index: number) => `Own Text ${index}`;
const ownNumberName = (index: number) => `Own Number ${index}`;
const ownDateName = (index: number) => `Own Date ${index}`;
const ownStatusName = () => `Own Status`;
const ownTagsName = () => `Own Tags`;
const ownUserName = (index: number) => `Own User ${index}`;
const lookupTextName = (index: number) => `Lookup Text ${index}`;
const lookupNumberName = (index: number) => `Lookup Number ${index}`;
const lookupDateName = (index: number) => `Lookup Date ${index}`;
const lookupStatusName = () => `Lookup Status`;
const lookupTagsName = () => `Lookup Tags`;
const lookupUserName = (index: number) => `Lookup User ${index}`;

const sourceStatusChoices = ["Alpha", "Beta", "Gamma", "Delta"];
const sourceTagChoices = ["Red", "Blue", "Green", "Yellow"];
const ownStatusChoices = ["Todo", "Doing", "Done", "Blocked"];
const ownTagChoices = ["North", "South", "East", "West"];

const selectOptions = (choices: string[]) => ({
  choices: choices.map((name) => ({ name })),
});

const sourceFieldNames = [
  SOURCE_KEY,
  sourceTextName(1),
  sourceNumberName(1),
  sourceDateName(1),
  sourceStatusName(),
  sourceTagsName(),
  sourceUserName(1),
  sourceUserName(2),
];

const hostBaseFieldNames = [
  HOST_KEY,
  lookupKeyName(1),
  lookupKeyName(2),
  ...Array.from({ length: 3 }, (_, index) => ownTextName(index + 1)),
  ...Array.from({ length: 2 }, (_, index) => ownNumberName(index + 1)),
  ownDateName(1),
  ownStatusName(),
  ownTagsName(),
  ownUserName(1),
  ownUserName(2),
];

const hostLookupFieldNames = [
  lookupTextName(1),
  lookupNumberName(1),
  lookupStatusName(),
  lookupTagsName(),
  lookupDateName(1),
  lookupUserName(1),
  lookupUserName(2),
];

const hostSearchFieldNames = [...hostBaseFieldNames, ...hostLookupFieldNames];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getSearchTraceSampleSettleMs = () => {
  if (process.env.PERF_LAB_TRACE_ENABLED === "false") {
    return 0;
  }
  return getPositiveIntegerEnv("PERF_LAB_SEARCH_TRACE_SAMPLE_SETTLE_MS") ?? 50;
};

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const getGreatestCommonDivisor = (left: number, right: number): number => {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
};

const assertConfig = (config: LookupSearchIndexCaseConfig) => {
  if (hostSearchFieldNames.length !== 20) {
    throw new Error(`Host search field layout must be 20 fields`);
  }
  if (config.tableIndexMode !== "off" && config.tableIndexMode !== "on") {
    throw new Error(`Lookup search index tableIndexMode must be "off" or "on"`);
  }
  if (config.userCount < 2) {
    throw new Error(`Lookup search index userCount must be at least 2`);
  }
  if (
    getGreatestCommonDivisor(
      config.generator.permutation.multiplier,
      config.recordCount,
    ) !== 1
  ) {
    throw new Error(
      `Permutation multiplier ${config.generator.permutation.multiplier} must be coprime with recordCount ${config.recordCount}`,
    );
  }
};

const sourceRowForHostRow = (
  hostRowNumber: number,
  keyIndex: number,
  config: LookupSearchIndexCaseConfig,
) => {
  const { multiplier, offset } = config.generator.permutation;
  const hostRowOffset = hostRowNumber - 1;
  const adjustedOffset = offset + (keyIndex - 1) * 37;
  return (
    ((hostRowOffset * multiplier + adjustedOffset) % config.recordCount) + 1
  );
};

const sourceKey = (rowNumber: number, config: LookupSearchIndexCaseConfig) =>
  `${config.generator.sourceKeyPrefix}-${rowNumber}`;

const hostKey = (rowNumber: number, config: LookupSearchIndexCaseConfig) =>
  `${config.generator.hostKeyPrefix}-${rowNumber}`;

const sourceTextValue = (
  textIndex: number,
  rowNumber: number,
  config: LookupSearchIndexCaseConfig,
) => `${config.generator.sourceTextPrefix}${textIndex}-Value-${rowNumber}`;

const isoDateValue = (month: number, rowNumber: number) =>
  `2026-${String(month).padStart(2, "0")}-${String(
    ((rowNumber - 1) % 28) + 1,
  ).padStart(2, "0")}`;

const sourceStatusValue = (rowNumber: number) =>
  sourceStatusChoices[(rowNumber - 1) % sourceStatusChoices.length];

const sourceTagsValue = (rowNumber: number) => [
  sourceTagChoices[(rowNumber - 1) % sourceTagChoices.length],
  sourceTagChoices[rowNumber % sourceTagChoices.length],
];

const ownStatusValue = (rowNumber: number) =>
  ownStatusChoices[(rowNumber - 1) % ownStatusChoices.length];

const ownTagsValue = (rowNumber: number) => [
  ownTagChoices[(rowNumber - 1) % ownTagChoices.length],
  ownTagChoices[(rowNumber + 1) % ownTagChoices.length],
];

const userCell = (userId: string, index: number) => ({
  id: userId,
  title: `perf_lookup_user_${index}`,
  email: `perf_lookup_user_${index}@e2e.com`,
});

const resolveFieldIds = (
  fields: Array<{ id: string; name: string }>,
  requiredNames: string[],
  tableId: string,
) => {
  const fieldByName = new Map(fields.map((field) => [field.name, field.id]));
  const missing = requiredNames.filter((name) => !fieldByName.has(name));
  if (missing.length) {
    throw new Error(
      `Missing fields on ${tableId}: ${missing.join(", ")}; available=${fields
        .map(({ name }) => name)
        .join(", ")}`,
    );
  }
  return Object.fromEntries(
    requiredNames.map((name) => [name, fieldByName.get(name)!]),
  );
};

const getBaseId = (config: LookupSearchIndexCaseConfig) => {
  if (config.baseId !== "seed-base") {
    throw new Error(
      `Unsupported baseId for lookup-search-index: ${config.baseId}`,
    );
  }
  return globalThis.testConfig.baseId;
};

const getSeedConfig = (config: LookupSearchIndexCaseConfig) => ({
  baseId: config.baseId,
  sourceTableNamePrefix: config.sourceTableNamePrefix,
  hostTableNamePrefix: config.hostTableNamePrefix,
  recordCount: config.recordCount,
  batchSize: config.batchSize,
  userCount: config.userCount,
  generator: config.generator,
  sourceFieldNames,
  hostSearchFieldNames,
  keywords: config.keywords,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: "lookup-search-index-v1",
});

const ensurePerfUsers = async (
  context: PerfRunContext,
  config: LookupSearchIndexCaseConfig,
): Promise<string[]> => {
  const prisma = context.app.get<PrismaService>(PrismaService);
  const base = await prisma.base.findUniqueOrThrow({
    where: { id: globalThis.testConfig.baseId },
    select: { spaceId: true },
  });
  const salt = await bcrypt.genSalt(10);
  const password = await bcrypt.hash("12345678", salt);
  const userIds = Array.from(
    { length: config.userCount },
    (_, index) => `usrPerfLookupSearch_${index}`,
  );

  for (const [index, userId] of userIds.entries()) {
    await prisma.user.upsert({
      where: { id: userId },
      update: {
        name: `perf_lookup_user_${index}`,
        email: `perf_lookup_user_${index}@e2e.com`,
        avatar: `avatar/${userId}`,
        notifyMeta: JSON.stringify({ email: true }),
      },
      create: {
        id: userId,
        name: `perf_lookup_user_${index}`,
        email: `perf_lookup_user_${index}@e2e.com`,
        salt,
        password,
        avatar: `avatar/${userId}`,
        notifyMeta: JSON.stringify({ email: true }),
        isAdmin: false,
      },
    });
    await prisma.collaborator.upsert({
      where: {
        resourceType_resourceId_principalId_principalType: {
          resourceId: base.spaceId,
          resourceType: "space",
          principalId: userId,
          principalType: "user",
        },
      },
      update: {
        roleName: "owner",
        principalType: "user",
        createdBy: globalThis.testConfig.userId,
      },
      create: {
        id: `clbPerfLookupSearch_${index}`,
        resourceId: base.spaceId,
        resourceType: "space",
        roleName: "owner",
        principalId: userId,
        principalType: "user",
        createdBy: globalThis.testConfig.userId,
      },
    });
  }

  return userIds;
};

const buildSourceRecords = (
  config: LookupSearchIndexCaseConfig,
  userIds: string[],
) =>
  Array.from({ length: config.recordCount }, (_, index) => {
    const rowNumber = index + 1;
    const fields: Record<string, unknown> = {
      [SOURCE_KEY]: sourceKey(rowNumber, config),
      [sourceTextName(1)]: sourceTextValue(1, rowNumber, config),
      [sourceNumberName(1)]: rowNumber,
      [sourceDateName(1)]: isoDateValue(6, rowNumber),
      [sourceStatusName()]: sourceStatusValue(rowNumber),
      [sourceTagsName()]: sourceTagsValue(rowNumber),
    };
    fields[sourceUserName(1)] = userCell(
      userIds[(rowNumber - 1) % userIds.length],
      (rowNumber - 1) % userIds.length,
    );
    fields[sourceUserName(2)] = userCell(
      userIds[(rowNumber + 2) % userIds.length],
      (rowNumber + 2) % userIds.length,
    );
    return { fields };
  });

const buildHostRecords = (
  config: LookupSearchIndexCaseConfig,
  userIds: string[],
) =>
  Array.from({ length: config.recordCount }, (_, index) => {
    const rowNumber = index + 1;
    const fields: Record<string, unknown> = {
      [HOST_KEY]: hostKey(rowNumber, config),
    };
    for (let keyIndex = 1; keyIndex <= 2; keyIndex++) {
      fields[lookupKeyName(keyIndex)] = sourceKey(
        sourceRowForHostRow(rowNumber, keyIndex, config),
        config,
      );
    }
    for (let textIndex = 1; textIndex <= 3; textIndex++) {
      fields[ownTextName(textIndex)] =
        `HostText${textIndex}-Value-${rowNumber}`;
    }
    for (let numberIndex = 1; numberIndex <= 2; numberIndex++) {
      fields[ownNumberName(numberIndex)] = rowNumber * numberIndex;
    }
    fields[ownDateName(1)] = isoDateValue(7, rowNumber);
    fields[ownStatusName()] = ownStatusValue(rowNumber);
    fields[ownTagsName()] = ownTagsValue(rowNumber);
    fields[ownUserName(1)] = userCell(
      userIds[(rowNumber - 1) % userIds.length],
      (rowNumber - 1) % userIds.length,
    );
    fields[ownUserName(2)] = userCell(
      userIds[(rowNumber + 2) % userIds.length],
      (rowNumber + 2) % userIds.length,
    );
    return { fields };
  });

const seedRecords = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  tableId: string,
  records: Array<{ fields: Record<string, unknown> }>,
  batchSize: number,
  tracePrefix: string,
) => {
  const batchDurations: number[] = [];
  for (const [batchIndex, batch] of chunk(records, batchSize).entries()) {
    const measurement = await measureAsync(
      `${tracePrefix}:${batchIndex + 1}`,
      () =>
        withPerfTraceStep(
          context,
          perfCase,
          `${tracePrefix}:${batchIndex + 1}`,
          () =>
            createRecords(tableId, {
              fieldKeyType: FieldKeyType.Name,
              typecast: false,
              records: batch,
            }),
        ),
    );
    expect(measurement.result.records).toHaveLength(batch.length);
    batchDurations.push(measurement.durationMs);
  }
  return batchDurations;
};

const createLookupFields = async (
  hostTableId: string,
  sourceTableId: string,
  sourceFieldIds: FieldIds,
  hostFieldIds: FieldIds,
) => {
  const createdFields = [];
  const lookupFilter = {
    conjunction: "and",
    filterSet: [
      {
        fieldId: sourceFieldIds[SOURCE_KEY],
        operator: "is",
        value: {
          type: "field",
          fieldId: hostFieldIds[lookupKeyName(1)],
        },
      },
    ],
  };
  const lookupFields = [
    {
      name: lookupTextName(1),
      type: FieldType.SingleLineText,
      lookupFieldId: sourceFieldIds[sourceTextName(1)],
    },
    {
      name: lookupNumberName(1),
      type: FieldType.Number,
      lookupFieldId: sourceFieldIds[sourceNumberName(1)],
    },
    {
      name: lookupStatusName(),
      type: FieldType.SingleSelect,
      lookupFieldId: sourceFieldIds[sourceStatusName()],
    },
    {
      name: lookupTagsName(),
      type: FieldType.MultipleSelect,
      lookupFieldId: sourceFieldIds[sourceTagsName()],
    },
    {
      name: lookupDateName(1),
      type: FieldType.Date,
      lookupFieldId: sourceFieldIds[sourceDateName(1)],
    },
    {
      name: lookupUserName(1),
      type: FieldType.User,
      lookupFieldId: sourceFieldIds[sourceUserName(1)],
    },
    {
      name: lookupUserName(2),
      type: FieldType.User,
      lookupFieldId: sourceFieldIds[sourceUserName(2)],
    },
  ];
  for (const field of lookupFields) {
    createdFields.push(
      await createField(hostTableId, {
        name: field.name,
        type: field.type,
        isLookup: true,
        isConditionalLookup: true,
        lookupOptions: {
          foreignTableId: sourceTableId,
          lookupFieldId: field.lookupFieldId,
          filter: lookupFilter,
          limit: 1,
        },
      }),
    );
  }
  return createdFields;
};

const waitForLookupSamples = async (
  tableId: string,
  fieldIds: FieldIds,
  config: LookupSearchIndexCaseConfig,
) => {
  const startedAt = Date.now();
  const timeoutMs = config.verify.timeoutMs ?? 120_000;
  const pollIntervalMs = config.verify.pollIntervalMs ?? 500;
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const verified = [];
      for (const rowOffset of config.verify.sampleRows) {
        const rowNumber = rowOffset + 1;
        const recordPage = await getRecords(tableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: [fieldIds[HOST_KEY], fieldIds[lookupTextName(1)]],
          skip: rowOffset,
          take: 1,
        });
        const record = recordPage.records[0];
        if (!record) {
          throw new Error(`Missing host row at offset ${rowOffset}`);
        }
        const sourceRow = sourceRowForHostRow(rowNumber, 1, config);
        const expected = [sourceTextValue(1, sourceRow, config)];
        const actual = record.fields[fieldIds[lookupTextName(1)]];
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(
            `Lookup sample mismatch row=${rowNumber} expected=${JSON.stringify(
              expected,
            )} actual=${JSON.stringify(actual)}`,
          );
        }
        verified.push({ rowOffset, rowNumber, sourceRow, expected, actual });
      }
      return verified;
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for lookup samples: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

const assertLookupSeedReady = async (
  fixture: LookupSearchIndexFixture,
  config: LookupSearchIndexCaseConfig,
) => {
  const [sourceLast, offLast, onLast] = await Promise.all([
    getRecords(fixture.sourceTableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [fixture.sourceFieldIds[SOURCE_KEY]],
      skip: config.recordCount - 1,
      take: 1,
    }),
    getRecords(fixture.offTableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [fixture.offFieldIds[HOST_KEY]],
      skip: config.recordCount - 1,
      take: 1,
    }),
    getRecords(fixture.onTableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [fixture.onFieldIds[HOST_KEY]],
      skip: config.recordCount - 1,
      take: 1,
    }),
  ]);

  if (!sourceLast.records[0] || !offLast.records[0] || !onLast.records[0]) {
    throw new Error(`Lookup search index seed missing final row`);
  }

  await waitForLookupSamples(fixture.offTableId, fixture.offFieldIds, config);
  await waitForLookupSamples(fixture.onTableId, fixture.onFieldIds, config);

  return {
    recordCount: config.recordCount,
    userCount: fixture.userIds.length,
    sampleRows: config.verify.sampleRows,
  };
};

const createFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  names: { source: string; off: string; on: string },
  config: LookupSearchIndexCaseConfig,
  seedCacheInfo: SeedCacheInfo,
): Promise<LookupSearchIndexFixture> => {
  const createdTableIds: string[] = [];
  try {
    const seedUsersMeasurement = await measureAsync("seedUsers", () =>
      ensurePerfUsers(context, config),
    );
    const userIds = seedUsersMeasurement.result;

    const createTablesMeasurement = await measureAsync(
      "createTables",
      async () => {
        const sourceTable = await createTable(baseId, {
          name: names.source,
          fields: [
            { name: SOURCE_KEY, type: FieldType.SingleLineText },
            { name: sourceTextName(1), type: FieldType.SingleLineText },
            { name: sourceNumberName(1), type: FieldType.Number },
            { name: sourceDateName(1), type: FieldType.Date },
            {
              name: sourceStatusName(),
              type: FieldType.SingleSelect,
              options: selectOptions(sourceStatusChoices),
            },
            {
              name: sourceTagsName(),
              type: FieldType.MultipleSelect,
              options: selectOptions(sourceTagChoices),
            },
            { name: sourceUserName(1), type: FieldType.User },
            { name: sourceUserName(2), type: FieldType.User },
          ],
          records: [],
        });
        createdTableIds.push(sourceTable.id);
        const hostFields = [
          { name: HOST_KEY, type: FieldType.SingleLineText },
          { name: lookupKeyName(1), type: FieldType.SingleLineText },
          { name: lookupKeyName(2), type: FieldType.SingleLineText },
          ...Array.from({ length: 3 }, (_, index) => ({
            name: ownTextName(index + 1),
            type: FieldType.SingleLineText,
          })),
          ...Array.from({ length: 2 }, (_, index) => ({
            name: ownNumberName(index + 1),
            type: FieldType.Number,
          })),
          { name: ownDateName(1), type: FieldType.Date },
          {
            name: ownStatusName(),
            type: FieldType.SingleSelect,
            options: selectOptions(ownStatusChoices),
          },
          {
            name: ownTagsName(),
            type: FieldType.MultipleSelect,
            options: selectOptions(ownTagChoices),
          },
          { name: ownUserName(1), type: FieldType.User },
          { name: ownUserName(2), type: FieldType.User },
        ];
        const offTable = await createTable(baseId, {
          name: names.off,
          fields: hostFields,
          records: [],
        });
        createdTableIds.push(offTable.id);
        const onTable = await createTable(baseId, {
          name: names.on,
          fields: hostFields,
          records: [],
        });
        createdTableIds.push(onTable.id);
        return { sourceTable, offTable, onTable };
      },
    );

    const sourceTableId = createTablesMeasurement.result.sourceTable.id;
    const offTableId = createTablesMeasurement.result.offTable.id;
    const onTableId = createTablesMeasurement.result.onTable.id;
    const offViewId = createTablesMeasurement.result.offTable.views[0]?.id;
    const onViewId = createTablesMeasurement.result.onTable.views[0]?.id;
    if (!offViewId || !onViewId) {
      throw new Error(
        `Lookup search index seed tables missing default grid view`,
      );
    }

    const sourceFieldIds = resolveFieldIds(
      createTablesMeasurement.result.sourceTable.fields,
      sourceFieldNames,
      sourceTableId,
    );
    const offFieldIds = resolveFieldIds(
      createTablesMeasurement.result.offTable.fields,
      hostBaseFieldNames,
      offTableId,
    );
    const onFieldIds = resolveFieldIds(
      createTablesMeasurement.result.onTable.fields,
      hostBaseFieldNames,
      onTableId,
    );

    const seedSourceMeasurement = await measureAsync("seedSourceRecords", () =>
      seedRecords(
        perfCase,
        context,
        sourceTableId,
        buildSourceRecords(config, userIds),
        config.batchSize,
        "seedSourceBatch",
      ),
    );
    const hostRecords = buildHostRecords(config, userIds);
    const seedOffMeasurement = await measureAsync("seedOffHostRecords", () =>
      seedRecords(
        perfCase,
        context,
        offTableId,
        hostRecords,
        config.batchSize,
        "seedOffBatch",
      ),
    );
    const seedOnMeasurement = await measureAsync("seedOnHostRecords", () =>
      seedRecords(
        perfCase,
        context,
        onTableId,
        hostRecords,
        config.batchSize,
        "seedOnBatch",
      ),
    );

    const createLookupFieldsMeasurement = await measureAsync(
      "createLookupFields",
      async () => {
        const offLookupFields = await createLookupFields(
          offTableId,
          sourceTableId,
          sourceFieldIds,
          offFieldIds,
        );
        const onLookupFields = await createLookupFields(
          onTableId,
          sourceTableId,
          sourceFieldIds,
          onFieldIds,
        );
        return { offLookupFields, onLookupFields };
      },
    );

    const allOffFieldIds = resolveFieldIds(
      await getFields(offTableId),
      hostSearchFieldNames,
      offTableId,
    );
    const allOnFieldIds = resolveFieldIds(
      await getFields(onTableId),
      hostSearchFieldNames,
      onTableId,
    );

    await waitForLookupSamples(offTableId, allOffFieldIds, config);
    await waitForLookupSamples(onTableId, allOnFieldIds, config);

    const tableIndexService =
      context.app.get<TableIndexService>(TableIndexService);
    const indexOnMeasurement = await measureAsync(
      "activateSearchIndexOnHost",
      async () => {
        const active =
          await tableIndexService.getActivatedTableIndexes(onTableId);
        if (!active.includes(TableIndex.search)) {
          await tableIndexService.toggleIndex(onTableId, {
            type: TableIndex.search,
          });
        }
        return tableIndexService.getActivatedTableIndexes(onTableId);
      },
    );

    return {
      sourceTableId,
      offTableId,
      onTableId,
      offViewId,
      onViewId,
      sourceFieldIds,
      offFieldIds: allOffFieldIds,
      onFieldIds: allOnFieldIds,
      userIds,
      seedCacheInfo,
      seedCacheHit: false,
      createTablesMeasurement,
      seedUsersMeasurement,
      seedSourceMeasurement,
      seedOffMeasurement,
      seedOnMeasurement,
      createLookupFieldsMeasurement,
      indexOnMeasurement,
    };
  } catch (error) {
    for (const tableId of createdTableIds.reverse()) {
      try {
        await permanentDeleteTable(baseId, tableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup lookup search index seed ${tableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const restoreFixture = async (
  context: PerfRunContext,
  baseId: string,
  names: { source: string; off: string; on: string },
  config: LookupSearchIndexCaseConfig,
  seedCacheInfo: SeedCacheInfo,
): Promise<LookupSearchIndexFixture | undefined> => {
  if (!seedCacheInfo.enabled) {
    return;
  }
  const [sourceTable, offTable, onTable] = await Promise.all([
    findSeedTable(baseId, names.source),
    findSeedTable(baseId, names.off),
    findSeedTable(baseId, names.on),
  ]);
  if (!sourceTable || !offTable || !onTable) {
    return;
  }
  const [sourceFields, offFields, onFields] = await Promise.all([
    getFields(sourceTable.id),
    getFields(offTable.id),
    getFields(onTable.id),
  ]);
  const [offViews, onViews] = await Promise.all([
    getViews(offTable.id),
    getViews(onTable.id),
  ]);
  const offViewId = offViews[0]?.id;
  const onViewId = onViews[0]?.id;
  if (!offViewId || !onViewId) {
    return;
  }
  const fixture: LookupSearchIndexFixture = {
    sourceTableId: sourceTable.id,
    offTableId: offTable.id,
    onTableId: onTable.id,
    offViewId,
    onViewId,
    sourceFieldIds: resolveFieldIds(
      sourceFields,
      sourceFieldNames,
      sourceTable.id,
    ),
    offFieldIds: resolveFieldIds(offFields, hostSearchFieldNames, offTable.id),
    onFieldIds: resolveFieldIds(onFields, hostSearchFieldNames, onTable.id),
    userIds: Array.from(
      { length: config.userCount },
      (_, index) => `usrPerfLookupSearch_${index}`,
    ),
    seedCacheInfo,
    seedCacheHit: true,
    createTablesMeasurement: {
      name: "createTables",
      durationMs: 0,
      result: null,
    },
    seedUsersMeasurement: { name: "seedUsers", durationMs: 0, result: null },
    seedSourceMeasurement: {
      name: "seedSourceRecords",
      durationMs: 0,
      result: [],
    },
    seedOffMeasurement: {
      name: "seedOffHostRecords",
      durationMs: 0,
      result: [],
    },
    seedOnMeasurement: { name: "seedOnHostRecords", durationMs: 0, result: [] },
    createLookupFieldsMeasurement: {
      name: "createLookupFields",
      durationMs: 0,
      result: null,
    },
    indexOnMeasurement: {
      name: "activateSearchIndexOnHost",
      durationMs: 0,
      result: null,
    },
  };
  if (!fixture.offViewId || !fixture.onViewId) {
    throw new Error(`Cached lookup search index fixture missing view ids`);
  }
  try {
    await ensurePerfUsers(context, config);
    await assertLookupSeedReady(fixture, config);
    const tableIndexService =
      context.app.get<TableIndexService>(TableIndexService);
    const onIndexes = await tableIndexService.getActivatedTableIndexes(
      fixture.onTableId,
    );
    if (!onIndexes.includes(TableIndex.search)) {
      return;
    }
    return fixture;
  } catch (error) {
    console.warn(
      `Cached lookup search index fixture failed validation and will be rebuilt: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    for (const tableId of [
      fixture.onTableId,
      fixture.offTableId,
      fixture.sourceTableId,
    ]) {
      await permanentDeleteTable(baseId, tableId);
    }
    return;
  }
};

const prepareLookupSearchIndexFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: LookupSearchIndexCaseConfig,
) => {
  const baseId = getBaseId(config);
  const seedPerfCase = {
    ...perfCase,
    id: SHARED_SEED_CASE_ID,
  };
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase: seedPerfCase,
    runner: "lookup-search-index",
    fixtureVersion: "lookup-search-index-v1",
    seedConfig: getSeedConfig(config),
    seedCodeFiles: [
      new URL("./lookup-search-index.runner.ts", import.meta.url),
    ],
  });
  const names = {
    source: buildSeedTableName(seedCacheInfo, "source"),
    off: buildSeedTableName(seedCacheInfo, "off"),
    on: buildSeedTableName(seedCacheInfo, "on"),
  };
  const restored = await restoreFixture(
    context,
    baseId,
    names,
    config,
    seedCacheInfo,
  );
  if (restored) {
    return restored;
  }
  return createFixture(perfCase, context, baseId, names, config, seedCacheInfo);
};

const runSearchSample = async (
  tableId: string,
  viewId: string,
  keyword: LookupSearchKeywordConfig,
  signal?: AbortSignal,
) => {
  const response = await axios.get<Array<{
    index: number;
    fieldId: string;
    recordId: string;
  }> | null>(`/table/${tableId}/aggregation/search-index`, {
    params: {
      skip: 0,
      take: 100,
      viewId,
      search: [keyword.value, "", true],
    },
    signal,
  });
  expect(response.status).toBe(200);
  return response.data ?? [];
};

const assertFieldGroup = (
  keyword: LookupSearchKeywordConfig,
  fieldId: string | undefined,
  fieldIds: FieldIds,
) => {
  if (!fieldId) {
    throw new Error(`Missing first hit for keyword ${keyword.value}`);
  }
  const expectedFieldIdsByGroup: Record<string, Array<string | undefined>> = {
    "lookup-key": [fieldIds[lookupKeyName(1)], fieldIds[lookupKeyName(2)]],
    "own-text": [
      fieldIds[ownTextName(1)],
      fieldIds[ownTextName(2)],
      fieldIds[ownTextName(3)],
    ],
    "lookup-text": [fieldIds[lookupTextName(1)]],
    "own-select": [fieldIds[ownStatusName()]],
    "lookup-select": [fieldIds[lookupStatusName()]],
    "own-multiple-select": [fieldIds[ownTagsName()]],
    "lookup-multiple-select": [fieldIds[lookupTagsName()]],
    user: [
      fieldIds[ownUserName(1)],
      fieldIds[ownUserName(2)],
      fieldIds[lookupUserName(1)],
      fieldIds[lookupUserName(2)],
    ],
  };
  const expectedFieldIds =
    expectedFieldIdsByGroup[keyword.expectedFieldGroup] ?? [];
  if (!expectedFieldIds.includes(fieldId)) {
    throw new Error(
      `Unexpected first hit field for ${keyword.value}: ${fieldId}; expected group=${keyword.expectedFieldGroup}`,
    );
  }
};

const runKeywordSamples = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  tableId: string,
  viewId: string,
  fieldIds: FieldIds,
  tableLabel: "off" | "on",
  keyword: LookupSearchKeywordConfig,
  samples: number,
) => {
  const details = [];
  const traceSampleSettleMs = getSearchTraceSampleSettleMs();
  for (let iteration = 1; iteration <= samples; iteration++) {
    const startedAt = performance.now();
    const data = await withPerfTraceStep(
      context,
      perfCase,
      `${tableLabel}:${keyword.name}:sample-${iteration}`,
      () => runSearchSample(tableId, viewId, keyword, context.signal),
    );
    const durationMs = roundMetric(performance.now() - startedAt);
    if (traceSampleSettleMs > 0) {
      await sleep(traceSampleSettleMs);
    }
    if (
      keyword.expectedHitCount != null &&
      data.length !== keyword.expectedHitCount
    ) {
      throw new Error(
        `${tableLabel} keyword ${keyword.value} expected ${keyword.expectedHitCount} hits, got ${data.length}`,
      );
    }
    if (
      keyword.expectedMinHitCount != null &&
      data.length < keyword.expectedMinHitCount
    ) {
      throw new Error(
        `${tableLabel} keyword ${keyword.value} expected at least ${keyword.expectedMinHitCount} hits, got ${data.length}`,
      );
    }
    assertFieldGroup(keyword, data[0]?.fieldId, fieldIds);
    details.push({
      iteration,
      durationMs,
      hitCount: data.length,
      firstHit: data[0],
    });
  }
  return {
    keyword: keyword.value,
    expectedHitCount: keyword.expectedHitCount,
    expectedMinHitCount: keyword.expectedMinHitCount,
    fieldGroup: keyword.expectedFieldGroup,
    summary: summarizeDurations(details.map(({ durationMs }) => durationMs)),
    samples: details,
  };
};

const buildLookupSearchIndexResult = (
  config: LookupSearchIndexCaseConfig,
  fixture: LookupSearchIndexFixture,
  seedReadyMeasurement: Measurement<unknown>,
  offResults: Awaited<ReturnType<typeof runKeywordSamples>>[],
  onResults: Awaited<ReturnType<typeof runKeywordSamples>>[],
): PerfRunResult => {
  const selectedResults =
    config.tableIndexMode === "on" ? onResults : offResults;
  const selectedDurations = selectedResults.flatMap((result) =>
    result.samples.map(({ durationMs }) => durationMs),
  );
  const selectedSummary = summarizeDurations(selectedDurations);
  const thresholdMs = getPrimaryThresholdMs(config.threshold.maxMs);
  const metrics: Record<string, number> = {
    lookupSearchIndexP95Ms: selectedSummary.p95Ms,
    searchIndexP95Ms: selectedSummary.p95Ms,
    searchIndexP50Ms: selectedSummary.p50Ms,
    [`${config.tableIndexMode}P95Ms`]: selectedSummary.p95Ms,
    [`${config.tableIndexMode}P50Ms`]: selectedSummary.p50Ms,
    seedReadyMs: seedReadyMeasurement.durationMs,
    createTablesMs: fixture.createTablesMeasurement.durationMs,
    seedUsersMs: fixture.seedUsersMeasurement.durationMs,
    seedSourceMs: fixture.seedSourceMeasurement.durationMs,
    seedOffHostMs: fixture.seedOffMeasurement.durationMs,
    seedOnHostMs: fixture.seedOnMeasurement.durationMs,
    createLookupFieldsMs: fixture.createLookupFieldsMeasurement.durationMs,
    activateSearchIndexOnHostMs: fixture.indexOnMeasurement.durationMs,
  };

  return {
    metrics,
    thresholds: [
      { metric: config.threshold.metric, max: thresholdMs, unit: "ms" },
    ],
    phases: [
      { name: "seedReady", durationMs: seedReadyMeasurement.durationMs },
      {
        name: `searchIndex${config.tableIndexMode === "on" ? "On" : "Off"}`,
        durationMs: roundMetric(selectedDurations.reduce((a, b) => a + b, 0)),
      },
    ],
    details: {
      recordCount: config.recordCount,
      searchFieldCount: hostSearchFieldNames.length,
      tableIndexMode: config.tableIndexMode,
      samples: getPositiveIntegerEnv("PERF_LAB_SAMPLES") ?? config.samples,
      tables: {
        sourceTableId: fixture.sourceTableId,
        offTableId: fixture.offTableId,
        onTableId: fixture.onTableId,
        offViewId: fixture.offViewId,
        onViewId: fixture.onViewId,
      },
      userIds: fixture.userIds,
      fieldLayout: hostSearchFieldNames,
      seedCache: {
        ...fixture.seedCacheInfo,
        hit: fixture.seedCacheHit,
      },
      keywords:
        config.tableIndexMode === "on"
          ? { on: onResults }
          : { off: offResults },
    },
  };
};

type LookupSearchIndexPrimary = {
  offResults: Awaited<ReturnType<typeof runKeywordSamples>>[];
  onResults: Awaited<ReturnType<typeof runKeywordSamples>>[];
};

// lookup-search-index is the SECOND member of the read lifecycle: it measures
// global aggregation/search-index reads over a seeded source + dual host
// (index-off / index-on) table set. It rides the same driver as record-read —
// seed (or restore) the read fixture, assert it is fully readable, run the
// measured read workload, and (per the driver's read cleanup policy) drop nothing
// because the seed is always a reusable cached seed. Two member-specific shapes
// ride in the spec:
//   * prepare carries its per-stage seed sub-measurements on the fixture and emits
//     NO "prepare" phase (the driver emits none); the runner surfaces them from
//     buildResult, matching the pre-migration artifact.
//   * the measured primary is a keyword x sample loop whose p95 is the threshold
//     metric, expressed entirely inside the opaque runPrimary.
// isReusableSeed is always true: the seed is the shared cached fixture both the
// off and on cases reuse, so it is never dropped (matching the pre-migration
// runner, which had no cleanup at all).
const lookupSearchIndexSpec: ReadLifecycleSpec<
  LookupSearchIndexCaseConfig,
  LookupSearchIndexFixture,
  Awaited<ReturnType<typeof assertLookupSeedReady>>,
  LookupSearchIndexPrimary
> = {
  prepareFixture: ({ perfCase, context, config }) => {
    assertConfig(config);
    return prepareLookupSearchIndexFixture(perfCase, context, config);
  },
  assertSeedReady: ({ fixture, config }) =>
    assertLookupSeedReady(fixture, config),
  runPrimary: async ({ perfCase, context, fixture, config }) => {
    const samples = getPositiveIntegerEnv("PERF_LAB_SAMPLES") ?? config.samples;
    const offResults: Awaited<ReturnType<typeof runKeywordSamples>>[] = [];
    const onResults: Awaited<ReturnType<typeof runKeywordSamples>>[] = [];
    for (const keyword of config.keywords) {
      if (config.tableIndexMode === "off") {
        offResults.push(
          await runKeywordSamples(
            perfCase,
            context,
            fixture.offTableId,
            fixture.offViewId,
            fixture.offFieldIds,
            "off",
            keyword,
            samples,
          ),
        );
      } else {
        onResults.push(
          await runKeywordSamples(
            perfCase,
            context,
            fixture.onTableId,
            fixture.onViewId,
            fixture.onFieldIds,
            "on",
            keyword,
            samples,
          ),
        );
      }
    }
    return { offResults, onResults };
  },
  buildResult: ({ config, fixture, seedReadyMeasurement, primary }) =>
    // The read driver always prepares the fixture and computes seedReady (outside
    // the diagnostic try) before any buildResult call, so both are defined here;
    // only `primary` is absent on the measured-read failure path.
    buildLookupSearchIndexResult(
      config,
      fixture as LookupSearchIndexFixture,
      seedReadyMeasurement as Measurement<unknown>,
      primary?.offResults ?? [],
      primary?.onResults ?? [],
    ),
  // The seed is the shared cached fixture both cases reuse — never dropped.
  seedTableIds: (fixture) => [
    fixture.onTableId,
    fixture.offTableId,
    fixture.sourceTableId,
  ],
  isReusableSeed: () => true,
};

export const runLookupSearchIndexCase = (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runReadLifecycle(perfCase, context, lookupSearchIndexSpec);

export const seedLookupSearchIndexCase = (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedReadLifecycle(perfCase, context, lookupSearchIndexSpec);
