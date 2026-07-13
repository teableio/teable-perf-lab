import { FieldKeyType, FieldType, SortFunc, type IFieldRo } from "@teable/core";
import { createField as apiCreateField } from "@teable/openapi";
import {
  createRecords,
  createTable,
  deleteField,
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
import {
  buildSeedCacheInfo,
  buildSeedTableName,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { withPerfTraceStep } from "../trace-collector";
import type {
  ConditionalQueryCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";

const SOURCE_FIELDS = ["A Group", "A Text", "A Amount", "A Active"] as const;
const HOST_FIELDS = ["B Key", "Lookup Group"] as const;
const FIXTURE_VERSION = "conditional-query-grouped-v1";
const SHARED_SEED_ID = "conditional-query/grouped-fanout-shared";

type FieldIds = { group: string; text: string; amount: string; active: string };
type HostFieldIds = { key: string; group: string };
type Fixture = {
  sourceTableId: string;
  hostTableId: string;
  sourceTableName: string;
  hostTableName: string;
  sourceFields: FieldIds;
  hostFields: HostFieldIds;
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusable: boolean;
  seedBuildMs: number;
  seedBatchMs: number;
  seedReadyMs: number;
};

const rowsPerGroup = (c: ConditionalQueryCaseConfig) =>
  c.sourceRecordCount / c.groupCount;
const groupForHost = (row: number, c: ConditionalQueryCaseConfig) =>
  (((row - 1) * c.generator.permutation.multiplier +
    c.generator.permutation.offset) %
    c.groupCount) +
  1;
const groupKey = (g: number, c: ConditionalQueryCaseConfig) =>
  `${c.generator.groupPrefix}-${g}`;
const sourceRows = (c: ConditionalQueryCaseConfig) =>
  Array.from({ length: c.sourceRecordCount }, (_, i) => {
    const row = i + 1;
    const group = (i % c.groupCount) + 1;
    const slot = Math.floor(i / c.groupCount) + 1;
    return {
      fields: {
        "A Group": groupKey(group, c),
        "A Text": `${c.generator.sourceTextPrefix}-${group}-${slot}`,
        "A Amount": group * 100 + slot,
        "A Active": slot % 2 === 1,
      },
    };
  });
const hostRows = (c: ConditionalQueryCaseConfig) =>
  Array.from({ length: c.hostRecordCount }, (_, i) => ({
    fields: {
      "B Key": `${c.generator.hostKeyPrefix}-${i + 1}`,
      "Lookup Group": groupKey(groupForHost(i + 1, c), c),
    },
  }));

const resolveFields = (fields: Array<{ id: string; name: string }>) =>
  new Map(fields.map((f) => [f.name, f.id]));
const fixtureFields = (
  source: Array<{ id: string; name: string }>,
  host: Array<{ id: string; name: string }>,
) => {
  const s = resolveFields(source);
  const h = resolveFields(host);
  for (const name of [...SOURCE_FIELDS, ...HOST_FIELDS])
    if (!(s.has(name) || h.has(name)))
      throw new Error(`Missing conditional query seed field ${name}`);
  return {
    sourceFields: {
      group: s.get("A Group")!,
      text: s.get("A Text")!,
      amount: s.get("A Amount")!,
      active: s.get("A Active")!,
    },
    hostFields: { key: h.get("B Key")!, group: h.get("Lookup Group")! },
  };
};

const assertConfig = (c: ConditionalQueryCaseConfig) => {
  if (c.sourceRecordCount % c.groupCount !== 0 || rowsPerGroup(c) < 2)
    throw new Error("Grouped fanout requires an integral fanout >= 2");
};

const assertFixtureReady = async (
  fixture: Fixture,
  c: ConditionalQueryCaseConfig,
) => {
  const sourceChecks = await Promise.all(
    [0, c.sourceRecordCount - 1, c.sourceRecordCount].map((skip) =>
      getRecords(fixture.sourceTableId, {
        fieldKeyType: FieldKeyType.Id,
        projection: Object.values(fixture.sourceFields),
        skip,
        take: 1,
      }),
    ),
  );
  const hostChecks = await Promise.all(
    [0, c.hostRecordCount - 1, c.hostRecordCount].map((skip) =>
      getRecords(fixture.hostTableId, {
        fieldKeyType: FieldKeyType.Id,
        projection: Object.values(fixture.hostFields),
        skip,
        take: 1,
      }),
    ),
  );
  if (
    !sourceChecks[0].records[0] ||
    !sourceChecks[1].records[0] ||
    sourceChecks[2].records.length ||
    !hostChecks[0].records[0] ||
    !hostChecks[1].records[0] ||
    hostChecks[2].records.length
  ) {
    throw new Error(
      `Conditional query seed row-count validation failed: source=${c.sourceRecordCount}, host=${c.hostRecordCount}`,
    );
  }
  const sourceFirst = sourceChecks[0].records[0];
  if (
    sourceFirst.fields[fixture.sourceFields.group] !== groupKey(1, c) ||
    sourceFirst.fields[fixture.sourceFields.text] !==
      `${c.generator.sourceTextPrefix}-1-1` ||
    sourceFirst.fields[fixture.sourceFields.amount] !== 101 ||
    sourceFirst.fields[fixture.sourceFields.active] !== true
  ) {
    throw new Error("Conditional query source seed sample mismatch");
  }
  for (const rowOffset of c.verify.sampleRows) {
    const result = await getRecords(fixture.hostTableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: Object.values(fixture.hostFields),
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    const row = rowOffset + 1;
    if (
      !record ||
      record.fields[fixture.hostFields.key] !==
        `${c.generator.hostKeyPrefix}-${row}` ||
      record.fields[fixture.hostFields.group] !==
        groupKey(groupForHost(row, c), c)
    )
      throw new Error(`Conditional query host seed mismatch at row ${row}`);
  }
};

const prepareFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  c: ConditionalQueryCaseConfig,
): Promise<Fixture> => {
  assertConfig(c);
  const seedCase = { ...perfCase, id: SHARED_SEED_ID };
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase: seedCase,
    runner: "conditional-query",
    fixtureVersion: FIXTURE_VERSION,
    seedConfig: {
      sourceRecordCount: c.sourceRecordCount,
      hostRecordCount: c.hostRecordCount,
      groupCount: c.groupCount,
      batchSize: c.batchSize,
      generator: c.generator,
    },
    seedCodeFiles: [new URL(import.meta.url)],
  });
  const timestamp = Date.now();
  const sourceTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "source")
    : `${c.sourceTableNamePrefix}-${timestamp}`;
  const hostTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "host")
    : `${c.hostTableNamePrefix}-${timestamp}`;
  const [cachedSource, cachedHost] = seedCacheInfo.enabled
    ? await Promise.all([
        findSeedTable(globalThis.testConfig.baseId, sourceTableName),
        findSeedTable(globalThis.testConfig.baseId, hostTableName),
      ])
    : [undefined, undefined];
  if (cachedSource && cachedHost) {
    const fields = fixtureFields(
      await getFields(cachedSource.id),
      await getFields(cachedHost.id),
    );
    for (const field of await getFields(cachedHost.id))
      if (!HOST_FIELDS.includes(field.name as (typeof HOST_FIELDS)[number]))
        await deleteField(cachedHost.id, field.id);
    const fixture: Fixture = {
      sourceTableId: cachedSource.id,
      hostTableId: cachedHost.id,
      sourceTableName,
      hostTableName,
      ...fields,
      seedCacheInfo,
      seedCacheHit: true,
      reusable: true,
      seedBuildMs: 0,
      seedBatchMs: 0,
      seedReadyMs: 0,
    };
    try {
      const ready = await measureAsync("seedReady", () =>
        assertFixtureReady(fixture, c),
      );
      fixture.seedReadyMs = ready.durationMs;
      return fixture;
    } catch (error) {
      await permanentDeleteTable(globalThis.testConfig.baseId, cachedHost.id);
      await permanentDeleteTable(globalThis.testConfig.baseId, cachedSource.id);
      console.warn(`Invalid cached conditional query seed; rebuilding`, error);
      return prepareFixture(perfCase, context, c);
    }
  }
  for (const table of [cachedHost, cachedSource])
    if (table)
      await permanentDeleteTable(globalThis.testConfig.baseId, table.id);
  const started = performance.now();
  const source = await createTable(globalThis.testConfig.baseId, {
    name: sourceTableName,
    fields: [
      { name: "A Group", type: FieldType.SingleLineText },
      { name: "A Text", type: FieldType.SingleLineText },
      { name: "A Amount", type: FieldType.Number },
      { name: "A Active", type: FieldType.Checkbox },
    ],
    records: [],
  });
  const host = await createTable(globalThis.testConfig.baseId, {
    name: hostTableName,
    fields: [
      { name: "B Key", type: FieldType.SingleLineText },
      { name: "Lookup Group", type: FieldType.SingleLineText },
    ],
    records: [],
  });
  let maxBatch = 0;
  const seedBatches = async (
    tableId: string,
    rows: Array<{ fields: Record<string, unknown> }>,
  ) => {
    for (const batch of chunk(rows, c.batchSize)) {
      const m = await measureAsync("seedBatch", () =>
        withPerfTraceStep(context, perfCase, "seedBatch", () =>
          createRecords(tableId, {
            fieldKeyType: FieldKeyType.Name,
            records: batch,
          }),
        ),
      );
      maxBatch = Math.max(maxBatch, m.durationMs);
    }
  };
  await seedBatches(source.id, sourceRows(c));
  await seedBatches(host.id, hostRows(c));
  const fixture: Fixture = {
    sourceTableId: source.id,
    hostTableId: host.id,
    sourceTableName,
    hostTableName,
    ...fixtureFields(source.fields, host.fields),
    seedCacheInfo,
    seedCacheHit: false,
    reusable: seedCacheInfo.enabled,
    seedBuildMs: performance.now() - started,
    seedBatchMs: maxBatch,
    seedReadyMs: 0,
  };
  const ready = await measureAsync("seedReady", () =>
    assertFixtureReady(fixture, c),
  );
  fixture.seedReadyMs = ready.durationMs;
  return fixture;
};

const valueField = (f: ConditionalQueryCaseConfig["field"], x: FieldIds) =>
  x[f.valueField];
const retainedValuesPerHost = (c: ConditionalQueryCaseConfig) => {
  const filtered =
    c.field.filter === "group"
      ? rowsPerGroup(c)
      : Math.ceil(rowsPerGroup(c) / 2);
  return c.field.limit == null ? filtered : Math.min(filtered, c.field.limit);
};
const expected = (row: number, c: ConditionalQueryCaseConfig): unknown => {
  const g = groupForHost(row, c);
  const slots = Array.from({ length: rowsPerGroup(c) }, (_, i) => i + 1).filter(
    (s) => c.field.filter === "group" || s % 2 === 1,
  );
  const ordered = c.field.sort?.order === "desc" ? [...slots].reverse() : slots;
  const limited = c.field.limit ? ordered.slice(0, c.field.limit) : ordered;
  if (c.field.kind === "lookup")
    return c.field.valueField === "text"
      ? limited.map((s) => `${c.generator.sourceTextPrefix}-${g}-${s}`)
      : c.field.valueField === "amount"
        ? limited.map((s) => g * 100 + s)
        : limited.map((s) => s % 2 === 1);
  if (c.field.expression === "countall({values})") return limited.length;
  const nums = limited.map((s) => g * 100 + s);
  if (c.field.expression === "sum({values})")
    return nums.reduce((a, b) => a + b, 0);
  if (c.field.expression === "average({values})")
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (c.field.expression === "max({values})") return Math.max(...nums);
  return limited
    .map((s) => `${c.generator.sourceTextPrefix}-${g}-${s}`)
    .join(", ");
};

const runCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const c = perfCase.config as ConditionalQueryCaseConfig;
  const fixture = await prepareFixture(perfCase, context, c);
  const sf = fixture.sourceFields;
  const field = c.field;
  const filterSet: Array<Record<string, unknown>> = [
    {
      fieldId: sf.group,
      operator: "is",
      value: { type: "field", fieldId: fixture.hostFields.group },
    },
  ];
  if (field.filter === "group-and-active")
    filterSet.push({ fieldId: sf.active, operator: "is", value: true });
  const options = {
    foreignTableId: fixture.sourceTableId,
    lookupFieldId: valueField(field, sf),
    filter: { conjunction: "and", filterSet },
    ...(field.sort
      ? {
          sort: {
            fieldId: sf.amount,
            order: field.sort.order === "desc" ? SortFunc.Desc : SortFunc.Asc,
          },
        }
      : {}),
    ...(field.limit ? { limit: field.limit } : {}),
  };
  const input: IFieldRo =
    field.kind === "lookup"
      ? {
          name: field.name,
          type:
            field.valueField === "amount"
              ? FieldType.Number
              : field.valueField === "active"
                ? FieldType.Checkbox
                : FieldType.SingleLineText,
          isLookup: true,
          isConditionalLookup: true,
          lookupOptions: options,
        }
      : {
          name: field.name,
          type: FieldType.ConditionalRollup,
          options: { ...options, expression: field.expression },
        };
  let createdId = "";
  let routing: EngineRouting | undefined;
  try {
    const create = await withPerfTraceStep(
      context,
      perfCase,
      "createConditionalField",
      () =>
        measureAsync("createConditionalField", async () => {
          const response = await apiCreateField(fixture.hostTableId, input);
          expect(response.status).toBe(201);
          createdId = response.data.id;
          routing = assertEngineRouting(
            context,
            pickRoutingResponseHeaders(
              response.headers as Record<string, unknown>,
            ),
            {
              feature: "createField",
              operation: "Conditional query field create",
            },
          );
        }),
    );
    const ready = await measureAsync("fullConditionalQueryScanReady", () =>
      pollUntilReady(
        {
          timeoutMs: c.verify.timeoutMs ?? 120_000,
          pollIntervalMs: c.verify.pollIntervalMs ?? 500,
          description: "conditional query full scan",
        },
        async () => {
          const seen = new Set<number>();
          const pageSize = c.verify.fullScanPageSize ?? 1_000;
          const scan = await forEachRecordPage(
            {
              totalRows: c.hostRecordCount,
              pageSize,
              fetchPage: (skip, take) =>
                getRecords(fixture.hostTableId, {
                  fieldKeyType: FieldKeyType.Id,
                  projection: [fixture.hostFields.key, createdId],
                  skip,
                  take,
                }),
            },
            (record) => {
              const row = Number(
                String(record.fields[fixture.hostFields.key]).slice(
                  `${c.generator.hostKeyPrefix}-`.length,
                ),
              );
              seen.add(row);
              expect(record.fields[createdId]).toEqual(expected(row, c));
            },
          );
          if (seen.size !== c.hostRecordCount)
            throw new Error(
              `Expected ${c.hostRecordCount} rows, got ${seen.size}`,
            );
          return scan;
        },
      ),
    );
    const primary = roundMetric(create.durationMs + ready.durationMs);
    return {
      result: "pass",
      metrics: {
        seedCacheHit: fixture.seedCacheHit ? 1 : 0,
        seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
        ...(fixture.seedCacheHit ? { seedRestoreMs: 0 } : {}),
        seedBuildMs: roundMetric(fixture.seedBuildMs),
        maxSeedBatchMs: roundMetric(fixture.seedBatchMs),
        seedReadyMs: roundMetric(fixture.seedReadyMs),
        createConditionalFieldMs: create.durationMs,
        fullConditionalQueryScanReadyMs: ready.durationMs,
        conditionalQueryReadyMs: primary,
      },
      thresholds: [
        {
          metric: c.threshold.metric,
          max: getPrimaryThresholdMs(c.threshold.maxMs),
          unit: "ms",
        },
      ],
      phases: [
        { name: create.name, durationMs: create.durationMs },
        { name: ready.name, durationMs: ready.durationMs },
      ],
      details: {
        seed: {
          enabled: fixture.seedCacheInfo.enabled,
          seedHash: fixture.seedCacheInfo.seedHash,
          seedHashShort: fixture.seedCacheInfo.seedHashShort,
          seedNamePrefix: fixture.seedCacheInfo.seedNamePrefix,
          sourceTableName: fixture.sourceTableName,
          hostTableName: fixture.hostTableName,
          cacheHit: fixture.seedCacheHit,
          reusable: fixture.reusable,
          schemaSignature: fixture.seedCacheInfo.schemaSignature,
        },
        sourceTableId: fixture.sourceTableId,
        hostTableId: fixture.hostTableId,
        sourceRecordCount: c.sourceRecordCount,
        hostRecordCount: c.hostRecordCount,
        groupCount: c.groupCount,
        fanout: rowsPerGroup(c),
        groupMatchesPerHost: rowsPerGroup(c),
        retainedValuesPerHost: retainedValuesPerHost(c),
        groupMatchPairCount: c.hostRecordCount * rowsPerGroup(c),
        retainedValueCount: c.hostRecordCount * retainedValuesPerHost(c),
        field,
        fieldId: createdId,
        routing,
        fullScan: {
          scannedRecords: ready.result.scannedRecords,
          pageCount: ready.result.pageCount,
        },
      },
    };
  } finally {
    if (!isExecuteDbIsolated()) {
      if (createdId) await deleteField(fixture.hostTableId, createdId);
      if (!fixture.reusable) {
        await permanentDeleteTable(
          globalThis.testConfig.baseId,
          fixture.hostTableId,
        );
        await permanentDeleteTable(
          globalThis.testConfig.baseId,
          fixture.sourceTableId,
        );
      }
    }
  }
};

export const seedConditionalQueryCase = (
  perfCase: PerfCase,
  context: PerfRunContext,
) =>
  prepareFixture(
    perfCase,
    context,
    perfCase.config as ConditionalQueryCaseConfig,
  ).then(
    (f) =>
      ({
        result: "pass",
        metrics: { seedCacheHit: f.seedCacheHit ? 1 : 0 },
        thresholds: [],
        details: {
          sourceTableId: f.sourceTableId,
          hostTableId: f.hostTableId,
          seed: {
            seedHash: f.seedCacheInfo.seedHash,
            seedHashShort: f.seedCacheInfo.seedHashShort,
            cacheHit: f.seedCacheHit,
          },
        },
      }) as PerfRunResult,
  );
export const runConditionalQueryCase = runCase;
