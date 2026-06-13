import { performance } from "node:perf_hooks";
import { FieldKeyType, FieldType, ViewType } from "@teable/core";
import { formSubmit } from "@teable/openapi";
import {
  createTable,
  createView,
  getFields,
  getRecords,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, roundMetric, summarizeDurations } from "../metrics";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import { withPerfTraceStep } from "../trace-collector";
import type {
  FormSubmitCaseConfig,
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

type NamedField = {
  id: string;
  name: string;
  options?: unknown;
};

type FormSubmitField = FormSubmitCaseConfig["fields"][number] & {
  id: string;
  name: string;
};

type ExpectedCellValue = string | number | boolean | string[] | null;

type FormSubmitPayload = {
  fields: Record<string, ExpectedCellValue>;
};

type SelectChoice = {
  id?: string;
  name: string;
};

type FormSubmitFixture = {
  tableId: string;
  tableName: string;
  formViewId: string;
  fields: FormSubmitField[];
  projection: string[];
};

type SubmitDetail = {
  iteration: number;
  durationMs: number;
  status: number;
  recordId: string;
  responseHeaders?: ReturnType<typeof pickRoutingResponseHeaders>;
  routing?: EngineRouting;
};

type SubmitPrimaryResult = {
  samples: SubmitDetail[];
  summary: ReturnType<typeof summarizeDurations>;
  routing: {
    first?: EngineRouting;
    last?: EngineRouting;
  };
};

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const fieldNameKey = (fieldName: string) => fieldName.replace(/\s+/g, "-");

const dateOnlyForRow = (rowNumber: number, offsetDays = 0) => {
  const date = new Date(
    Date.UTC(2026, 0, 1 + offsetDays + ((rowNumber - 1) % 365)),
  );
  return date.toISOString().slice(0, 10);
};

const dateIsoForRow = (rowNumber: number, offsetDays = 0) =>
  `${dateOnlyForRow(rowNumber, offsetDays)}T00:00:00.000Z`;

const selectChoices = (field: FormSubmitCaseConfig["fields"][number]) =>
  (
    field.options as
      | {
          choices?: SelectChoice[];
        }
      | undefined
  )?.choices ?? [];

const ratingMax = (field: FormSubmitCaseConfig["fields"][number]) =>
  (
    field.options as
      | {
          max?: number;
        }
      | undefined
  )?.max ?? 5;

const getSelectChoice = (
  field: FormSubmitCaseConfig["fields"][number],
  rowNumber: number,
) => {
  const choices = selectChoices(field);
  if (choices.length === 0) {
    throw new Error(`Select field ${field.name} has no choices`);
  }
  return choices[(rowNumber - 1) % choices.length].name;
};

const getMultiSelectChoices = (
  field: FormSubmitCaseConfig["fields"][number],
  rowNumber: number,
) => {
  const choices = selectChoices(field);
  if (choices.length === 0) {
    throw new Error(`Multiple select field ${field.name} has no choices`);
  }
  const first = choices[(rowNumber - 1) % choices.length].name;
  const second = choices[rowNumber % choices.length].name;
  return first === second ? [first] : [first, second];
};

const getExpectedValue = (
  field: FormSubmitCaseConfig["fields"][number],
  rowNumber: number,
  config: FormSubmitCaseConfig,
): ExpectedCellValue => {
  const padded = padRowNumber(rowNumber);

  switch (field.name) {
    case "Title":
      return `${config.generator.titlePrefix} ${padded}`;
    case "Description":
    case "Notes":
    case "Comment":
      return `${config.generator.payloadPrefix}-${padded}-${fieldNameKey(
        field.name,
      )}-payload`;
    case "Owner Text":
    case "External ID":
    case "Source":
      return `${config.generator.valuePrefix}-${padded}-${fieldNameKey(
        field.name,
      )}`;
  }

  switch (field.type) {
    case FieldType.SingleSelect:
      return getSelectChoice(field, rowNumber);
    case FieldType.MultipleSelect:
      return getMultiSelectChoices(field, rowNumber);
    case FieldType.Number:
      if (field.name === "Amount") {
        return Number((rowNumber * 7 + 0.25).toFixed(2));
      }
      if (field.name === "Quantity") {
        return rowNumber * 3;
      }
      if (field.name === "Percent") {
        return Number(((rowNumber % 100) / 100).toFixed(2));
      }
      return rowNumber;
    case FieldType.Date:
      return dateIsoForRow(
        rowNumber,
        field.name.toLowerCase().includes("due") ? 7 : 0,
      );
    case FieldType.Checkbox:
      return rowNumber % 2 === 1 ? true : null;
    case FieldType.Rating:
      return ((rowNumber - 1) % ratingMax(field)) + 1;
    default:
      return `${config.generator.valuePrefix}-${padded}-${fieldNameKey(
        field.name,
      )}`;
  }
};

const buildSubmitPayload = (
  fields: FormSubmitField[],
  rowNumber: number,
  config: FormSubmitCaseConfig,
): FormSubmitPayload => ({
  fields: Object.fromEntries(
    fields.map((field) => [
      field.id,
      getExpectedValue(field, rowNumber, config),
    ]),
  ),
});

const resolveFormSubmitFields = (
  fields: NamedField[],
  config: FormSubmitCaseConfig,
): FormSubmitField[] => {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  return config.fields.map((field) => {
    const resolvedField = fieldByName.get(field.name);
    if (!resolvedField) {
      throw new Error(
        `Missing form submit field ${field.name}; available fields: ${fields
          .map(({ name }) => name)
          .join(", ")}`,
      );
    }
    return {
      ...field,
      options: resolvedField.options ?? field.options,
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
  field: FormSubmitField,
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

const assertSubmittedRow = (
  rowNumber: number,
  fields: FormSubmitField[],
  recordFields: Record<string, unknown>,
  config: FormSubmitCaseConfig,
) => {
  const actual: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};

  for (const field of fields) {
    const expectedValue = getExpectedValue(field, rowNumber, config);
    const actualValue = recordFields[field.id];
    actual[field.name] = actualValue;
    expected[field.name] = expectedValue;

    if (!valuesMatch(expectedValue, actualValue, field)) {
      throw new Error(
        `Form submit row ${rowNumber} ${field.name} mismatch: expected ${String(
          expectedValue,
        )}, actual ${String(actualValue)}`,
      );
    }
  }

  return { actual, expected };
};

const prepareFormSubmitFixture = async (
  baseId: string,
  tableName: string,
  config: FormSubmitCaseConfig,
): Promise<FormSubmitFixture> => {
  const table = await createTable(baseId, {
    name: tableName,
    fields: config.fields,
    records: [],
  });
  const tableFields = await getFields(table.id);
  const fields = resolveFormSubmitFields(tableFields, config);
  const formView = await createView(table.id, {
    type: ViewType.Form,
    name: `${tableName}-form`,
  });

  return {
    tableId: table.id,
    tableName,
    formViewId: formView.id,
    fields,
    projection: fields.map((field) => field.id),
  };
};

const submitRecordsSequentially = async (
  fixture: FormSubmitFixture,
  config: FormSubmitCaseConfig,
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<SubmitPrimaryResult> => {
  const samples: SubmitDetail[] = [];
  let firstRouting: EngineRouting | undefined;
  let lastRouting: EngineRouting | undefined;

  for (let iteration = 1; iteration <= config.rowCount; iteration += 1) {
    const startedAt = performance.now();
    const response = await withPerfTraceStep(
      context,
      perfCase,
      `${config.threshold.metric}:${iteration}`,
      () =>
        formSubmit(fixture.tableId, {
          viewId: fixture.formViewId,
          fields: buildSubmitPayload(fixture.fields, iteration, config).fields,
          typecast: true,
        }),
    );
    const durationMs = roundMetric(performance.now() - startedAt);
    expect(response.status).toBe(201);

    const detail: SubmitDetail = {
      iteration,
      durationMs,
      status: response.status,
      recordId: response.data.id,
    };

    if (iteration === 1 || iteration === config.rowCount) {
      const responseHeaders = pickRoutingResponseHeaders(
        response.headers as Record<string, unknown>,
      );
      const routing = assertEngineRouting(context, responseHeaders, {
        feature: "formSubmit",
        operation: "formSubmit",
      });
      detail.responseHeaders = responseHeaders;
      detail.routing = routing;
      if (iteration === 1) {
        firstRouting = routing;
      } else {
        lastRouting = routing;
      }
    }

    const expectedFields = buildSubmitPayload(
      fixture.fields,
      iteration,
      config,
    ).fields;
    for (const field of fixture.fields) {
      const actualValue = response.data.fields[field.id];
      const expectedValue = expectedFields[field.id];
      if (!valuesMatch(expectedValue, actualValue, field)) {
        throw new Error(
          `Form submit response row ${iteration} ${field.name} mismatch: expected ${String(
            expectedValue,
          )}, actual ${String(actualValue)}`,
        );
      }
    }

    samples.push(detail);
  }

  return {
    samples,
    summary: summarizeDurations(samples.map((sample) => sample.durationMs)),
    routing: {
      first: firstRouting,
      last: lastRouting,
    },
  };
};

const assertSubmittedRows = async (
  fixture: FormSubmitFixture,
  config: FormSubmitCaseConfig,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const sampleRowOffsets = new Set(config.verify.sampleRows);
  const verifiedSamples = [];
  let scannedRecords = 0;
  let pageCount = 0;

  for (let skip = 0; skip < config.rowCount; skip += pageSize) {
    const expectedTake = Math.min(pageSize, config.rowCount - skip);
    const result = await getRecords(fixture.tableId, {
      viewId: fixture.formViewId,
      fieldKeyType: FieldKeyType.Id,
      projection: fixture.projection,
      skip,
      take: expectedTake,
    });
    pageCount += 1;

    if (result.records.length !== expectedTake) {
      throw new Error(
        `Expected ${expectedTake} submitted records at skip ${skip}, got ${result.records.length}`,
      );
    }

    for (const [index, record] of result.records.entries()) {
      const rowNumber = skip + index + 1;
      const verifiedRow = assertSubmittedRow(
        rowNumber,
        fixture.fields,
        record.fields,
        config,
      );
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
      `Submitted row count mismatch: expected ${config.rowCount}, scanned ${scannedRecords}`,
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

const buildFormSubmitCaseResult = ({
  config,
  prepareMeasurement,
  primaryMeasurement,
  verificationMeasurement,
  error,
}: {
  config: FormSubmitCaseConfig;
  prepareMeasurement?: Measurement<FormSubmitFixture>;
  primaryMeasurement?: Measurement<SubmitPrimaryResult>;
  verificationMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertSubmittedRows>>
  >;
  error?: unknown;
}): PerfRunResult => {
  const fixture = prepareMeasurement?.result;
  const primary = primaryMeasurement?.result;

  return {
    metrics: {
      ...(prepareMeasurement
        ? { formSubmitPrepareMs: prepareMeasurement.durationMs }
        : {}),
      ...(primary
        ? {
            formSubmitP95Ms: primary.summary.p95Ms,
            formSubmitTotalMs: roundMetric(
              primary.samples.reduce(
                (total, sample) => total + sample.durationMs,
                0,
              ),
            ),
            formSubmitMaxMs: primary.summary.maxMs,
          }
        : {}),
      ...(verificationMeasurement
        ? { formSubmitVerifyMs: verificationMeasurement.durationMs }
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
      ...(primaryMeasurement
        ? [
            {
              name: primaryMeasurement.name,
              durationMs: primaryMeasurement.durationMs,
            },
          ]
        : []),
      ...(verificationMeasurement
        ? [
            {
              name: verificationMeasurement.name,
              durationMs: verificationMeasurement.durationMs,
            },
          ]
        : []),
    ],
    details: {
      tableId: fixture?.tableId,
      tableName: fixture?.tableName,
      formViewId: fixture?.formViewId,
      rowCount: config.rowCount,
      fieldCount: config.fields.length,
      fields: fixture?.fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
      })),
      prepare: fixture
        ? {
            durationMs: prepareMeasurement.durationMs,
            tableShape: `empty ${fixture.fields.length}-field table with Form view`,
            createdBeforeMetric: true,
            cached: false,
          }
        : undefined,
      submit: primary
        ? {
            samples: primary.samples.length,
            summary: primary.summary,
            firstSample: primary.samples[0],
            middleSample:
              primary.samples[Math.floor(primary.samples.length / 2)],
            lastSample: primary.samples[primary.samples.length - 1],
            routing: primary.routing,
          }
        : undefined,
      routing: primary?.routing.last ?? primary?.routing.first,
      verification: verificationMeasurement
        ? {
            scannedRecords: verificationMeasurement.result.scannedRecords,
            pageSize: verificationMeasurement.result.pageSize,
            pageCount: verificationMeasurement.result.pageCount,
            valuesMatched: true,
            durationMs: verificationMeasurement.durationMs,
          }
        : undefined,
      verifiedSamples: verificationMeasurement?.result.verifiedSamples,
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

export const runFormSubmitCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as FormSubmitCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  let prepareMeasurement: Measurement<FormSubmitFixture> | undefined;
  let primaryMeasurement: Measurement<SubmitPrimaryResult> | undefined;
  let verificationMeasurement:
    | Measurement<Awaited<ReturnType<typeof assertSubmittedRows>>>
    | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareFormSubmitFixture(baseId, tableName, config),
    );

    try {
      primaryMeasurement = await measureAsync(config.threshold.metric, () =>
        submitRecordsSequentially(
          prepareMeasurement!.result,
          config,
          perfCase,
          context,
        ),
      );
      verificationMeasurement = await measureAsync("verifySubmittedRows", () =>
        assertSubmittedRows(prepareMeasurement!.result, config),
      );
    } catch (error) {
      const diagnosticResult = buildFormSubmitCaseResult({
        config,
        prepareMeasurement,
        primaryMeasurement,
        verificationMeasurement,
        error,
      });

      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        diagnosticResult,
      );
    }

    return buildFormSubmitCaseResult({
      config,
      prepareMeasurement,
      primaryMeasurement,
      verificationMeasurement,
    });
  } finally {
    if (isExecuteDbIsolated()) {
      // CI execute jobs run on a disposable restored DB copy; the temporary
      // form table is discarded with the database.
    } else if (prepareMeasurement?.result.tableId) {
      try {
        await permanentDeleteTable(baseId, prepareMeasurement.result.tableId);
      } catch (error) {
        console.warn(
          `Failed to cleanup perf form submit table ${prepareMeasurement.result.tableId}`,
          error,
        );
      }
    }
  }
};

export const seedFormSubmitCase = async (
  perfCase: PerfCase,
  _context: PerfRunContext,
): Promise<PerfRunResult> => ({
  result: "skipped",
  metrics: {},
  thresholds: [],
  details: {
    skipped: true,
    reason: "This runner builds a fresh Form view table during execute.",
    runner: perfCase.runner,
  },
});
