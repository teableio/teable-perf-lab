import { performance } from "node:perf_hooks";
import { FieldKeyType, FieldType, ViewType } from "@teable/core";
import { formSubmit } from "@teable/openapi";
import {
  createTable,
  createView,
  getFields,
  getRecords,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { forEachRecordPage } from "../record-page-scan";
import {
  measureAsync,
  roundMetric,
  summarizeDurations,
  type Measurement,
} from "../metrics";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  FormSubmitCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  runRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

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
  // The auto-created grid view; submissions go through the form view, but
  // read-back verification scans the grid view (no Form-view ordering contract).
  gridViewId: string;
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

// The single measured window bundles the sequential submit loop with the
// post-submit full-scan verification, so the record-mutation lifecycle driver
// can drive form-submit without owning submit-specific verification. The
// driver's primary measurement keeps the submit-loop timing; the verification
// measurement rides along on its result so buildResult emits the same
// prepare -> formSubmitLoop -> verifySubmittedRows phases as the legacy runner.
type FormSubmitPrimaryResult = SubmitPrimaryResult & {
  verificationMeasurement: Measurement<
    Awaited<ReturnType<typeof assertSubmittedRows>>
  >;
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
    case FieldType.LongText:
      return `${config.generator.payloadPrefix}-${padded}-${fieldNameKey(
        field.name,
      )}-payload`;
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
      new Date(actualValue).toISOString().slice(0, 10) ===
        expectedValue.slice(0, 10)
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
  // Read views before adding the form view, so views[0] is the default grid
  // view created with the table.
  const views = await getViews(table.id);
  const gridView = views[0];
  if (!gridView) {
    throw new Error(`No grid view found for form submit table ${table.id}`);
  }
  const formView = await createView(table.id, {
    type: ViewType.Form,
    name: `${tableName}-form`,
  });

  return {
    tableId: table.id,
    tableName,
    formViewId: formView.id,
    gridViewId: gridView.id,
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
      if (!routing.routeMatched) {
        throw new Error(
          `formSubmit route mismatch: ${JSON.stringify(routing)}`,
        );
      }
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

  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.rowCount,
      pageSize,
      pageNoun: "submitted records",
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          viewId: fixture.gridViewId,
          fieldKeyType: FieldKeyType.Id,
          projection: fixture.projection,
          skip,
          take,
        }),
    },
    (record, rowNumber) => {
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
    },
  );

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

// The single measured window: the sequential submit loop (each submit
// trace-wrapped + routing-asserted inside submitRecordsSequentially) followed
// by the post-submit full-scan verification, bundled into one primary
// measurement. The driver runs no record window for form-submit and does not
// re-measure this.
const runFormSubmitMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: FormSubmitCaseConfig,
  fixture: FormSubmitFixture,
): Promise<Measurement<FormSubmitPrimaryResult>> => {
  const primaryMeasurement = await measureAsync("formSubmitLoop", () =>
    submitRecordsSequentially(fixture, config, perfCase, context),
  );
  const verificationMeasurement = await measureAsync(
    "verifySubmittedRows",
    () => assertSubmittedRows(fixture, config),
  );
  return {
    ...primaryMeasurement,
    result: { ...primaryMeasurement.result, verificationMeasurement },
  };
};

// The Form-view table is single-use scratch (no reusable seed), so cleanup just
// drops it on a shared DB; isolated CI execute DBs are discarded wholesale.
const cleanupFormSubmitFixture = async ({
  baseId,
  fixture,
}: {
  baseId: string;
  fixture: FormSubmitFixture | undefined;
}) => {
  if (isExecuteDbIsolated()) {
    return;
  }
  if (fixture?.tableId) {
    try {
      await permanentDeleteTable(baseId, fixture.tableId);
    } catch (error) {
      console.warn(
        `Failed to cleanup perf form submit table ${fixture.tableId}`,
        error,
      );
    }
  }
};

const formSubmitLifecycleSpec: RecordMutationLifecycleSpec<
  FormSubmitCaseConfig,
  FormSubmitFixture,
  never,
  FormSubmitPrimaryResult
> = {
  // form-submit builds a fresh Form-view table per run and verifies after the
  // submit loop, so it omits useRecordWindow and assertSeedReady; the driver
  // emits no seedReady phase, matching the legacy prepare -> submit -> verify
  // phase order surfaced by buildFormSubmitCaseResult.
  prepareFixture: ({ baseId, tableName, config }) =>
    prepareFormSubmitFixture(baseId, tableName, config),
  runMeasuredOperation: ({ perfCase, context, config, fixture }) =>
    runFormSubmitMeasuredOperation(perfCase, context, config, fixture),
  buildResult: ({ config, prepareMeasurement, primaryMeasurement, error }) =>
    buildFormSubmitCaseResult({
      config,
      prepareMeasurement,
      primaryMeasurement,
      verificationMeasurement:
        primaryMeasurement?.result.verificationMeasurement,
      error,
    }),
  cleanup: cleanupFormSubmitFixture,
};

export const runFormSubmitCase = async (
  perfCase: PerfCaseFor<"form-submit">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, formSubmitLifecycleSpec);

export const seedFormSubmitCase = async (
  perfCase: PerfCaseFor<"form-submit">,
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
