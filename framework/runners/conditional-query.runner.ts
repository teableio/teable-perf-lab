import { FieldKeyType, FieldType, SortFunc, type IFieldRo } from "@teable/core";
import { createField as apiCreateField, updateRecords } from "@teable/openapi";
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
  ConditionalQueryMutationConfig,
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
  if (!c.mutation) return;
  if (
    !Number.isInteger(c.mutation.recordCount) ||
    c.mutation.recordCount <= 0 ||
    c.mutation.recordCount % c.groupCount !== 0
  ) {
    throw new Error(
      "Conditional query mutation recordCount must be a positive multiple of groupCount",
    );
  }
  const slotsPerGroup = c.mutation.recordCount / c.groupCount;
  const activeSlotsPerGroup = Math.ceil(rowsPerGroup(c) / 2);
  if (c.mutation.kind === "text-update" && slotsPerGroup > rowsPerGroup(c)) {
    throw new Error("Text mutation exceeds the available rows per group");
  }
  if (
    c.mutation.kind !== "text-update" &&
    slotsPerGroup > activeSlotsPerGroup
  ) {
    throw new Error("Active-row mutation exceeds the active rows per group");
  }
  if (
    c.mutation.kind === "text-update" &&
    !(c.field.kind === "lookup" && c.field.valueField === "text")
  ) {
    throw new Error("Text mutation requires a text lookup field");
  }
  if (
    c.mutation.kind === "amount-update" &&
    !(
      c.field.kind === "rollup" &&
      c.field.valueField === "amount" &&
      !c.field.sort
    )
  ) {
    throw new Error("Amount mutation requires an unsorted amount rollup field");
  }
  if (
    c.mutation.kind === "active-flip" &&
    !(
      c.field.kind === "lookup" &&
      c.field.valueField === "text" &&
      c.field.filter === "group-and-active"
    )
  ) {
    throw new Error(
      "Active mutation requires an active-filtered text lookup field",
    );
  }
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

type ConditionalValuePhase = "seed" | "mutated";
type ConditionalQueryPropagationCaseConfig = Extract<
  ConditionalQueryCaseConfig,
  { mutation: ConditionalQueryMutationConfig }
>;
type MutationTarget = {
  recordId: string;
  group: number;
  slot: number;
};

const mutationSlotsPerGroup = (c: ConditionalQueryCaseConfig) =>
  c.mutation ? c.mutation.recordCount / c.groupCount : 0;

const isMutationTargetSlot = (slot: number, c: ConditionalQueryCaseConfig) => {
  if (!c.mutation) return false;
  const slots = mutationSlotsPerGroup(c);
  return c.mutation.kind === "text-update"
    ? slot <= slots
    : slot % 2 === 1 && slot <= slots * 2 - 1;
};

const isActiveSlot = (
  slot: number,
  c: ConditionalQueryCaseConfig,
  phase: ConditionalValuePhase,
) =>
  slot % 2 === 1 &&
  !(
    phase === "mutated" &&
    c.mutation?.kind === "active-flip" &&
    isMutationTargetSlot(slot, c)
  );

const textValue = (
  group: number,
  slot: number,
  c: ConditionalQueryCaseConfig,
  phase: ConditionalValuePhase,
) => {
  const base = `${c.generator.sourceTextPrefix}-${group}-${slot}`;
  return phase === "mutated" &&
    c.mutation?.kind === "text-update" &&
    isMutationTargetSlot(slot, c)
    ? `${base}-${c.mutation.updatedSuffix}`
    : base;
};

const amountValue = (
  group: number,
  slot: number,
  c: ConditionalQueryCaseConfig,
  phase: ConditionalValuePhase,
) =>
  group * 100 +
  slot +
  (phase === "mutated" &&
  c.mutation?.kind === "amount-update" &&
  isMutationTargetSlot(slot, c)
    ? c.mutation.amountDelta
    : 0);

const retainedValuesPerHost = (
  c: ConditionalQueryCaseConfig,
  phase: ConditionalValuePhase,
) => {
  const filtered = Array.from(
    { length: rowsPerGroup(c) },
    (_, i) => i + 1,
  ).filter(
    (slot) => c.field.filter === "group" || isActiveSlot(slot, c, phase),
  ).length;
  return c.field.limit == null ? filtered : Math.min(filtered, c.field.limit);
};

const expected = (
  row: number,
  c: ConditionalQueryCaseConfig,
  phase: ConditionalValuePhase,
): unknown => {
  const g = groupForHost(row, c);
  const slots = Array.from({ length: rowsPerGroup(c) }, (_, i) => i + 1).filter(
    (s) => c.field.filter === "group" || isActiveSlot(s, c, phase),
  );
  const ordered = c.field.sort?.order === "desc" ? [...slots].reverse() : slots;
  const limited = c.field.limit ? ordered.slice(0, c.field.limit) : ordered;
  if (c.field.kind === "lookup")
    return c.field.valueField === "text"
      ? limited.map((s) => textValue(g, s, c, phase))
      : c.field.valueField === "amount"
        ? limited.map((s) => amountValue(g, s, c, phase))
        : limited.map((s) => isActiveSlot(s, c, phase));
  if (c.field.expression === "countall({values})") return limited.length;
  const nums = limited.map((s) => amountValue(g, s, c, phase));
  if (c.field.expression === "sum({values})")
    return nums.reduce((a, b) => a + b, 0);
  if (c.field.expression === "average({values})")
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (c.field.expression === "max({values})") return Math.max(...nums);
  return limited.map((s) => textValue(g, s, c, phase)).join(", ");
};

const buildConditionalFieldInput = (
  fixture: Fixture,
  c: ConditionalQueryCaseConfig,
): IFieldRo => {
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
  return field.kind === "lookup"
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
};

const createConditionalField = (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: Fixture,
  c: ConditionalQueryCaseConfig,
  stepName: "createConditionalField" | "setupConditionalField",
) =>
  withPerfTraceStep(context, perfCase, stepName, () =>
    measureAsync(stepName, async () => {
      const response = await apiCreateField(
        fixture.hostTableId,
        buildConditionalFieldInput(fixture, c),
      );
      expect(response.status).toBe(201);
      return {
        fieldId: response.data.id,
        routing: assertEngineRouting(
          context,
          pickRoutingResponseHeaders(
            response.headers as Record<string, unknown>,
          ),
          {
            feature: "createField",
            operation: "Conditional query field create",
          },
        ),
      };
    }),
  );

const scanConditionalResults = (
  fixture: Fixture,
  c: ConditionalQueryCaseConfig,
  fieldId: string,
  phase: ConditionalValuePhase,
  description: string,
) =>
  pollUntilReady(
    {
      timeoutMs: c.verify.timeoutMs ?? 120_000,
      pollIntervalMs: c.verify.pollIntervalMs ?? 500,
      description,
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
              projection: [fixture.hostFields.key, fieldId],
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
          expect(record.fields[fieldId]).toEqual(expected(row, c, phase));
        },
      );
      if (seen.size !== c.hostRecordCount)
        throw new Error(`Expected ${c.hostRecordCount} rows, got ${seen.size}`);
      return scan;
    },
  );

const collectMutationTargets = async (
  fixture: Fixture,
  c: ConditionalQueryPropagationCaseConfig,
): Promise<MutationTarget[]> => {
  const slotsPerGroup = mutationSlotsPerGroup(c);
  const lastTargetSlot =
    c.mutation.kind === "text-update" ? slotsPerGroup : slotsPerGroup * 2 - 1;
  const scanRows = lastTargetSlot * c.groupCount;
  const targets: MutationTarget[] = [];
  await forEachRecordPage(
    {
      totalRows: scanRows,
      pageSize: c.batchSize,
      fetchPage: (skip, take) =>
        getRecords(fixture.sourceTableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: [fixture.sourceFields.group],
          skip,
          take,
        }),
    },
    (record, rowNumber) => {
      const group = ((rowNumber - 1) % c.groupCount) + 1;
      const slot = Math.floor((rowNumber - 1) / c.groupCount) + 1;
      expect(record.fields[fixture.sourceFields.group]).toBe(
        groupKey(group, c),
      );
      if (isMutationTargetSlot(slot, c))
        targets.push({ recordId: record.id, group, slot });
    },
  );
  if (targets.length !== c.mutation.recordCount)
    throw new Error(
      `Expected ${c.mutation.recordCount} mutation targets, got ${targets.length}`,
    );
  return targets;
};

const assertMutationTargetsRestored = async (
  fixture: Fixture,
  c: ConditionalQueryPropagationCaseConfig,
) => {
  const slotsPerGroup = mutationSlotsPerGroup(c);
  const lastTargetSlot =
    c.mutation.kind === "text-update" ? slotsPerGroup : slotsPerGroup * 2 - 1;
  const mutationFieldId =
    c.mutation.kind === "text-update"
      ? fixture.sourceFields.text
      : c.mutation.kind === "amount-update"
        ? fixture.sourceFields.amount
        : fixture.sourceFields.active;
  let restoredTargets = 0;
  await forEachRecordPage(
    {
      totalRows: lastTargetSlot * c.groupCount,
      pageSize: c.batchSize,
      fetchPage: (skip, take) =>
        getRecords(fixture.sourceTableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: [fixture.sourceFields.group, mutationFieldId],
          skip,
          take,
        }),
    },
    (record, rowNumber) => {
      const group = ((rowNumber - 1) % c.groupCount) + 1;
      const slot = Math.floor((rowNumber - 1) / c.groupCount) + 1;
      if (!isMutationTargetSlot(slot, c)) return;
      const target = { recordId: record.id, group, slot };
      const expectedFields = mutationFields(fixture, c, target, "seed");
      expect(record.fields[fixture.sourceFields.group]).toBe(
        groupKey(group, c),
      );
      expect(record.fields[mutationFieldId]).toEqual(
        expectedFields[mutationFieldId],
      );
      restoredTargets += 1;
    },
  );
  expect(restoredTargets).toBe(c.mutation.recordCount);
};

const mutationFields = (
  fixture: Fixture,
  c: ConditionalQueryPropagationCaseConfig,
  target: MutationTarget,
  phase: ConditionalValuePhase,
) => {
  switch (c.mutation.kind) {
    case "text-update":
      return {
        [fixture.sourceFields.text]: textValue(
          target.group,
          target.slot,
          c,
          phase,
        ),
      };
    case "amount-update":
      return {
        [fixture.sourceFields.amount]: amountValue(
          target.group,
          target.slot,
          c,
          phase,
        ),
      };
    case "active-flip":
      return {
        [fixture.sourceFields.active]: isActiveSlot(target.slot, c, phase),
      };
  }
};

const updatedRecordCount = (data: unknown) =>
  Array.isArray(data)
    ? data.length
    : ((data as { records?: unknown[] } | undefined)?.records?.length ?? 0);

const applyMutation = async (
  fixture: Fixture,
  c: ConditionalQueryPropagationCaseConfig,
  targets: MutationTarget[],
  phase: ConditionalValuePhase,
  context?: PerfRunContext,
) => {
  const response = await updateRecords(fixture.sourceTableId, {
    fieldKeyType: FieldKeyType.Id,
    typecast: false,
    records: targets.map((target) => ({
      id: target.recordId,
      fields: mutationFields(fixture, c, target, phase),
    })),
  });
  const updatedRecords = updatedRecordCount(response.data as unknown);
  expect(response.status).toBe(200);
  expect(updatedRecords).toBe(targets.length);
  const routing = context
    ? assertEngineRouting(
        context,
        pickRoutingResponseHeaders(response.headers as Record<string, unknown>),
        {
          feature: "updateRecords",
          operation: "Conditional query source record update",
        },
      )
    : undefined;
  return {
    requestedRecords: targets.length,
    updatedRecords,
    batchCount: 1,
    routing,
  };
};

const runCreateCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  c: ConditionalQueryCaseConfig,
  fixture: Fixture,
): Promise<PerfRunResult> => {
  let createdId = "";
  try {
    const create = await createConditionalField(
      perfCase,
      context,
      fixture,
      c,
      "createConditionalField",
    );
    createdId = create.result.fieldId;
    const ready = await measureAsync("fullConditionalQueryScanReady", () =>
      scanConditionalResults(
        fixture,
        c,
        createdId,
        "seed",
        "conditional query full scan",
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
        retainedValuesPerHost: retainedValuesPerHost(c, "seed"),
        groupMatchPairCount: c.hostRecordCount * rowsPerGroup(c),
        retainedValueCount:
          c.hostRecordCount * retainedValuesPerHost(c, "seed"),
        field: c.field,
        fieldId: createdId,
        routing: create.result.routing,
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

const deleteFixtureTables = async (fixture: Fixture) => {
  for (const tableId of [fixture.hostTableId, fixture.sourceTableId]) {
    try {
      await permanentDeleteTable(globalThis.testConfig.baseId, tableId);
    } catch (error) {
      console.warn(
        `Failed to discard conditional query table ${tableId}`,
        error,
      );
    }
  }
};

const runPropagationCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  c: ConditionalQueryPropagationCaseConfig,
  fixture: Fixture,
): Promise<PerfRunResult> => {
  let createdId = "";
  let targets: MutationTarget[] = [];
  try {
    const setup = await createConditionalField(
      perfCase,
      context,
      fixture,
      c,
      "setupConditionalField",
    );
    createdId = setup.result.fieldId;
    const initialReady = await measureAsync("initialFullScanReady", () =>
      scanConditionalResults(
        fixture,
        c,
        createdId,
        "seed",
        "initial conditional query full scan",
      ),
    );
    const prepareMutation = await measureAsync("prepareMutationRecords", () =>
      collectMutationTargets(fixture, c),
    );
    targets = prepareMutation.result;
    const update = await withPerfTraceStep(
      context,
      perfCase,
      "updateConditionalSourceRecords",
      () =>
        measureAsync("updateConditionalSourceRecords", () =>
          applyMutation(fixture, c, targets, "mutated", context),
        ),
    );
    if (!update.result.routing)
      throw new Error("Conditional query mutation routing was not captured");
    const propagationReady = await measureAsync(
      "propagationFullScanReady",
      () =>
        scanConditionalResults(
          fixture,
          c,
          createdId,
          "mutated",
          "conditional query propagation full scan",
        ),
    );
    const primary = roundMetric(
      update.durationMs + propagationReady.durationMs,
    );
    const slotsPerGroup = mutationSlotsPerGroup(c);
    return {
      result: "pass",
      metrics: {
        seedCacheHit: fixture.seedCacheHit ? 1 : 0,
        seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
        ...(fixture.seedCacheHit ? { seedRestoreMs: 0 } : {}),
        seedBuildMs: roundMetric(fixture.seedBuildMs),
        maxSeedBatchMs: roundMetric(fixture.seedBatchMs),
        seedReadyMs: roundMetric(fixture.seedReadyMs),
        setupConditionalFieldMs: setup.durationMs,
        initialFullScanReadyMs: initialReady.durationMs,
        prepareMutationRecordsMs: prepareMutation.durationMs,
        sourceUpdateRequestMs: update.durationMs,
        propagationFullScanReadyMs: propagationReady.durationMs,
        conditionalQueryPropagationReadyMs: primary,
      },
      thresholds: [
        {
          metric: c.threshold.metric,
          max: getPrimaryThresholdMs(c.threshold.maxMs),
          unit: "ms",
        },
      ],
      phases: [
        { name: setup.name, durationMs: setup.durationMs },
        { name: initialReady.name, durationMs: initialReady.durationMs },
        { name: prepareMutation.name, durationMs: prepareMutation.durationMs },
        { name: update.name, durationMs: update.durationMs },
        {
          name: propagationReady.name,
          durationMs: propagationReady.durationMs,
        },
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
        retainedValuesPerHostBefore: retainedValuesPerHost(c, "seed"),
        retainedValuesPerHostAfter: retainedValuesPerHost(c, "mutated"),
        groupMatchPairCount: c.hostRecordCount * rowsPerGroup(c),
        mutation: {
          ...c.mutation,
          recordsPerGroup: slotsPerGroup,
          affectedGroupCount: c.groupCount,
          affectedHostRecordCount: c.hostRecordCount,
          changedInputValueCount: c.mutation.recordCount,
          affectedMatchContributionCount: c.hostRecordCount * slotsPerGroup,
          updateRequestCount: update.result.batchCount,
          requestedRecords: update.result.requestedRecords,
          updatedRecords: update.result.updatedRecords,
        },
        request: {
          method: "PATCH",
          path: `/api/table/${fixture.sourceTableId}/record`,
          fieldKeyType: "id",
          typecast: false,
          recordCount: c.mutation.recordCount,
          requestCount: update.result.batchCount,
        },
        field: c.field,
        fieldId: createdId,
        setupRouting: setup.result.routing,
        routing: update.result.routing,
        initialFullScan: {
          scannedRecords: initialReady.result.scannedRecords,
          pageCount: initialReady.result.pageCount,
        },
        fullScan: {
          scannedRecords: propagationReady.result.scannedRecords,
          pageCount: propagationReady.result.pageCount,
        },
      },
    };
  } finally {
    if (createdId) {
      try {
        await deleteField(fixture.hostTableId, createdId);
      } catch (error) {
        console.warn(
          `Failed to delete propagation field ${createdId} during cleanup`,
          error,
        );
      }
    }
    if (targets.length) {
      try {
        await applyMutation(fixture, c, targets, "seed");
        await assertMutationTargetsRestored(fixture, c);
      } catch (error) {
        console.warn(
          "Failed to restore conditional query mutation seed; discarding fixture",
          error,
        );
        await deleteFixtureTables(fixture);
      }
    }
  }
};

const runCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const c = perfCase.config as ConditionalQueryCaseConfig;
  const fixture = await prepareFixture(perfCase, context, c);
  return c.mutation
    ? runPropagationCase(
        perfCase,
        context,
        c as ConditionalQueryPropagationCaseConfig,
        fixture,
      )
    : runCreateCase(perfCase, context, c, fixture);
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
