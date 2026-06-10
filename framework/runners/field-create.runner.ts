import { FieldType } from "@teable/core";
import { createField as apiCreateField } from "@teable/openapi";
import {
  createTable,
  deleteField,
  getFields,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs } from "../env";
import { measureAsync } from "../metrics";
import {
  buildSeedCacheInfo,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { withPerfTraceStep } from "../trace-collector";
import type {
  FieldCreateCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import { PerfRunDiagnosticError } from "../types";

type Measurement<T> = {
  name: string;
  durationMs: number;
  result: T;
};

type FieldCreateFixture = {
  tableId: string;
  tableName: string;
  seedCacheInfo?: SeedCacheInfo;
  seedCacheHit?: boolean;
  reusableSeed?: boolean;
};

type SelectChoice = {
  id?: string;
  name: string;
  color?: string;
};

type SelectOptions = {
  choices?: SelectChoice[];
};

type CreatedField = {
  id: string;
  name: string;
  type: FieldType;
  options?: SelectOptions;
};

type FieldCreatePrimaryResult = {
  fieldId: string;
  optionCount: number;
  responseHeaders: Record<string, string>;
  routing: {
    requestedEngine: string;
    expectedXTeableV2: string;
    actualXTeableV2: string;
    routeMatched: boolean;
    xTeableV2Feature: string;
    xTeableV2Reason: string;
  };
  verifiedOptions: Array<{
    index: number;
    name: string;
    color?: string;
  }>;
};

const FIELD_CREATE_FIXTURE_VERSION = "field-create-v1";

const assertSingleSelectOptions = (
  field: CreatedField | undefined,
  config: FieldCreateCaseConfig,
) => {
  if (!field) {
    throw new Error(`Missing created field ${config.field.name}`);
  }
  if (field.type !== FieldType.SingleSelect) {
    throw new Error(
      `Created field ${field.name} has type ${field.type}, expected ${FieldType.SingleSelect}`,
    );
  }

  const expectedChoices = (config.field.options as SelectOptions | undefined)
    ?.choices;
  const actualChoices = field.options?.choices;
  if (!expectedChoices?.length) {
    throw new Error(`Case field ${config.field.name} has no expected choices`);
  }
  if (!actualChoices) {
    throw new Error(`Created field ${field.name} has no choices`);
  }
  if (actualChoices.length !== config.verify.optionCount) {
    throw new Error(
      `Created field ${field.name} choice count mismatch: expected ${config.verify.optionCount}, got ${actualChoices.length}`,
    );
  }

  return config.verify.sampleOptionIndexes.map((index) => {
    const expected = expectedChoices[index];
    const actual = actualChoices[index];
    if (!expected || !actual) {
      throw new Error(`Missing option sample at index ${index}`);
    }
    if (expected.name !== actual.name || expected.color !== actual.color) {
      throw new Error(
        `Option ${index} mismatch: expected ${JSON.stringify(
          expected,
        )}, got ${JSON.stringify(actual)}`,
      );
    }
    return {
      index,
      name: actual.name,
      color: actual.color,
    };
  });
};

const getResponseHeader = (headers: Record<string, unknown>, name: string) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0]) : String(value ?? "");
};

const pickResponseHeaders = (headers: Record<string, unknown>) => ({
  "x-teable-v2": getResponseHeader(headers, "x-teable-v2"),
  "x-teable-v2-feature": getResponseHeader(headers, "x-teable-v2-feature"),
  "x-teable-v2-reason": getResponseHeader(headers, "x-teable-v2-reason"),
  traceparent: getResponseHeader(headers, "traceparent"),
});

const assertExpectedRouting = (
  context: PerfRunContext,
  responseHeaders: Record<string, string>,
) => {
  const expectedXTeableV2 = context.engine === "v2" ? "true" : "false";
  const actualXTeableV2 = responseHeaders["x-teable-v2"];
  if (actualXTeableV2 !== expectedXTeableV2) {
    throw new Error(
      `Field create did not use expected ${context.engine.toUpperCase()} route; expected x-teable-v2=${expectedXTeableV2}, got ${actualXTeableV2}; headers=${JSON.stringify(
        responseHeaders,
      )}`,
    );
  }

  return {
    requestedEngine: context.engine,
    expectedXTeableV2,
    actualXTeableV2,
    routeMatched: true,
    xTeableV2Feature: responseHeaders["x-teable-v2-feature"],
    xTeableV2Reason: responseHeaders["x-teable-v2-reason"],
  };
};

const assertSeedReady = async (
  fixture: FieldCreateFixture,
  config: FieldCreateCaseConfig,
) => {
  const fields = (await getFields(fixture.tableId)) as CreatedField[];
  const baseFieldNames = new Set(config.baseFields.map((field) => field.name));
  const missingBaseFields = config.baseFields.filter(
    (field) => !fields.some((actual) => actual.name === field.name),
  );
  if (missingBaseFields.length > 0) {
    throw new Error(
      `Missing base fields: ${missingBaseFields.map((field) => field.name).join(", ")}`,
    );
  }

  for (const field of fields) {
    if (!baseFieldNames.has(field.name)) {
      await deleteField(fixture.tableId, field.id);
    }
  }

  return {
    fieldCount: fields.length,
    baseFieldCount: config.baseFields.length,
  };
};

const buildFieldCreateFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  baseId: string,
  tableName: string,
  config: FieldCreateCaseConfig,
  seedCacheInfo: SeedCacheInfo,
): Promise<FieldCreateFixture> => {
  if (seedCacheInfo.enabled) {
    const cachedTable = await findSeedTable(
      baseId,
      seedCacheInfo.seedTableName,
    );
    if (cachedTable) {
      const fixture = {
        tableId: cachedTable.id,
        tableName: cachedTable.name,
        seedCacheInfo,
        seedCacheHit: true,
        reusableSeed: true,
      };
      try {
        await assertSeedReady(fixture, config);
        return fixture;
      } catch (error) {
        console.warn(
          `Invalid cached field create seed ${seedCacheInfo.seedTableName}; rebuilding`,
          error,
        );
        await permanentDeleteTable(baseId, cachedTable.id);
      }
    }
  }

  const actualTableName = seedCacheInfo.enabled
    ? seedCacheInfo.seedTableName
    : tableName;
  let createdTableId = "";

  try {
    const createTableMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      seedCacheInfo.enabled ? "seedBuild:createTable" : "createTable",
      () =>
        measureAsync(seedCacheInfo.enabled ? "seedBuild" : "createTable", () =>
          createTable(baseId, {
            name: actualTableName,
            fields: config.baseFields,
            records: [],
          }),
        ),
    );
    createdTableId = createTableMeasurement.result.id;
    return {
      tableId: createdTableId,
      tableName: actualTableName,
      seedCacheInfo,
      seedCacheHit: false,
      reusableSeed: seedCacheInfo.enabled,
    };
  } catch (error) {
    if (createdTableId) {
      try {
        await permanentDeleteTable(baseId, createdTableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup incomplete field create seed ${createdTableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const runFieldCreatePrimary = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: FieldCreateFixture,
  config: FieldCreateCaseConfig,
): Promise<FieldCreatePrimaryResult> => {
  const createResponse = await withPerfTraceStep(
    context,
    perfCase,
    "createSingleSelectField",
    () => apiCreateField(fixture.tableId, config.field),
  );
  expect(createResponse.status).toBe(201);

  const responseHeaders = pickResponseHeaders(
    createResponse.headers as Record<string, unknown>,
  );
  const routing = assertExpectedRouting(context, responseHeaders);
  const createdField = createResponse.data as CreatedField;
  const fields = (await getFields(fixture.tableId)) as CreatedField[];
  const resolvedField = fields.find((field) => field.id === createdField.id);
  const verifiedOptions = assertSingleSelectOptions(resolvedField, config);

  return {
    fieldId: createdField.id,
    optionCount: resolvedField?.options?.choices?.length ?? 0,
    responseHeaders,
    routing,
    verifiedOptions,
  };
};

const buildFieldCreateResult = ({
  config,
  prepareMeasurement,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  config: FieldCreateCaseConfig;
  prepareMeasurement?: Measurement<FieldCreateFixture>;
  seedReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertSeedReady>>
  >;
  primaryMeasurement?: Measurement<FieldCreatePrimaryResult>;
  error?: unknown;
}): PerfRunResult => {
  const fixture = prepareMeasurement?.result;
  const primaryResult = primaryMeasurement?.result;

  return {
    metrics: {
      ...(prepareMeasurement
        ? { fieldCreatePrepareMs: prepareMeasurement.durationMs }
        : {}),
      ...(fixture?.seedCacheInfo
        ? {
            seedCacheHit: fixture.seedCacheHit ? 1 : 0,
            seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
            ...(fixture.seedCacheHit
              ? { seedRestoreMs: prepareMeasurement?.durationMs ?? 0 }
              : fixture.seedCacheInfo.enabled
                ? { seedBuildMs: prepareMeasurement?.durationMs ?? 0 }
                : {}),
            ...(seedReadyMeasurement
              ? { seedReadyMs: seedReadyMeasurement.durationMs }
              : {}),
          }
        : {}),
      ...(primaryMeasurement
        ? { singleSelectCreateOptionsMs: primaryMeasurement.durationMs }
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
      ...(prepareMeasurement
        ? [
            {
              name: prepareMeasurement.name,
              durationMs: prepareMeasurement.durationMs,
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
      tableId: fixture?.tableId,
      tableName: fixture?.tableName,
      fieldName: config.field.name,
      fieldId: primaryResult?.fieldId,
      optionCount: primaryResult?.optionCount ?? config.verify.optionCount,
      responseHeaders: primaryResult?.responseHeaders,
      routing: primaryResult?.routing,
      verifiedOptions: primaryResult?.verifiedOptions,
      prepare: fixture
        ? {
            durationMs: prepareMeasurement.durationMs,
            seedCacheEnabled: fixture.seedCacheInfo?.enabled,
            seedCacheHit: fixture.seedCacheHit,
            seedHash: fixture.seedCacheInfo?.seedHash,
            seedTableName: fixture.seedCacheInfo?.seedTableName,
          }
        : undefined,
      ...(error
        ? {
            diagnosticError:
              error instanceof Error ? error.message : String(error),
          }
        : {}),
    },
  };
};

const getFieldCreateSeedConfig = (config: FieldCreateCaseConfig) => ({
  tableNamePrefix: config.tableNamePrefix,
  baseFields: config.baseFields,
});

const buildSeedCache = (perfCase: PerfCase, config: FieldCreateCaseConfig) =>
  buildSeedCacheInfo({
    perfCase,
    runner: "field-create",
    fixtureVersion: FIELD_CREATE_FIXTURE_VERSION,
    seedConfig: getFieldCreateSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });

export const seedFieldCreateCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FieldCreateCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-seed-${Date.now()}`;
  const seedCacheInfo = await buildSeedCache(perfCase, config);
  const fixture = await buildFieldCreateFixture(
    perfCase,
    context,
    baseId,
    tableName,
    config,
    seedCacheInfo,
  );
  const seedReadyMeasurement = await measureAsync("seedReady", () =>
    assertSeedReady(fixture, config),
  );

  return buildFieldCreateResult({
    config,
    prepareMeasurement: {
      name: fixture.seedCacheHit ? "seedRestore" : "seedBuild",
      durationMs: 0,
      result: fixture,
    },
    seedReadyMeasurement,
  });
};

export const runFieldCreateCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FieldCreateCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const seedCacheInfo = await buildSeedCache(perfCase, config);
  let fixture: FieldCreateFixture | undefined;
  let createdFieldId = "";

  try {
    const prepareMeasurement = await measureAsync("prepareFieldCreate", () =>
      buildFieldCreateFixture(
        perfCase,
        context,
        baseId,
        tableName,
        config,
        seedCacheInfo,
      ),
    );
    fixture = prepareMeasurement.result;
    const seedReadyMeasurement = await measureAsync("seedReady", () =>
      assertSeedReady(prepareMeasurement.result, config),
    );
    const primaryMeasurement = await measureAsync(
      "singleSelectCreateOptions",
      () =>
        runFieldCreatePrimary(
          perfCase,
          context,
          prepareMeasurement.result,
          config,
        ),
    );
    createdFieldId = primaryMeasurement.result.fieldId;

    return buildFieldCreateResult({
      config,
      prepareMeasurement,
      seedReadyMeasurement,
      primaryMeasurement,
    });
  } catch (error) {
    throw new PerfRunDiagnosticError(
      error instanceof Error ? error.message : String(error),
      buildFieldCreateResult({
        config,
        error,
      }),
    );
  } finally {
    if (fixture?.reusableSeed && createdFieldId) {
      try {
        await deleteField(fixture.tableId, createdFieldId);
      } catch (error) {
        console.warn(
          `Failed to cleanup perf field create field ${createdFieldId}`,
          error,
        );
      }
    } else if (fixture?.tableId) {
      try {
        await permanentDeleteTable(baseId, fixture.tableId);
      } catch (error) {
        console.warn(
          `Failed to cleanup perf field create table ${fixture.tableId}`,
          error,
        );
      }
    }
  }
};
