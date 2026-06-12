import { FieldType } from "@teable/core";
import { axios } from "@teable/openapi";
import {
  getFields,
  getRecords,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, summarizeDurations } from "../metrics";
import { assertEngineRouting, type EngineRouting } from "../routing";
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
  routing: EngineRouting;
};

type TableVerification = {
  tableId: string;
  fieldCount: number;
  viewCount: number;
  recordCount: number;
};

const padIndex = (index: number) => String(index).padStart(2, "0");

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

// Inline records ride the createTable request body, which performs no
// typecast, so every generated value must already be natively valid for its
// field type (full ISO datetimes, exact select choice names, checkbox
// true/null instead of false).
const inlineCellValue = (
  field: TableCreateCaseConfig["fields"][number],
  rowNumber: number,
  titlePrefix: string,
): unknown => {
  const padded = padRowNumber(rowNumber);
  const choices =
    (field.options as { choices?: Array<{ name: string }> } | undefined)
      ?.choices ?? [];

  switch (field.type) {
    case FieldType.SingleLineText:
    case FieldType.LongText:
      return `${titlePrefix} ${field.name} ${padded}`;
    case FieldType.Number:
      return rowNumber;
    case FieldType.Checkbox:
      return rowNumber % 2 === 1 ? true : null;
    case FieldType.Rating:
      return ((rowNumber - 1) % 5) + 1;
    case FieldType.SingleSelect:
      return choices.length
        ? choices[(rowNumber - 1) % choices.length].name
        : null;
    case FieldType.MultipleSelect:
      return choices.length
        ? [choices[(rowNumber - 1) % choices.length].name]
        : null;
    case FieldType.Date:
      return new Date(
        Date.UTC(2026, 0, 1 + ((rowNumber - 1) % 365)),
      ).toISOString();
    default:
      return null;
  }
};

const buildInlineRecords = (config: TableCreateCaseConfig) => {
  const inline = config.inlineRecords;
  if (!inline) {
    return [];
  }
  return Array.from({ length: inline.count }, (_, index) => {
    const rowNumber = index + 1;
    return {
      fields: Object.fromEntries(
        config.fields
          .map((field): [string, unknown] => [
            field.name,
            inlineCellValue(field, rowNumber, inline.titlePrefix),
          ])
          .filter(([, value]) => value !== null),
      ),
    };
  });
};

const createOneTable = async (
  baseId: string,
  tableName: string,
  config: TableCreateCaseConfig,
) => {
  const response = await axios.post(`/base/${baseId}/table`, {
    name: tableName,
    fields: config.fields,
    records: buildInlineRecords(config),
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

  const expectedRecordCount = config.inlineRecords?.count ?? 0;
  let recordCount = 0;
  if (expectedRecordCount === 0) {
    const records = await getRecords(created.tableId, { skip: 0, take: 10 });
    if (records.records.length !== 0) {
      throw new Error(
        `Created table ${created.tableName} should be empty, got ${records.records.length} records`,
      );
    }
  } else {
    const pageSize = 1_000;
    for (let skip = 0; skip < expectedRecordCount; skip += pageSize) {
      const expectedTake = Math.min(pageSize, expectedRecordCount - skip);
      const result = await getRecords(created.tableId, {
        skip,
        take: expectedTake,
      });
      if (result.records.length !== expectedTake) {
        throw new Error(
          `Created table ${created.tableName}: expected ${expectedTake} records at skip ${skip}, got ${result.records.length}`,
        );
      }
      recordCount += result.records.length;
    }

    // Sample value evidence on text fields (format-stable across engines).
    const inline = config.inlineRecords!;
    const textFieldNames = config.fields
      .filter((field) => field.type === FieldType.SingleLineText)
      .map((field) => field.name)
      .slice(0, 2);
    for (const rowOffset of [0, expectedRecordCount - 1]) {
      const rowNumber = rowOffset + 1;
      const result = await getRecords(created.tableId, {
        skip: rowOffset,
        take: 1,
      });
      const record = result.records[0];
      if (!record) {
        throw new Error(
          `Created table ${created.tableName}: inline record at offset ${rowOffset} not found`,
        );
      }
      for (const fieldName of textFieldNames) {
        const expected = `${inline.titlePrefix} ${fieldName} ${padRowNumber(rowNumber)}`;
        const actual = record.fields[fieldName];
        if (actual !== expected) {
          throw new Error(
            `Created table ${created.tableName} row ${rowNumber} ${fieldName} mismatch: expected ${expected}, actual ${String(actual)}`,
          );
        }
      }
    }
  }

  return {
    tableId: created.tableId,
    fieldCount: fields.length,
    viewCount: views.length,
    recordCount,
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
        emptyRecordsPayload: !config.inlineRecords,
        inlineRecordCount: config.inlineRecords?.count ?? 0,
        createdTables: createdTables.map((table) => ({
          index: table.index,
          tableId: table.tableId,
          tableName: table.tableName,
          status: table.status,
          durationMs: table.durationMs,
          responseHeaders: table.responseHeaders,
          routing: table.routing,
        })),
        routing: createdTables.length
          ? {
              routeMatched: createdTables.every(
                (table) => table.routing.routeMatched === true,
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
          const responseHeaders = pickTableLifecycleHeaders(
            requestMeasurement.result.headers as Record<string, unknown>,
          );
          createdTables.push({
            index,
            tableId: requestMeasurement.result.data.id,
            tableName,
            status: requestMeasurement.result.status,
            durationMs: requestMeasurement.durationMs,
            responseHeaders,
            routing: assertEngineRouting(context, responseHeaders, {
              feature: "createTable",
              operation: "createTable",
            }),
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
