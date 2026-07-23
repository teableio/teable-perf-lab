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
  PerfCase,
  PerfCaseFor,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  runFieldAddLifecycle,
  type FieldAddLifecycleSpec,
} from "./field-add-lifecycle";
import {
  runRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";
import {
  CONDITIONAL_QUERY_HOST_FIELDS,
  CONDITIONAL_QUERY_SOURCE_FIELDS,
  createConditionalQueryWorkload,
  type ConditionalQueryMutationTarget,
  type ConditionalQueryPropagationCaseConfig,
  type ConditionalQuerySourceFieldIds,
  type ConditionalQueryValuePhase,
  type ConditionalQueryWorkload,
} from "./conditional-query-workload";

const FIXTURE_VERSION = "conditional-query-grouped-v1";
const SHARED_SEED_ID = "conditional-query/grouped-fanout-shared";

type FieldIds = ConditionalQuerySourceFieldIds;
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
  workload: ConditionalQueryWorkload;
};

const resolveFields = (fields: Array<{ id: string; name: string }>) =>
  new Map(fields.map((f) => [f.name, f.id]));
const fixtureFields = (
  source: Array<{ id: string; name: string }>,
  host: Array<{ id: string; name: string }>,
) => {
  const s = resolveFields(source);
  const h = resolveFields(host);
  for (const name of [
    ...CONDITIONAL_QUERY_SOURCE_FIELDS,
    ...CONDITIONAL_QUERY_HOST_FIELDS,
  ])
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
  const expectedSourceFirst = fixture.workload.sourceRow(1).fields;
  if (
    sourceFirst.fields[fixture.sourceFields.group] !==
      expectedSourceFirst["A Group"] ||
    sourceFirst.fields[fixture.sourceFields.text] !==
      expectedSourceFirst["A Text"] ||
    sourceFirst.fields[fixture.sourceFields.amount] !==
      expectedSourceFirst["A Amount"] ||
    sourceFirst.fields[fixture.sourceFields.active] !==
      expectedSourceFirst["A Active"]
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
    const expectedHost = fixture.workload.hostRow(row).fields;
    if (
      !record ||
      record.fields[fixture.hostFields.key] !== expectedHost["B Key"] ||
      record.fields[fixture.hostFields.group] !== expectedHost["Lookup Group"]
    )
      throw new Error(`Conditional query host seed mismatch at row ${row}`);
  }
};

const prepareFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  c: ConditionalQueryCaseConfig,
  uncachedSourceTableName?: string,
): Promise<Fixture> => {
  const workload = createConditionalQueryWorkload(c);
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
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("./conditional-query-workload.ts", import.meta.url),
    ],
  });
  const timestamp = Date.now();
  const expectedSourcePrefix = `${c.sourceTableNamePrefix}-`;
  if (
    uncachedSourceTableName != null &&
    !uncachedSourceTableName.startsWith(expectedSourcePrefix)
  ) {
    throw new Error(
      `Conditional query source table name must start with ${expectedSourcePrefix}`,
    );
  }
  const uncachedNameSuffix =
    uncachedSourceTableName?.slice(expectedSourcePrefix.length) ??
    String(timestamp);
  const sourceTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "source")
    : (uncachedSourceTableName ??
      `${c.sourceTableNamePrefix}-${uncachedNameSuffix}`);
  const hostTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "host")
    : `${c.hostTableNamePrefix}-${uncachedNameSuffix}`;
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
      if (
        !CONDITIONAL_QUERY_HOST_FIELDS.includes(
          field.name as (typeof CONDITIONAL_QUERY_HOST_FIELDS)[number],
        )
      )
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
      workload,
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
        createRecords(tableId, {
          fieldKeyType: FieldKeyType.Name,
          records: batch,
        }),
      );
      maxBatch = Math.max(maxBatch, m.durationMs);
    }
  };
  await seedBatches(source.id, workload.sourceRows());
  await seedBatches(host.id, workload.hostRows());
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
    workload,
  };
  const ready = await measureAsync("seedReady", () =>
    assertFixtureReady(fixture, c),
  );
  fixture.seedReadyMs = ready.durationMs;
  return fixture;
};

const valueField = (f: ConditionalQueryCaseConfig["field"], x: FieldIds) =>
  x[f.valueField];

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
) => {
  const createMeasurement = () =>
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
    });
  return stepName === "createConditionalField"
    ? withPerfTraceStep(context, perfCase, stepName, createMeasurement)
    : createMeasurement();
};

const scanConditionalResults = (
  fixture: Fixture,
  c: ConditionalQueryCaseConfig,
  fieldId: string,
  phase: ConditionalQueryValuePhase,
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
          expect(record.fields[fieldId]).toEqual(
            fixture.workload.expectedValue(row, phase),
          );
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
): Promise<ConditionalQueryMutationTarget[]> => {
  const mutation = fixture.workload.mutation;
  if (!mutation) {
    throw new Error("Conditional query mutation workload is missing");
  }
  const targets: ConditionalQueryMutationTarget[] = [];
  await forEachRecordPage(
    {
      totalRows: mutation.scanRows,
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
      const position = fixture.workload.sourcePosition(rowNumber);
      expect(record.fields[fixture.sourceFields.group]).toBe(
        fixture.workload.sourceRow(rowNumber).fields["A Group"],
      );
      if (position.mutationTarget) {
        targets.push({ recordId: record.id, ...position });
      }
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
  const mutation = fixture.workload.mutation;
  if (!mutation) {
    throw new Error("Conditional query mutation workload is missing");
  }
  const mutationFieldId =
    c.mutation.kind === "text-update"
      ? fixture.sourceFields.text
      : c.mutation.kind === "amount-update"
        ? fixture.sourceFields.amount
        : fixture.sourceFields.active;
  let restoredTargets = 0;
  await forEachRecordPage(
    {
      totalRows: mutation.scanRows,
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
      const position = fixture.workload.sourcePosition(rowNumber);
      if (!position.mutationTarget) return;
      const target = { recordId: record.id, ...position };
      const expectedFields = mutation.fields(
        fixture.sourceFields,
        target,
        "seed",
      );
      expect(record.fields[fixture.sourceFields.group]).toBe(
        fixture.workload.sourceRow(rowNumber).fields["A Group"],
      );
      expect(record.fields[mutationFieldId]).toEqual(
        expectedFields[mutationFieldId],
      );
      restoredTargets += 1;
    },
  );
  expect(restoredTargets).toBe(c.mutation.recordCount);
};

const updatedRecordCount = (data: unknown) =>
  Array.isArray(data)
    ? data.length
    : ((data as { records?: unknown[] } | undefined)?.records?.length ?? 0);

const applyMutation = async (
  fixture: Fixture,
  _c: ConditionalQueryPropagationCaseConfig,
  targets: ConditionalQueryMutationTarget[],
  phase: ConditionalQueryValuePhase,
  context?: PerfRunContext,
) => {
  const mutation = fixture.workload.mutation;
  if (!mutation) {
    throw new Error("Conditional query mutation workload is missing");
  }
  const response = await updateRecords(fixture.sourceTableId, {
    fieldKeyType: FieldKeyType.Id,
    typecast: false,
    records: targets.map((target) => ({
      id: target.recordId,
      fields: mutation.fields(fixture.sourceFields, target, phase),
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

type ConditionalFieldCreationMeasurement = Awaited<
  ReturnType<typeof createConditionalField>
>;
type ConditionalScanMeasurement = Measurement<
  Awaited<ReturnType<typeof scanConditionalResults>>
>;
type ConditionalCreateRun = {
  fixture: Fixture;
  createdFieldId: string;
  create?: ConditionalFieldCreationMeasurement;
  ready?: ConditionalScanMeasurement;
};
type ConditionalCreatePrimary = {
  create: ConditionalFieldCreationMeasurement;
  ready: ConditionalScanMeasurement;
};

const seedMetrics = (fixture: Fixture) => ({
  seedCacheHit: fixture.seedCacheHit ? 1 : 0,
  seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
  ...(fixture.seedCacheHit ? { seedRestoreMs: 0 } : {}),
  seedBuildMs: roundMetric(fixture.seedBuildMs),
  maxSeedBatchMs: roundMetric(fixture.seedBatchMs),
  seedReadyMs: roundMetric(fixture.seedReadyMs),
});

const seedDetails = (fixture: Fixture) => ({
  enabled: fixture.seedCacheInfo.enabled,
  seedHash: fixture.seedCacheInfo.seedHash,
  seedHashShort: fixture.seedCacheInfo.seedHashShort,
  seedNamePrefix: fixture.seedCacheInfo.seedNamePrefix,
  sourceTableName: fixture.sourceTableName,
  hostTableName: fixture.hostTableName,
  cacheHit: fixture.seedCacheHit,
  reusable: fixture.reusable,
  schemaSignature: fixture.seedCacheInfo.schemaSignature,
});

const errorDetails = (error: unknown) =>
  error instanceof Error
    ? { error: { name: error.name, message: error.message } }
    : {};

const buildCreateResult = (
  c: ConditionalQueryCaseConfig,
  run: ConditionalCreateRun | undefined,
  error?: unknown,
): PerfRunResult => {
  const thresholds = [
    {
      metric: c.threshold.metric,
      max: getPrimaryThresholdMs(c.threshold.maxMs),
      unit: "ms",
    },
  ];
  if (!run) {
    return { metrics: {}, thresholds, details: errorDetails(error) };
  }
  const { fixture, create, ready } = run;
  const shape = fixture.workload.shape("seed");
  const primary =
    create && ready
      ? roundMetric(create.durationMs + ready.durationMs)
      : undefined;
  return {
    ...(!error && primary != null ? { result: "pass" as const } : {}),
    metrics: {
      ...seedMetrics(fixture),
      ...(create ? { createConditionalFieldMs: create.durationMs } : {}),
      ...(ready ? { fullConditionalQueryScanReadyMs: ready.durationMs } : {}),
      ...(primary != null ? { conditionalQueryReadyMs: primary } : {}),
    },
    thresholds,
    phases: [
      ...(create ? [{ name: create.name, durationMs: create.durationMs }] : []),
      ...(ready ? [{ name: ready.name, durationMs: ready.durationMs }] : []),
    ],
    details: {
      seed: seedDetails(fixture),
      sourceTableId: fixture.sourceTableId,
      hostTableId: fixture.hostTableId,
      sourceRecordCount: c.sourceRecordCount,
      hostRecordCount: c.hostRecordCount,
      groupCount: c.groupCount,
      ...shape,
      field: c.field,
      fieldId: run.createdFieldId,
      routing: create?.result.routing,
      fullScan: ready
        ? {
            scannedRecords: ready.result.scannedRecords,
            pageCount: ready.result.pageCount,
          }
        : undefined,
      ...errorDetails(error),
    },
  };
};

// Adapter over the field-add lifecycle. prepareFixture already performs and
// records the expensive seed-ready scan (including invalid-cache rebuild), so
// assertSeedReady only checks that prepared invariant instead of scanning twice.
const conditionalQueryCreateSpec: FieldAddLifecycleSpec<
  ConditionalQueryCaseConfig,
  ConditionalCreateRun,
  number,
  ConditionalCreatePrimary
> = {
  prepareFixture: async ({ perfCase, context, config }) => ({
    fixture: await prepareFixture(perfCase, context, config),
    createdFieldId: "",
  }),
  assertSeedReady: async ({ fixture }) => {
    if (!Number.isFinite(fixture.fixture.seedReadyMs)) {
      throw new Error("Conditional query seed readiness was not measured");
    }
    return fixture.fixture.seedReadyMs;
  },
  runPrimary: async ({ perfCase, context, fixture: run, config }) => {
    const create = await createConditionalField(
      perfCase,
      context,
      run.fixture,
      config,
      "createConditionalField",
    );
    run.create = create;
    run.createdFieldId = create.result.fieldId;
    const ready = await measureAsync("fullConditionalQueryScanReady", () =>
      scanConditionalResults(
        run.fixture,
        config,
        run.createdFieldId,
        "seed",
        "conditional query full scan",
      ),
    );
    run.ready = ready;
    return { create, ready };
  },
  buildResult: ({ config, fixture, error }) =>
    buildCreateResult(config, fixture, error),
  cleanup: async ({ baseId, fixture: run }) => {
    if (!run || isExecuteDbIsolated()) return;
    if (run.createdFieldId) {
      await deleteField(run.fixture.hostTableId, run.createdFieldId);
    }
    if (!run.fixture.reusable) {
      await permanentDeleteTable(baseId, run.fixture.hostTableId);
      await permanentDeleteTable(baseId, run.fixture.sourceTableId);
    }
  },
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

type ConditionalMutationMeasurement = Measurement<
  Awaited<ReturnType<typeof applyMutation>>
>;
type ConditionalTargetMeasurement = Measurement<
  ConditionalQueryMutationTarget[]
>;
type ConditionalPropagationRun = {
  fixture: Fixture;
  createdFieldId: string;
  targets: ConditionalQueryMutationTarget[];
  setup?: ConditionalFieldCreationMeasurement;
  initialReady?: ConditionalScanMeasurement;
  prepareMutation?: ConditionalTargetMeasurement;
  update?: ConditionalMutationMeasurement;
  propagationReady?: ConditionalScanMeasurement;
};
type ConditionalPropagationPrimary = {
  setup: ConditionalFieldCreationMeasurement;
  initialReady: ConditionalScanMeasurement;
  prepareMutation: ConditionalTargetMeasurement;
  update: ConditionalMutationMeasurement;
  propagationReady: ConditionalScanMeasurement;
};
const buildPropagationResult = (
  c: ConditionalQueryPropagationCaseConfig,
  run: ConditionalPropagationRun | undefined,
  error?: unknown,
): PerfRunResult => {
  const thresholds = [
    {
      metric: c.threshold.metric,
      max: getPrimaryThresholdMs(c.threshold.maxMs),
      unit: "ms",
    },
  ];
  if (!run) {
    return { metrics: {}, thresholds, details: errorDetails(error) };
  }
  const {
    fixture,
    setup,
    initialReady,
    prepareMutation,
    update,
    propagationReady,
  } = run;
  const mutation = fixture.workload.mutation;
  if (!mutation) {
    throw new Error("Conditional query mutation workload is missing");
  }
  const before = fixture.workload.shape("seed");
  const after = fixture.workload.shape("mutated");
  const primary =
    update && propagationReady
      ? roundMetric(update.durationMs + propagationReady.durationMs)
      : undefined;
  return {
    ...(!error && primary != null ? { result: "pass" as const } : {}),
    metrics: {
      ...seedMetrics(fixture),
      ...(setup ? { setupConditionalFieldMs: setup.durationMs } : {}),
      ...(initialReady
        ? { initialFullScanReadyMs: initialReady.durationMs }
        : {}),
      ...(prepareMutation
        ? { prepareMutationRecordsMs: prepareMutation.durationMs }
        : {}),
      ...(update ? { sourceUpdateRequestMs: update.durationMs } : {}),
      ...(propagationReady
        ? { propagationFullScanReadyMs: propagationReady.durationMs }
        : {}),
      ...(primary != null
        ? { conditionalQueryPropagationReadyMs: primary }
        : {}),
    },
    thresholds,
    phases: [
      ...(setup ? [{ name: setup.name, durationMs: setup.durationMs }] : []),
      ...(initialReady
        ? [{ name: initialReady.name, durationMs: initialReady.durationMs }]
        : []),
      ...(prepareMutation
        ? [
            {
              name: prepareMutation.name,
              durationMs: prepareMutation.durationMs,
            },
          ]
        : []),
      ...(update ? [{ name: update.name, durationMs: update.durationMs }] : []),
      ...(propagationReady
        ? [
            {
              name: propagationReady.name,
              durationMs: propagationReady.durationMs,
            },
          ]
        : []),
    ],
    details: {
      seed: seedDetails(fixture),
      sourceTableId: fixture.sourceTableId,
      hostTableId: fixture.hostTableId,
      sourceRecordCount: c.sourceRecordCount,
      hostRecordCount: c.hostRecordCount,
      groupCount: c.groupCount,
      fanout: before.fanout,
      groupMatchesPerHost: before.groupMatchesPerHost,
      retainedValuesPerHostBefore: before.retainedValuesPerHost,
      retainedValuesPerHostAfter: after.retainedValuesPerHost,
      groupMatchPairCount: before.groupMatchPairCount,
      mutation: {
        ...c.mutation,
        recordsPerGroup: mutation.recordsPerGroup,
        affectedGroupCount: c.groupCount,
        affectedHostRecordCount: c.hostRecordCount,
        changedInputValueCount: c.mutation.recordCount,
        affectedMatchContributionCount:
          c.hostRecordCount * mutation.recordsPerGroup,
        updateRequestCount: update?.result.batchCount,
        requestedRecords: update?.result.requestedRecords,
        updatedRecords: update?.result.updatedRecords,
      },
      request: {
        method: "PATCH",
        path: `/api/table/${fixture.sourceTableId}/record`,
        fieldKeyType: "id",
        typecast: false,
        recordCount: c.mutation.recordCount,
        requestCount: update?.result.batchCount,
      },
      field: c.field,
      fieldId: run.createdFieldId,
      setupRouting: setup?.result.routing,
      routing: update?.result.routing,
      initialFullScan: initialReady
        ? {
            scannedRecords: initialReady.result.scannedRecords,
            pageCount: initialReady.result.pageCount,
          }
        : undefined,
      fullScan: propagationReady
        ? {
            scannedRecords: propagationReady.result.scannedRecords,
            pageCount: propagationReady.result.pageCount,
          }
        : undefined,
      ...errorDetails(error),
    },
  };
};

// Adapter over the record-mutation lifecycle. The driver owns diagnostic
// wrapping and guaranteed cleanup; this state retains each completed workload
// phase so a mid-run error still produces an evidence-rich artifact.
const conditionalQueryPropagationSpec: RecordMutationLifecycleSpec<
  ConditionalQueryPropagationCaseConfig,
  ConditionalPropagationRun,
  never,
  ConditionalPropagationPrimary
> = {
  resolveTableNamePrefix: (config) => config.sourceTableNamePrefix,
  prepareFixture: async ({ perfCase, context, config, tableName }) => ({
    fixture: await prepareFixture(perfCase, context, config, tableName),
    createdFieldId: "",
    targets: [],
  }),
  runMeasuredOperation: async ({ perfCase, context, config, fixture: run }) => {
    const setup = await createConditionalField(
      perfCase,
      context,
      run.fixture,
      config,
      "setupConditionalField",
    );
    run.setup = setup;
    run.createdFieldId = setup.result.fieldId;
    const initialReady = await measureAsync("initialFullScanReady", () =>
      scanConditionalResults(
        run.fixture,
        config,
        run.createdFieldId,
        "seed",
        "initial conditional query full scan",
      ),
    );
    run.initialReady = initialReady;
    const prepareMutation = await measureAsync("prepareMutationRecords", () =>
      collectMutationTargets(run.fixture, config),
    );
    run.prepareMutation = prepareMutation;
    run.targets = prepareMutation.result;
    const update = await withPerfTraceStep(
      context,
      perfCase,
      "updateConditionalSourceRecords",
      () =>
        measureAsync("updateConditionalSourceRecords", () =>
          applyMutation(run.fixture, config, run.targets, "mutated", context),
        ),
    );
    run.update = update;
    if (!update.result.routing) {
      throw new Error("Conditional query mutation routing was not captured");
    }
    const propagationReady = await measureAsync(
      "propagationFullScanReady",
      () =>
        scanConditionalResults(
          run.fixture,
          config,
          run.createdFieldId,
          "mutated",
          "conditional query propagation full scan",
        ),
    );
    run.propagationReady = propagationReady;
    const result = {
      setup,
      initialReady,
      prepareMutation,
      update,
      propagationReady,
    };
    return {
      name: config.threshold.metric,
      durationMs: roundMetric(update.durationMs + propagationReady.durationMs),
      result,
    };
  },
  buildResult: ({ config, fixture, error }) =>
    buildPropagationResult(config, fixture, error),
  cleanup: async ({ fixture: run, config }) => {
    if (!run) return;
    if (run.createdFieldId) {
      try {
        await deleteField(run.fixture.hostTableId, run.createdFieldId);
      } catch (error) {
        console.warn(
          `Failed to delete propagation field ${run.createdFieldId} during cleanup`,
          error,
        );
      }
    }
    if (run.targets.length) {
      try {
        await applyMutation(run.fixture, config, run.targets, "seed");
        await assertMutationTargetsRestored(run.fixture, config);
      } catch (error) {
        console.warn(
          "Failed to restore conditional query mutation seed; discarding fixture",
          error,
        );
        await deleteFixtureTables(run.fixture);
      }
    }
  },
};

const runCase = async (
  perfCase: PerfCaseFor<"conditional-query">,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const c = perfCase.config;
  if (!c.mutation) {
    return runFieldAddLifecycle(perfCase, context, conditionalQueryCreateSpec);
  }
  return runRecordMutationLifecycle(
    perfCase,
    context,
    conditionalQueryPropagationSpec,
  );
};

export const seedConditionalQueryCase = (
  perfCase: PerfCaseFor<"conditional-query">,
  context: PerfRunContext,
) =>
  prepareFixture(perfCase, context, perfCase.config).then(
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
