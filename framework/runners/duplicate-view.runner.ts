import { SortFunc, ViewType } from "@teable/core";
import { deleteView, duplicateView, getView } from "@teable/openapi";
import {
  createTable,
  createView,
  getFields,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import {
  getPositiveIntegerEnv,
  getPrimaryThresholdMs,
  isExecuteDbIsolated,
} from "../env";
import { measureAsync, summarizeDurations, type Measurement } from "../metrics";
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
import { withPerfTraceStep } from "../trace-collector";
import type {
  DuplicateViewCaseConfig,
  PerfCase,
  PerfCaseFor,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import { PerfRunDiagnosticError } from "../types";

type NamedField = {
  id: string;
  name: string;
};

type ViewSnapshot = {
  id: string;
  name: string;
  type: string;
  filter?: unknown;
  sort?: unknown;
  group?: unknown;
  columnMeta?: unknown;
};

type DuplicateViewFixture = {
  tableId: string;
  tableName: string;
  sourceView: ViewSnapshot;
  fieldIds: Record<string, string>;
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
};

type DuplicateSample = {
  iteration: number;
  durationMs: number;
  status: number;
  viewId: string;
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
};

type DuplicatePrimaryResult = {
  warmupViewId: string;
  samples: DuplicateSample[];
  summary: ReturnType<typeof summarizeDurations>;
  createdViewIds: string[];
  firstRouting?: EngineRouting;
  lastRouting?: EngineRouting;
};

type DuplicateVerification = {
  createdViewCount: number;
  sourceViewId: string;
  verifiedViewIds: string[];
  sourceMetadata: Omit<ViewSnapshot, "id" | "name">;
};

const FIXTURE_VERSION = "duplicate-view-v1";

const asViewSnapshot = (view: unknown): ViewSnapshot => {
  const candidate = view as ViewSnapshot;
  if (!candidate?.id || !candidate.name || !candidate.type) {
    throw new Error(`Invalid view payload: ${JSON.stringify(view)}`);
  }
  return {
    id: candidate.id,
    name: candidate.name,
    type: candidate.type,
    filter: candidate.filter,
    sort: candidate.sort,
    group: candidate.group,
    columnMeta: candidate.columnMeta,
  };
};

const comparableMetadata = (view: ViewSnapshot) => ({
  type: view.type,
  filter: view.filter,
  sort: view.sort,
  group: view.group,
  columnMeta: view.columnMeta,
});

const assertSameMetadata = (source: ViewSnapshot, duplicate: ViewSnapshot) => {
  const expected = comparableMetadata(source);
  const actual = comparableMetadata(duplicate);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Duplicated view metadata mismatch: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`,
    );
  }
};

const resolveFieldIds = (
  fields: NamedField[],
  config: DuplicateViewCaseConfig,
) => {
  const names = [
    config.view.textFieldName,
    config.view.numberFieldName,
    config.view.selectFieldName,
    config.view.groupFieldName,
  ];
  const resolved = Object.fromEntries(
    names.map((name) => {
      const field = fields.find((candidate) => candidate.name === name);
      if (!field) {
        throw new Error(
          `Missing duplicate-view field ${name}; available=${fields.map((candidate) => candidate.name).join(",")}`,
        );
      }
      return [name, field.id];
    }),
  );
  return resolved;
};

const buildSourceViewInput = (
  fields: NamedField[],
  fieldIds: Record<string, string>,
  config: DuplicateViewCaseConfig,
) => ({
  name: config.sourceViewName,
  type: ViewType.Grid,
  filter: {
    conjunction: "and" as const,
    filterSet: [
      {
        fieldId: fieldIds[config.view.textFieldName],
        operator: "contains" as const,
        value: "Item",
      },
      {
        fieldId: fieldIds[config.view.numberFieldName],
        operator: "isGreater" as const,
        value: 100,
      },
      {
        fieldId: fieldIds[config.view.selectFieldName],
        operator: "is" as const,
        value: "Todo",
      },
    ],
  },
  sort: {
    sortObjs: [
      {
        fieldId: fieldIds[config.view.numberFieldName],
        order: SortFunc.Desc,
      },
      {
        fieldId: fieldIds[config.view.textFieldName],
        order: SortFunc.Asc,
      },
    ],
  },
  group: [
    {
      fieldId: fieldIds[config.view.groupFieldName],
      order: SortFunc.Asc,
    },
  ],
  columnMeta: Object.fromEntries(
    fields.map((field, index) => [
      field.id,
      {
        order: index,
        width: 120 + (index % 5) * 20,
        hidden: index > 0 && index % 7 === 0,
      },
    ]),
  ),
});

const assertSeedReady = async (
  fixture: DuplicateViewFixture,
  config: DuplicateViewCaseConfig,
) => {
  const fields = (await getFields(fixture.tableId)) as NamedField[];
  if (fields.length !== config.fields.length) {
    throw new Error(
      `Duplicate-view seed field count mismatch: expected ${config.fields.length}, actual ${fields.length}`,
    );
  }
  resolveFieldIds(fields, config);
  const views = (await getViews(fixture.tableId)).map(asViewSnapshot);
  const sourceView = views.find(
    (candidate) => candidate.name === config.sourceViewName,
  );
  if (!sourceView) {
    throw new Error(`Missing source view ${config.sourceViewName}`);
  }
  if (
    !sourceView.filter ||
    !sourceView.sort ||
    !sourceView.group ||
    !sourceView.columnMeta
  ) {
    throw new Error(
      `Source view ${sourceView.id} is missing complex metadata: ${JSON.stringify(comparableMetadata(sourceView))}`,
    );
  }
  return {
    fieldCount: fields.length,
    viewCount: views.length,
    sourceViewId: sourceView.id,
  };
};

const buildSeedCache = (perfCase: PerfCaseFor<"duplicate-view">) =>
  buildSeedCacheInfo({
    perfCase,
    runner: "duplicate-view",
    fixtureVersion: FIXTURE_VERSION,
    seedConfig: {
      tableNamePrefix: perfCase.config.tableNamePrefix,
      fields: perfCase.config.fields,
      sourceViewName: perfCase.config.sourceViewName,
      view: perfCase.config.view,
    },
    seedCodeFiles: [new URL(import.meta.url)],
  });

const createFixture = async (
  perfCase: PerfCaseFor<"duplicate-view">,
  baseId: string,
  seedCacheInfo: SeedCacheInfo,
) => {
  const config = perfCase.config;
  const tableName = seedCacheInfo.enabled
    ? seedCacheInfo.seedTableName
    : `${config.tableNamePrefix}-${Date.now()}`;
  const table = await createTable(baseId, {
    name: tableName,
    fields: config.fields,
    records: [],
  });
  try {
    const fields = (await getFields(table.id)) as NamedField[];
    const fieldIds = resolveFieldIds(fields, config);
    const sourceView = asViewSnapshot(
      await createView(
        table.id,
        buildSourceViewInput(fields, fieldIds, config),
      ),
    );
    const fixture: DuplicateViewFixture = {
      tableId: table.id,
      tableName,
      sourceView,
      fieldIds,
      seedCacheInfo,
      seedCacheHit: false,
      reusableSeed: seedCacheInfo.enabled,
    };
    await assertSeedReady(fixture, config);
    return fixture;
  } catch (error) {
    await permanentDeleteTable(baseId, table.id);
    throw error;
  }
};

const prepareFixture = async (
  perfCase: PerfCaseFor<"duplicate-view">,
  baseId: string,
) => {
  const config = perfCase.config;
  const seedCacheInfo = await buildSeedCache(perfCase);
  if (seedCacheInfo.enabled) {
    const cached = await findSeedTable(baseId, seedCacheInfo.seedTableName);
    if (cached) {
      try {
        const fields = (await getFields(cached.id)) as NamedField[];
        const fieldIds = resolveFieldIds(fields, config);
        const views = (await getViews(cached.id)).map(asViewSnapshot);
        const sourceView = views.find(
          (candidate) => candidate.name === config.sourceViewName,
        );
        if (!sourceView) {
          throw new Error(
            `Missing cached source view ${config.sourceViewName}`,
          );
        }
        const fixture: DuplicateViewFixture = {
          tableId: cached.id,
          tableName: cached.name,
          sourceView,
          fieldIds,
          seedCacheInfo,
          seedCacheHit: true,
          reusableSeed: true,
        };
        await assertSeedReady(fixture, config);
        return fixture;
      } catch (error) {
        console.warn(
          `Invalid cached duplicate-view seed ${cached.id}; rebuilding`,
          error,
        );
        await permanentDeleteTable(baseId, cached.id);
      }
    }
  }
  return createFixture(perfCase, baseId, seedCacheInfo);
};

const duplicateOnce = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: DuplicateViewFixture,
  stepId: string,
  checkpoint?: { index: number; total: number },
) => {
  const duplicateRequest = () =>
    duplicateView(fixture.tableId, fixture.sourceView.id);
  const measurement = await measureAsync(stepId, () =>
    checkpoint
      ? withPerfTraceStep(context, perfCase, stepId, duplicateRequest, {
          checkpoint,
        })
      : duplicateRequest(),
  );
  if (measurement.result.status !== 201) {
    throw new Error(
      `Duplicate view returned ${measurement.result.status}, expected 201`,
    );
  }
  const duplicate = asViewSnapshot(measurement.result.data);
  assertSameMetadata(fixture.sourceView, duplicate);
  const responseHeaders = pickRoutingResponseHeaders(
    measurement.result.headers as Record<string, unknown>,
  );
  const routing = assertEngineRouting(context, responseHeaders, {
    operation: "duplicateView",
    feature: "duplicateView",
  });
  return { measurement, duplicate, responseHeaders, routing };
};

const runPrimary = async (
  perfCase: PerfCaseFor<"duplicate-view">,
  context: PerfRunContext,
  fixture: DuplicateViewFixture,
) => {
  const samples =
    getPositiveIntegerEnv("PERF_LAB_SAMPLES") ?? perfCase.config.samples;
  const warmup = await duplicateOnce(perfCase, context, fixture, "warmup");
  const details: DuplicateSample[] = [];
  const createdViewIds = [warmup.duplicate.id];
  for (let iteration = 1; iteration <= samples; iteration += 1) {
    const current = await duplicateOnce(
      perfCase,
      context,
      fixture,
      `sample-${iteration}`,
      {
        index: iteration - 1,
        total: samples,
      },
    );
    createdViewIds.push(current.duplicate.id);
    details.push({
      iteration,
      durationMs: current.measurement.durationMs,
      status: current.measurement.result.status,
      viewId: current.duplicate.id,
      responseHeaders: current.responseHeaders,
      routing: current.routing,
    });
  }
  return {
    warmupViewId: warmup.duplicate.id,
    samples: details,
    summary: summarizeDurations(details.map((sample) => sample.durationMs)),
    createdViewIds,
    firstRouting: details[0]?.routing,
    lastRouting: details[details.length - 1]?.routing,
  } satisfies DuplicatePrimaryResult;
};

const verifyDuplicates = async (
  fixture: DuplicateViewFixture,
  primary: DuplicatePrimaryResult,
): Promise<DuplicateVerification> => {
  const views = (await getViews(fixture.tableId)).map(asViewSnapshot);
  const byId = new Map<string, ViewSnapshot>(
    views.map((view): [string, ViewSnapshot] => [view.id, view]),
  );
  for (const viewId of primary.createdViewIds) {
    const view =
      byId.get(viewId) ??
      asViewSnapshot((await getView(fixture.tableId, viewId)).data);
    assertSameMetadata(fixture.sourceView, view);
  }
  return {
    createdViewCount: primary.createdViewIds.length,
    sourceViewId: fixture.sourceView.id,
    verifiedViewIds: primary.createdViewIds,
    sourceMetadata: comparableMetadata(fixture.sourceView),
  };
};

const cleanupFixture = async (
  baseId: string,
  fixture: DuplicateViewFixture | undefined,
  config: DuplicateViewCaseConfig,
  createdViewIds: string[],
) => {
  if (!fixture || isExecuteDbIsolated()) {
    return;
  }
  if (!fixture.reusableSeed) {
    await permanentDeleteTable(baseId, fixture.tableId);
    return;
  }
  try {
    for (const viewId of createdViewIds) {
      await deleteView(fixture.tableId, viewId);
    }
    await assertSeedReady(fixture, config);
  } catch (error) {
    console.warn(
      `Failed to restore duplicate-view seed ${fixture.tableId}; deleting`,
      error,
    );
    await permanentDeleteTable(baseId, fixture.tableId);
  }
};

const buildResult = ({
  config,
  fixture,
  prepare,
  seedReady,
  primary,
  verification,
  error,
}: {
  config: DuplicateViewCaseConfig;
  fixture?: DuplicateViewFixture;
  prepare?: Measurement<DuplicateViewFixture>;
  seedReady?: Measurement<Awaited<ReturnType<typeof assertSeedReady>>>;
  primary?: DuplicatePrimaryResult;
  verification?: Measurement<DuplicateVerification>;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    ...(prepare ? { prepareMs: prepare.durationMs } : {}),
    ...(seedReady ? { seedReadyMs: seedReady.durationMs } : {}),
    ...(primary
      ? {
          duplicateViewMinMs: primary.summary.minMs,
          duplicateViewP50Ms: primary.summary.p50Ms,
          [config.threshold.metric]: primary.summary.p95Ms,
          duplicateViewMaxMs: primary.summary.maxMs,
        }
      : {}),
    ...(verification ? { verifyMs: verification.durationMs } : {}),
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
    ...(prepare
      ? [{ name: prepare.name, durationMs: prepare.durationMs }]
      : []),
    ...(seedReady
      ? [{ name: seedReady.name, durationMs: seedReady.durationMs }]
      : []),
    ...(primary
      ? [
          {
            name: config.threshold.metric,
            durationMs: primary.samples.reduce(
              (total, sample) => total + sample.durationMs,
              0,
            ),
          },
        ]
      : []),
    ...(verification
      ? [{ name: verification.name, durationMs: verification.durationMs }]
      : []),
  ],
  details: {
    operation: "duplicate-view",
    tableId: fixture?.tableId,
    sourceViewId: fixture?.sourceView.id,
    samples: primary?.samples,
    summary: primary?.summary,
    routing: primary?.firstRouting,
    routingLast: primary?.lastRouting,
    verification: verification?.result,
    seed: fixture
      ? {
          cacheHit: fixture.seedCacheHit,
          reusable: fixture.reusableSeed,
          seedHash: fixture.seedCacheInfo.seedHash,
          seedTableName: fixture.seedCacheInfo.seedTableName,
          ready: seedReady?.result,
        }
      : undefined,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message }
        : undefined,
  },
});

export const seedDuplicateViewCase = async (
  perfCase: PerfCaseFor<"duplicate-view">,
  _context: PerfRunContext,
): Promise<PerfRunResult> => {
  const baseId = globalThis.testConfig.baseId;
  const prepare = await measureAsync("prepare", () =>
    prepareFixture(perfCase, baseId),
  );
  const seedReady = await measureAsync("seedReady", () =>
    assertSeedReady(prepare.result, perfCase.config),
  );
  return buildResult({
    config: perfCase.config,
    fixture: prepare.result,
    prepare,
    seedReady,
  });
};

export const runDuplicateViewCase = async (
  perfCase: PerfCaseFor<"duplicate-view">,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const baseId = globalThis.testConfig.baseId;
  let fixture: DuplicateViewFixture | undefined;
  let prepare: Measurement<DuplicateViewFixture> | undefined;
  let seedReady:
    | Measurement<Awaited<ReturnType<typeof assertSeedReady>>>
    | undefined;
  let primary: DuplicatePrimaryResult | undefined;
  let verification: Measurement<DuplicateVerification> | undefined;
  try {
    prepare = await measureAsync("prepare", () =>
      prepareFixture(perfCase, baseId),
    );
    fixture = prepare.result;
    seedReady = await measureAsync("seedReady", () =>
      assertSeedReady(fixture!, perfCase.config),
    );
    primary = await runPrimary(perfCase, context, fixture);
    verification = await measureAsync("verify", () =>
      verifyDuplicates(fixture!, primary!),
    );
    return buildResult({
      config: perfCase.config,
      fixture,
      prepare,
      seedReady,
      primary,
      verification,
    });
  } catch (error) {
    throw new PerfRunDiagnosticError(
      error instanceof Error ? error.message : String(error),
      buildResult({
        config: perfCase.config,
        fixture,
        prepare,
        seedReady,
        primary,
        verification,
        error,
      }),
    );
  } finally {
    await cleanupFixture(
      baseId,
      fixture,
      perfCase.config,
      primary?.createdViewIds ?? [],
    );
  }
};
