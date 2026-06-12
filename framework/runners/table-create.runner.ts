import { axios } from "@teable/openapi";
import {
  getFields,
  getRecords,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, summarizeDurations } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  TableCreateCaseConfig,
} from "../types";
import { PerfRunDiagnosticError } from "../types";
import { pickTableLifecycleHeaders } from "./table-lifecycle.shared";

type Measurement<T> = {
  name: string;
  durationMs: number;
  result: T;
};

type CreatedTable = {
  index: number;
  tableId: string;
  tableName: string;
  status: number;
  durationMs: number;
  responseHeaders: ReturnType<typeof pickTableLifecycleHeaders>;
};

type TableVerification = {
  tableId: string;
  fieldCount: number;
  viewCount: number;
  recordCount: number;
};

const padIndex = (index: number) => String(index).padStart(2, "0");

const createOneTable = async (
  baseId: string,
  tableName: string,
  config: TableCreateCaseConfig,
) => {
  const response = await axios.post(`/base/${baseId}/table`, {
    name: tableName,
    fields: config.fields,
    records: [],
  });
  expect(response.status).toBe(201);
  return response;
};

const verifyCreatedTable = async (
  created: CreatedTable,
  config: TableCreateCaseConfig,
): Promise<TableVerification> => {
  const fields = await getFields(created.tableId);
  const fieldNames = new Set(fields.map((field) => field.name));
  for (const field of config.fields) {
    if (!fieldNames.has(field.name)) {
      throw new Error(
        `Created table ${created.tableName} is missing field ${field.name}`,
      );
    }
  }
  if (fields.length !== config.fields.length) {
    throw new Error(
      `Created table ${created.tableName} has ${fields.length} fields, expected ${config.fields.length}`,
    );
  }

  const views = await getViews(created.tableId);
  if (views.length < 1) {
    throw new Error(`Created table ${created.tableName} has no view`);
  }

  const records = await getRecords(created.tableId, { skip: 0, take: 10 });
  if (records.records.length !== 0) {
    throw new Error(
      `Created table ${created.tableName} should be empty, got ${records.records.length} records`,
    );
  }

  return {
    tableId: created.tableId,
    fieldCount: fields.length,
    viewCount: views.length,
    recordCount: records.records.length,
  };
};

export const runTableCreateCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as TableCreateCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const runTag = `${context.engine}-${Date.now()}`;
  const createdTables: CreatedTable[] = [];
  let primaryMeasurement: Measurement<unknown> | undefined;
  let verifyMeasurement: Measurement<TableVerification[]> | undefined;

  const buildResult = (error?: unknown): PerfRunResult => {
    const durations = createdTables.map((table) => table.durationMs);
    const requestSummary = durations.length
      ? summarizeDurations(durations)
      : undefined;
    const v2Headers = [
      ...new Set(
        createdTables.map((table) => table.responseHeaders["x-teable-v2"]),
      ),
    ];

    return {
      metrics: {
        ...(primaryMeasurement
          ? { [config.threshold.metric]: primaryMeasurement.durationMs }
          : {}),
        ...(requestSummary
          ? {
              createTableMinMs: requestSummary.minMs,
              createTableP50Ms: requestSummary.p50Ms,
              createTableP95Ms: requestSummary.p95Ms,
              createTableMaxMs: requestSummary.maxMs,
            }
          : {}),
        ...(verifyMeasurement
          ? { createTablesVerifyMs: verifyMeasurement.durationMs }
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
        ...(primaryMeasurement
          ? [
              {
                name: primaryMeasurement.name,
                durationMs: primaryMeasurement.durationMs,
              },
            ]
          : []),
        ...(verifyMeasurement
          ? [
              {
                name: verifyMeasurement.name,
                durationMs: verifyMeasurement.durationMs,
              },
            ]
          : []),
      ],
      details: {
        tableCount: config.tableCount,
        fieldCount: config.fields.length,
        emptyRecordsPayload: true,
        createdTables: createdTables.map((table) => ({
          index: table.index,
          tableId: table.tableId,
          tableName: table.tableName,
          status: table.status,
          durationMs: table.durationMs,
          responseHeaders: table.responseHeaders,
        })),
        routing: createdTables.length
          ? {
              routeMatched: createdTables.every(
                (table) =>
                  table.responseHeaders["x-teable-v2-feature"] ===
                  "createTable",
              ),
              consistentEngine: v2Headers.length === 1,
              requestedEngine: process.env.PERF_LAB_ENGINE ?? "local",
              actualV2Header: v2Headers.length === 1 ? v2Headers[0] : undefined,
              actualV2Headers: v2Headers,
              feature: createdTables[0]?.responseHeaders["x-teable-v2-feature"],
              reason: createdTables[0]?.responseHeaders["x-teable-v2-reason"],
            }
          : undefined,
        verification: verifyMeasurement
          ? {
              metric: "createTablesVerifyMs",
              participatesInThreshold: false,
              tables: verifyMeasurement.result,
            }
          : undefined,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
              }
            : undefined,
      },
    };
  };

  try {
    try {
      primaryMeasurement = await measureAsync("createTablesTotal", async () => {
        for (let index = 1; index <= config.tableCount; index += 1) {
          const tableName = `${config.tableNamePrefix}-${runTag}-${padIndex(
            index,
          )}`;
          const requestMeasurement = await withPerfTraceStep(
            context,
            perfCase,
            `createTable-${padIndex(index)}`,
            () =>
              measureAsync(`createTable-${padIndex(index)}`, () =>
                createOneTable(baseId, tableName, config),
              ),
          );
          createdTables.push({
            index,
            tableId: requestMeasurement.result.data.id,
            tableName,
            status: requestMeasurement.result.status,
            durationMs: requestMeasurement.durationMs,
            responseHeaders: pickTableLifecycleHeaders(
              requestMeasurement.result.headers as Record<string, unknown>,
            ),
          });
        }
      });

      verifyMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        "createTablesVerify",
        () =>
          measureAsync("createTablesVerify", async () => {
            const verifications: TableVerification[] = [];
            for (const created of createdTables) {
              verifications.push(await verifyCreatedTable(created, config));
            }
            return verifications;
          }),
      );

      const engines = new Set(
        createdTables.map((table) => table.responseHeaders["x-teable-v2"]),
      );
      if (engines.size > 1) {
        throw new Error(
          `createTable requests routed to mixed engines: ${[...engines].join(
            ", ",
          )}`,
        );
      }
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildResult(error),
      );
    }

    return buildResult();
  } finally {
    // CI execute jobs run on an isolated restored copy of the seed dump, so
    // the mutated database is simply discarded after the job.
    if (!isExecuteDbIsolated()) {
      for (const created of createdTables) {
        try {
          await permanentDeleteTable(baseId, created.tableId);
        } catch (error) {
          console.warn(
            `Failed to cleanup created perf table ${created.tableId}`,
            error,
          );
        }
      }
    }
  }
};
