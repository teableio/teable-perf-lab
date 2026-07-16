import { FieldKeyType, FieldType } from "@teable/core";
import { createField as apiCreateField, updateRecords } from "@teable/openapi";
import {
  createField,
  createRecords,
  createTable,
  deleteField,
  getFields,
  getRecords,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { chunk } from "../chunk";
import {
  ComputedOutboxObserver,
  type ComputedOutboxObserverSummary,
} from "../computed-outbox-observer";
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
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { queryPerfDb } from "../sql";
import { withPerfTraceStep } from "../trace-collector";
import type {
  ComputedOutboxCaseConfig,
  PerfCase,
  PerfCaseFor,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  runFieldAddLifecycle,
  seedFieldAddLifecycle,
  type FieldAddLifecycleSpec,
} from "./field-add-lifecycle";
import {
  runRecordMutationLifecycle,
  seedRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

const FIXTURE_VERSION = "computed-outbox-formula-v1";
const SOURCE_FIELD_NAMES = ["Title", "A"] as const;

type NamedField = { id: string; name: string };
type SourceFields = { Title: NamedField; A: NamedField };
type FormulaField = NamedField & { level: number };
type MutationTarget = { recordId: string; rowNumber: number };
type ScanResult = {
  scannedRecords: number;
  pageCount: number;
  pageSize: number;
  verifiedSamples: Array<{
    rowNumber: number;
    recordId: string;
    sourceValue: number;
    finalFormulaValue?: number;
  }>;
};

type Fixture = {
  tableId: string;
  tableName: string;
  sourceFields: SourceFields;
  formulas: FormulaField[];
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusable: boolean;
  seedBuildMs: number;
  seedRecordsMs: number;
  seedFormulaSetupMs: number;
  seedReadyMs: number;
  mutationTargets: MutationTarget[];
  createdFieldId?: string;
  partial?: Partial<PrimaryEvidence>;
};

type PrimaryEvidence = {
  requestMs: number;
  computedReadyMs: number;
  outboxDrainMs: number;
  routing: EngineRouting;
  fullScan: ScanResult;
  outbox: ComputedOutboxObserverSummary;
  fieldId?: string;
  requestedRecords?: number;
  updatedRecords?: number;
};

type PrimaryMeasurement = Measurement<PrimaryEvidence>;
type RecordUpdateConfig = Extract<
  ComputedOutboxCaseConfig,
  { operation: "record-update" }
>;
type FieldBackfillConfig = Extract<
  ComputedOutboxCaseConfig,
  { operation: "field-backfill" }
>;

const formulaName = (level: number) => `F${level}`;
const expectedSourceValue = (
  rowNumber: number,
  config: ComputedOutboxCaseConfig,
  phase: "seed" | "mutated",
) =>
  rowNumber +
  (phase === "mutated" &&
  config.operation === "record-update" &&
  rowNumber <= config.updateCount
    ? config.generator.updateDelta
    : 0);

const expectedTitle = (rowNumber: number, config: ComputedOutboxCaseConfig) =>
  `${config.generator.titlePrefix} ${rowNumber}`;

const parseRowNumber = (value: unknown, config: ComputedOutboxCaseConfig) => {
  if (typeof value !== "string") {
    throw new Error(`Expected Title string, got ${String(value)}`);
  }
  const prefix = `${config.generator.titlePrefix} `;
  const rowNumber = Number(value.slice(prefix.length));
  if (!value.startsWith(prefix) || !Number.isInteger(rowNumber)) {
    throw new Error(`Expected ${value} to match "${prefix}<rowNumber>"`);
  }
  return rowNumber;
};

const resolveFixtureFields = (
  fields: NamedField[],
  config: ComputedOutboxCaseConfig,
) => {
  const byName = new Map(fields.map((field) => [field.name, field]));
  const sourceFields = {
    Title: byName.get("Title"),
    A: byName.get("A"),
  };
  if (!sourceFields.Title || !sourceFields.A) {
    throw new Error(
      `Computed Outbox seed is missing Title/A; fields=${fields
        .map((field) => field.name)
        .join(",")}`,
    );
  }
  const expectedFormulaCount =
    config.operation === "record-update" ? config.formulaDepth : 0;
  const formulas = Array.from({ length: expectedFormulaCount }, (_, index) => {
    const level = index + 1;
    const field = byName.get(formulaName(level));
    if (!field) {
      throw new Error(`Computed Outbox seed is missing ${formulaName(level)}`);
    }
    return { ...field, level };
  });
  const expectedNames = new Set([
    ...SOURCE_FIELD_NAMES,
    ...formulas.map((field) => field.name),
  ]);
  const extras = fields.filter((field) => !expectedNames.has(field.name));
  if (extras.length > 0) {
    throw new Error(
      `Computed Outbox seed has unexpected fields: ${extras
        .map((field) => field.name)
        .join(",")}`,
    );
  }
  return {
    sourceFields: {
      Title: sourceFields.Title,
      A: sourceFields.A,
    },
    formulas,
  };
};

const buildSeedRecords = (config: ComputedOutboxCaseConfig) =>
  Array.from({ length: config.recordCount }, (_, index) => {
    const rowNumber = index + 1;
    return {
      fields: {
        Title: expectedTitle(rowNumber, config),
        A: rowNumber,
      },
    };
  });

const createFormulaChain = async (
  tableId: string,
  sourceFields: SourceFields,
  depth: number,
) => {
  const formulas: FormulaField[] = [];
  let previousField = sourceFields.A;
  for (let level = 1; level <= depth; level += 1) {
    const field = await createField(tableId, {
      type: FieldType.Formula,
      name: formulaName(level),
      options: { expression: `{${previousField.id}} + 1` },
    });
    const formula = { id: field.id, name: field.name, level };
    formulas.push(formula);
    previousField = formula;
  }
  return formulas;
};

const scanExpectedState = async (
  fixture: Fixture,
  config: ComputedOutboxCaseConfig,
  phase: "seed" | "mutated",
): Promise<ScanResult> => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleOffsets = new Set(config.verify.sampleRows);
  const verifiedSamples: ScanResult["verifiedSamples"] = [];
  const seenRows = new Set<number>();
  const projection = [
    fixture.sourceFields.Title.id,
    fixture.sourceFields.A.id,
    ...fixture.formulas.map((formula) => formula.id),
  ];
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.recordCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          fieldKeyType: FieldKeyType.Id,
          projection,
          skip,
          take,
        }),
    },
    (record) => {
      const rowNumber = parseRowNumber(
        record.fields[fixture.sourceFields.Title.id],
        config,
      );
      if (seenRows.has(rowNumber)) {
        throw new Error(`Duplicate computed Outbox row ${rowNumber}`);
      }
      seenRows.add(rowNumber);
      const expectedA = expectedSourceValue(rowNumber, config, phase);
      const actualA = record.fields[fixture.sourceFields.A.id];
      if (actualA !== expectedA) {
        throw new Error(
          `Computed Outbox source mismatch at row ${rowNumber}: expected ${expectedA}, actual ${String(actualA)}`,
        );
      }
      for (const formula of fixture.formulas) {
        const expected = expectedA + formula.level;
        const actual = record.fields[formula.id];
        if (actual !== expected) {
          throw new Error(
            `Computed Outbox ${formula.name} mismatch at row ${rowNumber}: expected ${expected}, actual ${String(actual)}`,
          );
        }
      }
      const rowOffset = rowNumber - 1;
      if (sampleOffsets.has(rowOffset)) {
        verifiedSamples.push({
          rowNumber,
          recordId: record.id,
          sourceValue: expectedA,
          finalFormulaValue:
            fixture.formulas.length > 0
              ? expectedA + fixture.formulas.length
              : undefined,
        });
      }
    },
  );
  if (
    scannedRecords !== config.recordCount ||
    seenRows.size !== config.recordCount
  ) {
    throw new Error(
      `Computed Outbox scan mismatch: expected ${config.recordCount}, scanned=${scannedRecords}, unique=${seenRows.size}`,
    );
  }
  return {
    scannedRecords,
    pageCount,
    pageSize,
    verifiedSamples: verifiedSamples.sort(
      (left, right) => left.rowNumber - right.rowNumber,
    ),
  };
};

const waitForExpectedState = (
  fixture: Fixture,
  config: ComputedOutboxCaseConfig,
  phase: "seed" | "mutated",
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 120_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 100,
      description: `computed Outbox ${phase} full scan`,
    },
    () => scanExpectedState(fixture, config, phase),
  );

const getSeedConfig = (config: ComputedOutboxCaseConfig) => ({
  baseId: config.baseId,
  operation: config.operation,
  tableNamePrefix: config.tableNamePrefix,
  recordCount: config.recordCount,
  batchSize: config.batchSize,
  formulaDepth: config.operation === "record-update" ? config.formulaDepth : 0,
  generator: {
    type: config.generator.type,
    titlePrefix: config.generator.titlePrefix,
  },
  fixtureVersion: FIXTURE_VERSION,
});

const buildSeedCache = (perfCase: PerfCase, config: ComputedOutboxCaseConfig) =>
  buildSeedCacheInfo({
    perfCase,
    runner: "computed-outbox",
    fixtureVersion: FIXTURE_VERSION,
    seedConfig: getSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../computed-outbox-observer.ts", import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });

const buildFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  tableName: string,
  config: ComputedOutboxCaseConfig,
): Promise<Fixture> => {
  const seedCacheInfo = await buildSeedCache(perfCase, config);
  const cachedTable =
    seedCacheInfo.enabled &&
    (await findSeedTable(baseId, seedCacheInfo.seedTableName));
  if (cachedTable) {
    try {
      if (config.operation === "field-backfill") {
        const cachedFields = await getFields(cachedTable.id);
        for (const field of cachedFields.filter(
          (candidate) => !SOURCE_FIELD_NAMES.includes(candidate.name as never),
        )) {
          await deleteField(cachedTable.id, field.id);
        }
      }
      const fields = await getFields(cachedTable.id);
      const resolved = resolveFixtureFields(fields, config);
      const fixture: Fixture = {
        tableId: cachedTable.id,
        tableName: cachedTable.name,
        ...resolved,
        seedCacheInfo,
        seedCacheHit: true,
        reusable: true,
        seedBuildMs: 0,
        seedRecordsMs: 0,
        seedFormulaSetupMs: 0,
        seedReadyMs: 0,
        mutationTargets: [],
      };
      const ready = await measureAsync("seedRestoreReady", () =>
        waitForExpectedState(fixture, config, "seed"),
      );
      fixture.seedReadyMs = ready.durationMs;
      return fixture;
    } catch (error) {
      console.warn(
        `Invalid cached computed Outbox seed ${cachedTable.name}; rebuilding`,
        error,
      );
      await permanentDeleteTable(baseId, cachedTable.id);
    }
  }

  const actualTableName = seedCacheInfo.enabled
    ? seedCacheInfo.seedTableName
    : tableName;
  let tableId = "";
  try {
    const createMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      "seedBuild:createTable",
      () =>
        measureAsync("seedBuild:createTable", () =>
          createTable(baseId, {
            name: actualTableName,
            fields: [
              { name: "Title", type: FieldType.SingleLineText },
              { name: "A", type: FieldType.Number },
            ],
            records: [],
          }),
        ),
    );
    tableId = createMeasurement.result.id;
    const initialFields = await getFields(tableId);
    const initialResolved = resolveFixtureFields(initialFields, {
      ...config,
      operation: "field-backfill",
    } as FieldBackfillConfig);
    const recordBatches = chunk(buildSeedRecords(config), config.batchSize);
    const recordsMeasurement = await measureAsync("seedRecords", async () => {
      for (const [index, batch] of recordBatches.entries()) {
        await withPerfTraceStep(
          context,
          perfCase,
          `seedBatch:${index + 1}`,
          () =>
            createRecords(tableId, {
              fieldKeyType: FieldKeyType.Name,
              records: batch,
            }),
        );
      }
    });
    const formulaMeasurement = await measureAsync("seedFormulaChain", () =>
      config.operation === "record-update"
        ? createFormulaChain(
            tableId,
            initialResolved.sourceFields,
            config.formulaDepth,
          )
        : Promise.resolve([]),
    );
    const fixture: Fixture = {
      tableId,
      tableName: actualTableName,
      sourceFields: initialResolved.sourceFields,
      formulas: formulaMeasurement.result,
      seedCacheInfo,
      seedCacheHit: false,
      reusable: seedCacheInfo.enabled,
      seedBuildMs: createMeasurement.durationMs,
      seedRecordsMs: recordsMeasurement.durationMs,
      seedFormulaSetupMs: formulaMeasurement.durationMs,
      seedReadyMs: 0,
      mutationTargets: [],
    };
    const ready = await measureAsync("seedReady", () =>
      waitForExpectedState(fixture, config, "seed"),
    );
    fixture.seedReadyMs = ready.durationMs;
    return fixture;
  } catch (error) {
    if (tableId) {
      await permanentDeleteTable(baseId, tableId).catch((cleanupError) =>
        console.warn(
          `Failed to delete incomplete computed Outbox seed ${tableId}`,
          cleanupError,
        ),
      );
    }
    throw error;
  }
};

const collectMutationTargets = async (
  fixture: Fixture,
  config: RecordUpdateConfig,
) => {
  const targets: MutationTarget[] = [];
  await forEachRecordPage(
    {
      totalRows: config.updateCount,
      pageSize: Math.min(config.batchSize, config.updateCount),
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: [fixture.sourceFields.Title.id],
          skip,
          take,
        }),
    },
    (record) => {
      targets.push({
        recordId: record.id,
        rowNumber: parseRowNumber(
          record.fields[fixture.sourceFields.Title.id],
          config,
        ),
      });
    },
  );
  if (targets.length !== config.updateCount) {
    throw new Error(
      `Expected ${config.updateCount} mutation targets, got ${targets.length}`,
    );
  }
  return targets;
};

const responseRecordCount = (data: unknown) =>
  Array.isArray(data)
    ? data.length
    : ((data as { records?: unknown[] } | undefined)?.records?.length ?? 0);

const applySourceValues = async (
  fixture: Fixture,
  config: RecordUpdateConfig,
  phase: "seed" | "mutated",
  context?: PerfRunContext,
) => {
  const response = await updateRecords(fixture.tableId, {
    fieldKeyType: FieldKeyType.Id,
    typecast: false,
    records: fixture.mutationTargets.map((target) => ({
      id: target.recordId,
      fields: {
        [fixture.sourceFields.A.id]: expectedSourceValue(
          target.rowNumber,
          config,
          phase,
        ),
      },
    })),
  });
  expect(response.status).toBe(200);
  const updatedRecords = responseRecordCount(response.data as unknown);
  expect(updatedRecords).toBe(fixture.mutationTargets.length);
  const routing = context
    ? assertEngineRouting(
        context,
        pickRoutingResponseHeaders(response.headers as Record<string, unknown>),
        {
          feature: "updateRecords",
          operation: "Computed Outbox formula source update",
        },
      )
    : undefined;
  return {
    requestedRecords: fixture.mutationTargets.length,
    updatedRecords,
    routing,
  };
};

const currentOutboxCounts = async (baseId: string, seedTableId: string) => {
  const rows = await queryPerfDb<{
    total: string | number;
    dead: string | number;
  }>(
    `
      SELECT
        (SELECT COUNT(*) FROM computed_update_outbox
          WHERE base_id = $1 AND seed_table_id = $2) AS total,
        (SELECT COUNT(*) FROM computed_update_dead_letter
          WHERE base_id = $1 AND seed_table_id = $2) AS dead
    `,
    [baseId, seedTableId],
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    dead: Number(rows[0]?.dead ?? 0),
  };
};

const waitForOutboxDrain = (
  observer: ComputedOutboxObserver,
  config: ComputedOutboxCaseConfig,
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 120_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 100,
      description: "computed Outbox drain",
    },
    async () => {
      const snapshot = await observer.sampleNow();
      if (snapshot.dead > 0) {
        throw new Error(
          `Computed Outbox produced ${snapshot.dead} dead letters`,
        );
      }
      if (snapshot.total > 0) {
        throw new Error(
          `Computed Outbox has not drained: pending=${snapshot.pending}, processing=${snapshot.processing}`,
        );
      }
      return snapshot;
    },
  );

const assertOutboxEvidence = (
  context: PerfRunContext,
  config: ComputedOutboxCaseConfig,
  summary: ComputedOutboxObserverSummary,
) => {
  if (summary.final.total !== 0 || summary.final.dead !== 0) {
    throw new Error(
      `Computed Outbox did not finish cleanly: total=${summary.final.total}, dead=${summary.final.dead}`,
    );
  }
  const v2Hybrid =
    context.engine === "v2" && process.env.V2_COMPUTED_UPDATE_MODE === "hybrid";
  if (
    context.engine === "v2" &&
    config.outbox.expectedInV2Hybrid === "task" &&
    !v2Hybrid
  ) {
    throw new Error(
      "Computed Outbox task cases require PERF_LAB_COMPUTED_UPDATE_MODE=hybrid for V2",
    );
  }
  const expectedTask = v2Hybrid && config.outbox.expectedInV2Hybrid === "task";
  if (summary.sawTask !== expectedTask) {
    throw new Error(
      `Computed Outbox observation mismatch: engine=${context.engine}, v2Mode=${process.env.V2_COMPUTED_UPDATE_MODE ?? "unset"}, expectedTask=${expectedTask}, sawTask=${summary.sawTask}`,
    );
  }
  if (
    expectedTask &&
    config.outbox.expectedChangeType &&
    !summary.changeTypes.includes(config.outbox.expectedChangeType)
  ) {
    throw new Error(
      `Computed Outbox change type mismatch: expected ${config.outbox.expectedChangeType}, observed ${summary.changeTypes.join(",") || "none"}`,
    );
  }
  if (
    expectedTask &&
    config.outbox.minimumPeakPending != null &&
    summary.peakPending < config.outbox.minimumPeakPending
  ) {
    throw new Error(
      `Computed Outbox backlog was too small: expected peakPending >= ${config.outbox.minimumPeakPending}, observed ${summary.peakPending}`,
    );
  }
};

const observePrimary = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  fixture: Fixture,
  config: ComputedOutboxCaseConfig,
  request: () => Promise<{
    routing: EngineRouting;
    fieldId?: string;
    requestedRecords?: number;
    updatedRecords?: number;
  }>,
) => {
  const observer = new ComputedOutboxObserver({
    baseId,
    seedTableId: fixture.tableId,
    pollIntervalMs: config.outbox.pollIntervalMs,
  });
  await observer.start();
  let stopped = false;
  try {
    return await measureAsync(config.threshold.metric, async () => {
      const requestMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        config.operation === "record-update"
          ? "updateFormulaChainSource"
          : "createBackfillFormula",
        () => measureAsync("request", request),
      );
      fixture.partial = {
        ...fixture.partial,
        requestMs: requestMeasurement.durationMs,
        routing: requestMeasurement.result.routing,
        fieldId: requestMeasurement.result.fieldId,
        requestedRecords: requestMeasurement.result.requestedRecords,
        updatedRecords: requestMeasurement.result.updatedRecords,
      };
      const readyMeasurement = await measureAsync("computedReady", () =>
        waitForExpectedState(fixture, config, "mutated"),
      );
      fixture.partial = {
        ...fixture.partial,
        computedReadyMs: readyMeasurement.durationMs,
        fullScan: readyMeasurement.result,
      };
      const drainMeasurement = await measureAsync("outboxDrain", () =>
        waitForOutboxDrain(observer, config),
      );
      const outbox = await observer.stop();
      stopped = true;
      const evidence: PrimaryEvidence = {
        requestMs: requestMeasurement.durationMs,
        computedReadyMs: readyMeasurement.durationMs,
        outboxDrainMs: drainMeasurement.durationMs,
        routing: requestMeasurement.result.routing,
        fullScan: readyMeasurement.result,
        outbox,
        fieldId: requestMeasurement.result.fieldId,
        requestedRecords: requestMeasurement.result.requestedRecords,
        updatedRecords: requestMeasurement.result.updatedRecords,
      };
      fixture.partial = evidence;
      assertOutboxEvidence(context, config, outbox);
      return evidence;
    });
  } finally {
    if (!stopped) {
      try {
        fixture.partial = {
          ...fixture.partial,
          outbox: await observer.stop(),
        };
      } catch (error) {
        console.warn("Failed to stop Computed Outbox observer", error);
      }
    }
  }
};

const seedMetrics = (fixture: Fixture) => ({
  seedCacheHit: fixture.seedCacheHit ? 1 : 0,
  seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
  seedBuildMs: roundMetric(fixture.seedBuildMs),
  seedRecordsMs: roundMetric(fixture.seedRecordsMs),
  seedFormulaSetupMs: roundMetric(fixture.seedFormulaSetupMs),
  seedReadyMs: roundMetric(fixture.seedReadyMs),
});

const buildResult = (
  config: ComputedOutboxCaseConfig,
  fixture: Fixture | undefined,
  primary: PrimaryMeasurement | undefined,
  error?: unknown,
): PerfRunResult => {
  const evidence = primary?.result ?? fixture?.partial;
  const outbox = evidence?.outbox;
  return {
    ...(!error && primary ? { result: "pass" as const } : {}),
    metrics: {
      ...(fixture ? seedMetrics(fixture) : {}),
      ...(primary ? { [config.threshold.metric]: primary.durationMs } : {}),
      ...(evidence?.requestMs != null
        ? { computedRequestMs: roundMetric(evidence.requestMs) }
        : {}),
      ...(evidence?.computedReadyMs != null
        ? { computedReadyMs: roundMetric(evidence.computedReadyMs) }
        : {}),
      ...(evidence?.outboxDrainMs != null
        ? { outboxDrainMs: roundMetric(evidence.outboxDrainMs) }
        : {}),
      ...(outbox
        ? {
            outboxSawTask: outbox.sawTask ? 1 : 0,
            outboxSampleCount: outbox.sampleCount,
            outboxPeakTotal: outbox.peakTotal,
            outboxPeakPending: outbox.peakPending,
            outboxPeakProcessing: outbox.peakProcessing,
            outboxPeakDead: outbox.peakDead,
            outboxMaxAttempts: outbox.maxAttempts,
            outboxMaxEstimatedComplexity: outbox.maxEstimatedComplexity,
            outboxMaxOldestTaskAgeMs: roundMetric(outbox.maxOldestTaskAgeMs),
            ...(outbox.firstSeenMs != null && outbox.lastSeenMs != null
              ? {
                  outboxObservedLifetimeMs: roundMetric(
                    outbox.lastSeenMs - outbox.firstSeenMs,
                  ),
                }
              : {}),
            ...(outbox.firstSeenMs != null
              ? { outboxFirstSeenMs: roundMetric(outbox.firstSeenMs) }
              : {}),
          }
        : {}),
    },
    thresholds: [
      {
        metric: config.threshold.metric,
        max: getPrimaryThresholdMs(config.threshold.maxMs),
        unit: "ms",
      },
    ],
    phases: primary
      ? [
          { name: "request", durationMs: primary.result.requestMs },
          {
            name: "computedReady",
            durationMs: primary.result.computedReadyMs,
          },
          { name: "outboxDrain", durationMs: primary.result.outboxDrainMs },
        ]
      : undefined,
    details: {
      operation: config.operation,
      recordCount: config.recordCount,
      formulaDepth: config.formulaDepth,
      updateCount:
        config.operation === "record-update" ? config.updateCount : undefined,
      tableId: fixture?.tableId,
      tableName: fixture?.tableName,
      formulas: fixture?.formulas,
      fieldId: evidence?.fieldId,
      requestedRecords: evidence?.requestedRecords,
      updatedRecords: evidence?.updatedRecords,
      routing: evidence?.routing,
      fullScan: evidence?.fullScan,
      outbox,
      seed: fixture
        ? {
            seedHash: fixture.seedCacheInfo.seedHash,
            seedHashShort: fixture.seedCacheInfo.seedHashShort,
            seedTableName: fixture.seedCacheInfo.seedTableName,
            cacheHit: fixture.seedCacheHit,
            reusable: fixture.reusable,
          }
        : undefined,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : undefined,
    },
  };
};

const cleanupRecordUpdate = async (
  baseId: string,
  fixture: Fixture | undefined,
  config: RecordUpdateConfig,
) => {
  if (!fixture || isExecuteDbIsolated()) return;
  if (!fixture.reusable) {
    await permanentDeleteTable(baseId, fixture.tableId);
    return;
  }
  if (fixture.mutationTargets.length === 0) return;
  try {
    await applySourceValues(fixture, config, "seed");
    await waitForExpectedState(fixture, config, "seed");
    await pollUntilReady(
      {
        timeoutMs: config.verify.timeoutMs ?? 120_000,
        pollIntervalMs: config.verify.pollIntervalMs ?? 100,
        description: "computed Outbox cleanup drain",
      },
      async () => {
        const counts = await currentOutboxCounts(baseId, fixture.tableId);
        if (counts.total > 0 || counts.dead > 0) {
          throw new Error(
            `Computed Outbox cleanup not drained: total=${counts.total}, dead=${counts.dead}`,
          );
        }
        return counts;
      },
    );
  } catch (error) {
    console.warn(
      `Failed to restore computed Outbox fixture ${fixture.tableId}; deleting`,
      error,
    );
    await permanentDeleteTable(baseId, fixture.tableId);
  }
};

const recordUpdateSpec: RecordMutationLifecycleSpec<
  RecordUpdateConfig,
  Fixture,
  ScanResult,
  PrimaryEvidence
> = {
  resolveTableNamePrefix: (config) => config.tableNamePrefix,
  prepareFixture: ({ perfCase, context, baseId, tableName, config }) =>
    buildFixture(perfCase, context, baseId, tableName, config),
  assertSeedReady: ({ fixture, config }) =>
    waitForExpectedState(fixture, config, "seed"),
  runMeasuredOperation: async ({
    perfCase,
    context,
    baseId,
    fixture,
    config,
  }) => {
    fixture.mutationTargets = await collectMutationTargets(fixture, config);
    return observePrimary(
      perfCase,
      context,
      baseId,
      fixture,
      config,
      async () => {
        const result = await applySourceValues(
          fixture,
          config,
          "mutated",
          context,
        );
        if (!result.routing) {
          throw new Error("Computed Outbox update routing was not captured");
        }
        return result as typeof result & { routing: EngineRouting };
      },
    );
  },
  buildResult: ({ config, fixture, primaryMeasurement, error }) =>
    buildResult(config, fixture, primaryMeasurement, error),
  cleanup: ({ baseId, fixture, config }) =>
    cleanupRecordUpdate(baseId, fixture, config),
};

const backfillSpec: FieldAddLifecycleSpec<
  FieldBackfillConfig,
  Fixture,
  ScanResult,
  PrimaryMeasurement
> = {
  prepareFixture: ({ perfCase, context, baseId, config, seedMode }) =>
    buildFixture(
      perfCase,
      context,
      baseId,
      `${config.tableNamePrefix}-${seedMode ? "seed" : "run"}-${Date.now()}`,
      config,
    ),
  assertSeedReady: ({ fixture, config }) =>
    waitForExpectedState(fixture, config, "seed"),
  runPrimary: async ({ perfCase, context, baseId, fixture, config }) =>
    observePrimary(perfCase, context, baseId, fixture, config, async () => {
      const response = await apiCreateField(fixture.tableId, {
        type: FieldType.Formula,
        name: formulaName(1),
        options: { expression: `{${fixture.sourceFields.A.id}} + 1` },
      });
      expect(response.status).toBe(201);
      const field = response.data;
      fixture.createdFieldId = field.id;
      fixture.formulas = [{ id: field.id, name: field.name, level: 1 }];
      const routing = assertEngineRouting(
        context,
        pickRoutingResponseHeaders(response.headers as Record<string, unknown>),
        {
          feature: "createField",
          operation: "Computed Outbox formula backfill",
        },
      );
      return { routing, fieldId: field.id };
    }),
  buildResult: ({ config, fixture, primary, error }) =>
    buildResult(config, fixture, primary, error),
  cleanup: async ({ baseId, fixture }) => {
    if (!fixture || isExecuteDbIsolated()) return;
    if (!fixture.reusable) {
      await permanentDeleteTable(baseId, fixture.tableId);
      return;
    }
    if (fixture.createdFieldId) {
      await deleteField(fixture.tableId, fixture.createdFieldId);
    }
  },
};

export const runComputedOutboxCase = (
  perfCase: PerfCaseFor<"computed-outbox">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  perfCase.config.operation === "record-update"
    ? runRecordMutationLifecycle(perfCase, context, recordUpdateSpec)
    : runFieldAddLifecycle(perfCase, context, backfillSpec);

export const seedComputedOutboxCase = (
  perfCase: PerfCaseFor<"computed-outbox">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  perfCase.config.operation === "record-update"
    ? seedRecordMutationLifecycle(perfCase, context, recordUpdateSpec)
    : seedFieldAddLifecycle(perfCase, context, backfillSpec);
