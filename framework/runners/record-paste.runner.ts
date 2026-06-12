import { FieldKeyType, FieldType } from "@teable/core";
import { paste } from "@teable/openapi";
import {
  createTable,
  getFields,
  getRecords,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync } from "../metrics";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordPasteCaseConfig,
} from "../types";
import { PerfRunDiagnosticError } from "../types";

type Measurement<T> = {
  name: string;
  durationMs: number;
  result: T;
};

type NamedField = {
  id: string;
  name: string;
};

type PasteField = RecordPasteCaseConfig["fields"][number] & {
  id: string;
  name: string;
};

type ExpectedCellValue = string | number | boolean | string[] | null;

type PasteFixture = {
  tableId: string;
  tableName: string;
  viewId: string;
  pasteFields: PasteField[];
  projection: string[];
  content: string;
};

type PastePrimaryResult = Awaited<ReturnType<typeof paste>> & {
  responseHeaders: ReturnType<typeof pickRoutingResponseHeaders>;
  routing: EngineRouting;
};

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const fieldNameKey = (fieldName: string) => fieldName.replace(/\s+/g, "-");

const selectChoices = (field: RecordPasteCaseConfig["fields"][number]) =>
  (
    field.options as
      | {
          choices?: Array<{ name: string }>;
        }
      | undefined
  )?.choices ?? [];

const ratingMax = (field: RecordPasteCaseConfig["fields"][number]) =>
  (
    field.options as
      | {
          max?: number;
        }
      | undefined
  )?.max ?? 5;

const dateOnlyForRow = (rowNumber: number, offsetDays = 0) => {
  const date = new Date(
    Date.UTC(2026, 0, 1 + offsetDays + ((rowNumber - 1) % 365)),
  );
  return date.toISOString().slice(0, 10);
};

const dateIsoForRow = (rowNumber: number, offsetDays = 0) =>
  `${dateOnlyForRow(rowNumber, offsetDays)}T00:00:00.000Z`;

const getGroupValue = (rowNumber: number, config: RecordPasteCaseConfig) => {
  const group =
    config.generator.groups?.[(rowNumber - 1) % config.generator.groups.length];
  if (!group) {
    throw new Error(
      "Record paste generator must define at least one group for Group fields",
    );
  }
  return group;
};

const getExpectedCellValue = (
  field: RecordPasteCaseConfig["fields"][number],
  rowNumber: number,
  config: RecordPasteCaseConfig,
): ExpectedCellValue => {
  const fieldName = field.name;
  const padded = padRowNumber(rowNumber);
  if (fieldName === "Name") {
    return `${config.generator.titlePrefix} ${padded}`;
  }
  if (fieldName === "Title") {
    return `${config.generator.titlePrefix} ${padded}`;
  }
  if (fieldName === "Index") {
    return rowNumber;
  }
  if (fieldName === "Group") {
    return getGroupValue(rowNumber, config);
  }
  if (fieldName === "Payload") {
    return `${config.generator.payloadPrefix ?? "payload"}-${padded}-${getGroupValue(
      rowNumber,
      config,
    )}`;
  }

  switch (field.type) {
    case FieldType.SingleLineText:
      return `${config.generator.valuePrefix ?? "Cell"}-${padded}-${fieldNameKey(
        fieldName,
      )}`;
    case FieldType.LongText:
      return `${config.generator.payloadPrefix ?? "long"}-${padded}-${fieldNameKey(
        fieldName,
      )}-paste-payload`;
    case FieldType.Number:
      return Number(
        (rowNumber * ((fieldName.length % 7) + 1) + 0.25).toFixed(2),
      );
    case FieldType.SingleSelect: {
      const choices = selectChoices(field);
      if (choices.length === 0) {
        throw new Error(`Single select field ${fieldName} has no choices`);
      }
      return choices[(rowNumber - 1) % choices.length].name;
    }
    case FieldType.MultipleSelect: {
      const choices = selectChoices(field);
      if (choices.length === 0) {
        throw new Error(`Multiple select field ${fieldName} has no choices`);
      }
      const first = choices[(rowNumber - 1) % choices.length].name;
      const second = choices[rowNumber % choices.length].name;
      return first === second ? [first] : [first, second];
    }
    case FieldType.Date:
      return dateIsoForRow(
        rowNumber,
        fieldName.toLowerCase().includes("due") ? 7 : 0,
      );
    case FieldType.Checkbox:
      return rowNumber % 2 === 1 ? true : null;
    case FieldType.Rating:
      return ((rowNumber - 1) % ratingMax(field)) + 1;
    default:
      return `${config.generator.valuePrefix ?? "Cell"}-${padded}-${fieldNameKey(
        fieldName,
      )}`;
  }
};

const getClipboardCellValue = (
  field: RecordPasteCaseConfig["fields"][number],
  rowNumber: number,
  config: RecordPasteCaseConfig,
) => {
  if (field.type === FieldType.Date) {
    return dateOnlyForRow(
      rowNumber,
      field.name.toLowerCase().includes("due") ? 7 : 0,
    );
  }

  const expectedValue = getExpectedCellValue(field, rowNumber, config);
  if (Array.isArray(expectedValue)) {
    return expectedValue.join(", ");
  }
  if (expectedValue == null) {
    return "";
  }
  return String(expectedValue);
};

const buildPasteContent = (config: RecordPasteCaseConfig) =>
  Array.from({ length: config.rowCount }, (_, index) => {
    const rowNumber = index + 1;
    return config.fields
      .map((field) => getClipboardCellValue(field, rowNumber, config))
      .join("\t");
  }).join("\n");

const resolvePasteFields = (
  fields: NamedField[],
  config: RecordPasteCaseConfig,
): PasteField[] => {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  return config.fields.map((field) => {
    const resolvedField = fieldByName.get(field.name);
    if (!resolvedField) {
      throw new Error(
        `Missing paste field ${field.name}; available fields: ${fields
          .map(({ name }) => name)
          .join(", ")}`,
      );
    }
    return {
      ...field,
      id: resolvedField.id,
      name: resolvedField.name,
    };
  });
};

const normalizeMultiSelectValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
};

const valuesMatch = (
  expectedValue: ExpectedCellValue,
  actualValue: unknown,
  field: PasteField,
) => {
  if (expectedValue == null) {
    return actualValue == null;
  }

  if (Array.isArray(expectedValue)) {
    return (
      JSON.stringify(normalizeMultiSelectValue(actualValue)) ===
      JSON.stringify(expectedValue)
    );
  }

  if (typeof expectedValue === "number") {
    return Number(actualValue) === expectedValue;
  }

  if (typeof expectedValue === "boolean") {
    return actualValue === expectedValue;
  }

  if (field.type === FieldType.Date) {
    return (
      typeof actualValue === "string" &&
      new Date(actualValue).toISOString() === expectedValue
    );
  }

  return actualValue === expectedValue;
};

const assertRow = (
  rowNumber: number,
  fields: PasteField[],
  recordFields: Record<string, unknown>,
  config: RecordPasteCaseConfig,
) => {
  const actual: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};

  for (const field of fields) {
    const expectedValue = getExpectedCellValue(field, rowNumber, config);
    const actualValue = recordFields[field.id];
    actual[field.name] = actualValue;
    expected[field.name] = expectedValue;

    if (!valuesMatch(expectedValue, actualValue, field)) {
      throw new Error(
        `Row ${rowNumber} ${field.name} mismatch: expected ${String(
          expectedValue,
        )}, actual ${String(actualValue)}`,
      );
    }
  }

  return { actual, expected };
};

const assertPasteResponseRange = (
  actualRanges: unknown,
  config: RecordPasteCaseConfig,
  fieldCount: number,
) => {
  const expectedRanges = [
    [0, 0],
    [fieldCount - 1, config.rowCount - 1],
  ];

  if (JSON.stringify(actualRanges) !== JSON.stringify(expectedRanges)) {
    throw new Error(
      `Paste response range mismatch: expected ${JSON.stringify(
        expectedRanges,
      )}, actual ${JSON.stringify(actualRanges)}`,
    );
  }
};

const assertPastedRows = async (
  tableId: string,
  viewId: string,
  fields: PasteField[],
  projection: string[],
  config: RecordPasteCaseConfig,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleRowOffsets = new Set(config.verify.sampleRows);
  const verifiedSamples = [];
  let scannedRecords = 0;
  let pageCount = 0;

  for (let skip = 0; skip < config.rowCount; skip += pageSize) {
    const expectedTake = Math.min(pageSize, config.rowCount - skip);
    const result = await getRecords(tableId, {
      viewId,
      fieldKeyType: FieldKeyType.Id,
      projection,
      skip,
      take: expectedTake,
    });
    pageCount += 1;

    if (result.records.length !== expectedTake) {
      throw new Error(
        `Expected ${expectedTake} pasted records at skip ${skip}, got ${result.records.length}`,
      );
    }

    for (const [index, record] of result.records.entries()) {
      const rowNumber = skip + index + 1;
      const verifiedRow = assertRow(rowNumber, fields, record.fields, config);
      const rowOffset = rowNumber - 1;

      if (sampleRowOffsets.has(rowOffset)) {
        verifiedSamples.push({
          rowOffset,
          rowNumber,
          recordId: record.id,
          ...verifiedRow,
        });
      }

      scannedRecords += 1;
    }
  }

  if (scannedRecords !== config.rowCount) {
    throw new Error(
      `Pasted row count mismatch: expected ${config.rowCount}, scanned ${scannedRecords}`,
    );
  }

  return {
    scannedRecords,
    pageSize,
    pageCount,
    verifiedSamples: verifiedSamples.sort(
      (left, right) => left.rowOffset - right.rowOffset,
    ),
  };
};

const preparePasteFixture = async (
  baseId: string,
  tableName: string,
  config: RecordPasteCaseConfig,
): Promise<PasteFixture> => {
  const table = await createTable(baseId, {
    name: tableName,
    fields: config.fields,
    records: [],
  });
  const tableFields = await getFields(table.id);
  const views = await getViews(table.id);
  const viewId = views[0]?.id;

  if (!viewId) {
    throw new Error(`No grid view found for record paste table ${table.id}`);
  }

  const pasteFields = resolvePasteFields(tableFields, config);
  const projection = pasteFields.map((field) => field.id);

  return {
    tableId: table.id,
    tableName,
    viewId,
    pasteFields,
    projection,
    content: buildPasteContent(config),
  };
};

const buildRecordPasteCaseResult = ({
  config,
  prepareMeasurement,
  pasteMeasurement,
  verifiedRows,
  error,
}: {
  config: RecordPasteCaseConfig;
  prepareMeasurement?: Measurement<PasteFixture>;
  pasteMeasurement?: Measurement<PastePrimaryResult>;
  verifiedRows?: Awaited<ReturnType<typeof assertPastedRows>>;
  error?: unknown;
}): PerfRunResult => {
  const prepared = prepareMeasurement?.result;

  return {
    metrics: {
      ...(pasteMeasurement ? { paste10kMs: pasteMeasurement.durationMs } : {}),
    },
    thresholds: pasteMeasurement
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
      ...(pasteMeasurement
        ? [
            {
              name: pasteMeasurement.name,
              durationMs: pasteMeasurement.durationMs,
            },
          ]
        : []),
    ],
    details: {
      tableId: prepared?.tableId,
      tableName: prepared?.tableName,
      viewId: prepared?.viewId,
      rowCount: config.rowCount,
      fields: prepared?.pasteFields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
      })),
      prepare: prepared
        ? {
            durationMs: prepareMeasurement.durationMs,
            tableShape: `empty ${prepared.pasteFields.length}-field table`,
            contentRows: config.rowCount,
            contentCells: config.rowCount * prepared.pasteFields.length,
            maxPasteCells: config.maxPasteCells,
            preparedBeforeMetric: true,
          }
        : undefined,
      paste: pasteMeasurement
        ? {
            status: pasteMeasurement.result.status,
            ranges: pasteMeasurement.result.data.ranges,
            responseHeaders: pasteMeasurement.result.responseHeaders,
            routing: pasteMeasurement.result.routing,
          }
        : undefined,
      routing: pasteMeasurement?.result.routing,
      fullScan: verifiedRows
        ? {
            scannedRecords: verifiedRows.scannedRecords,
            pageSize: verifiedRows.pageSize,
            pageCount: verifiedRows.pageCount,
          }
        : undefined,
      verifiedSamples: verifiedRows?.verifiedSamples,
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

export const runRecordPasteCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as RecordPasteCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  let prepareMeasurement: Measurement<PasteFixture> | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      preparePasteFixture(baseId, tableName, config),
    );
    const prepared = prepareMeasurement.result;
    let pasteMeasurement: Measurement<PastePrimaryResult> | undefined;
    let verifiedRows: Awaited<ReturnType<typeof assertPastedRows>> | undefined;

    try {
      pasteMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        "paste10k",
        () =>
          measureAsync("paste10k", async () => {
            const response = await paste(prepared.tableId, {
              viewId: prepared.viewId,
              projection: prepared.projection,
              ranges: [
                [0, 0],
                [0, 0],
              ],
              content: prepared.content,
            });
            expect(response.status).toBe(200);
            assertPasteResponseRange(
              response.data.ranges,
              config,
              prepared.projection.length,
            );
            const responseHeaders = pickRoutingResponseHeaders(
              response.headers as Record<string, unknown>,
            );
            return {
              ...response,
              responseHeaders,
              routing: assertEngineRouting(context, responseHeaders, {
                operation: "pasteRecords",
              }),
            };
          }),
      );

      verifiedRows = await assertPastedRows(
        prepared.tableId,
        prepared.viewId,
        prepared.pasteFields,
        prepared.projection,
        config,
      );
    } catch (error) {
      const diagnosticResult = buildRecordPasteCaseResult({
        config,
        prepareMeasurement,
        pasteMeasurement,
        verifiedRows,
        error,
      });

      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        diagnosticResult,
      );
    }

    return buildRecordPasteCaseResult({
      config,
      prepareMeasurement,
      pasteMeasurement,
      verifiedRows,
    });
  } finally {
    // CI execute jobs run on a disposable restored DB copy; the pasted table
    // is discarded with the database, so only local runs delete it.
    if (prepareMeasurement?.result.tableId && !isExecuteDbIsolated()) {
      try {
        await permanentDeleteTable(baseId, prepareMeasurement.result.tableId);
      } catch (error) {
        console.warn(
          `Failed to cleanup perf table ${prepareMeasurement.result.tableId}`,
          error,
        );
      }
    }
  }
};
