import {
  CellValueType,
  DbFieldType,
  FieldKeyType,
  FieldType,
} from "@teable/core";
import { axios, paste, X_CANARY_HEADER } from "@teable/openapi";
import type {
  IPasteSelectionStreamDoneEvent,
  IPasteSelectionStreamErrorEvent,
  IPasteSelectionStreamEvent,
  IPasteSelectionStreamProgressEvent,
} from "@teable/openapi";
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
import { perfStreamSse } from "../sse";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordPasteCaseConfig,
} from "../types";
import { type Measurement } from "./record-undo-redo.shared";
import {
  runRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

type NamedField = {
  id: string;
  name: string;
};

type PasteHeaderField = Record<string, unknown> & {
  id: string;
  name: string;
  type: string;
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
  seedRowCount: number;
  seedFieldCount: number;
  header: PasteHeaderField[];
};

type PastePrimaryResult = Awaited<ReturnType<typeof paste>> & {
  responseHeaders: ReturnType<typeof pickRoutingResponseHeaders>;
  routing: EngineRouting;
  stream?: {
    done: IPasteSelectionStreamDoneEvent;
    progressEventCount: number;
    errors: IPasteSelectionStreamErrorEvent[];
  };
};

// The single measured window bundles the trace-wrapped paste with the
// post-paste full-scan verification, so the record-mutation lifecycle driver
// can drive record-paste without owning paste-specific verification. The
// driver's primary measurement keeps the paste duration (= the primary metric);
// the verified rows ride along on its result for buildResult to surface.
type RecordPastePrimaryResult = PastePrimaryResult & {
  verifiedRows: Awaited<ReturnType<typeof assertPastedRows>>;
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

const buildSeedRows = (config: RecordPasteCaseConfig) =>
  Array.from({ length: config.seedRowCount ?? 0 }, (_, index) => ({
    fields: Object.fromEntries(
      config.fields
        .slice(0, config.seedFieldCount ?? config.fields.length)
        .map((field) => [
          field.name,
          getExpectedCellValue(field, index + 1, config),
        ]),
    ),
  }));

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

const getStreamHeaders = (context: PerfRunContext) => ({
  "Content-Type": "application/json",
  ...(context.cookie ? { Cookie: context.cookie } : {}),
  [X_CANARY_HEADER]: context.engine === "v2" ? "true" : "false",
});

const assertPasteDoneRange = (
  done: IPasteSelectionStreamDoneEvent,
  config: RecordPasteCaseConfig,
  fieldCount: number,
) => {
  if (done.data.ranges == null) {
    return;
  }

  const expectedRanges = [
    [0, 0],
    [fieldCount - 1, config.rowCount - 1],
  ];
  const actualRanges = done.data.ranges;
  if (JSON.stringify(actualRanges) !== JSON.stringify(expectedRanges)) {
    throw new Error(
      `Paste stream done range mismatch: expected ${JSON.stringify(
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

const buildSyntheticHeaderField = (
  field: RecordPasteCaseConfig["fields"][number],
  index: number,
): PasteHeaderField => ({
  id: `fldPerfPaste${String(index + 1).padStart(8, "0")}`,
  name: field.name,
  type: field.type,
  description: undefined,
  options: field.options ?? {},
  meta: undefined,
  aiConfig: undefined,
  isLookup: undefined,
  isConditionalLookup: undefined,
  lookupOptions: undefined,
  notNull: undefined,
  unique: undefined,
  isPrimary: undefined,
  isComputed: undefined,
  isPending: undefined,
  hasError: undefined,
  cellValueType: CellValueType.String,
  isMultipleCellValue: undefined,
  dbFieldType: DbFieldType.Text,
  dbFieldName: `perf_paste_${String(index + 1).padStart(3, "0")}`,
  recordRead: undefined,
  recordCreate: undefined,
});

const buildPasteHeader = (
  tableFields: Array<PasteHeaderField & { name: string }>,
  config: RecordPasteCaseConfig,
) => {
  const fieldByName = new Map(tableFields.map((field) => [field.name, field]));
  return config.fields.map(
    (field, index) =>
      fieldByName.get(field.name) ?? buildSyntheticHeaderField(field, index),
  );
};

const preparePasteFixture = async (
  baseId: string,
  tableName: string,
  config: RecordPasteCaseConfig,
): Promise<PasteFixture> => {
  const seedFieldCount = config.seedFieldCount ?? config.fields.length;
  const seedRowCount = config.seedRowCount ?? 0;
  const table = await createTable(baseId, {
    name: tableName,
    fields: config.fields.slice(0, seedFieldCount),
    records: seedRowCount > 0 ? buildSeedRows(config) : [],
  });
  const tableFields = await getFields(table.id);
  const views = await getViews(table.id);
  const viewId = views[0]?.id;

  if (!viewId) {
    throw new Error(`No grid view found for record paste table ${table.id}`);
  }

  const pasteFields = resolvePasteFields(tableFields, {
    ...config,
    fields: config.fields.slice(0, seedFieldCount),
  }).concat(
    config.fields.slice(seedFieldCount).map((field) => ({
      ...field,
      id: field.id ?? "",
      name: field.name,
    })),
  );
  const projection = pasteFields
    .slice(0, seedFieldCount)
    .map((field) => field.id);
  const header = buildPasteHeader(tableFields as PasteHeaderField[], config);

  return {
    tableId: table.id,
    tableName,
    viewId,
    pasteFields,
    projection,
    content: buildPasteContent(config),
    seedRowCount,
    seedFieldCount,
    header,
  };
};

const resolveFinalPasteFields = async (
  tableId: string,
  config: RecordPasteCaseConfig,
) => {
  const tableFields = await getFields(tableId);
  const pasteFields = resolvePasteFields(tableFields, config);
  return {
    pasteFields,
    projection: pasteFields.map((field) => field.id),
  };
};

const executePaste = async (
  prepared: PasteFixture,
  config: RecordPasteCaseConfig,
  context: PerfRunContext,
  perfCase: PerfCase,
): Promise<PastePrimaryResult> => {
  if (!config.stream) {
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
      config.fields.length,
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
  }

  const sseResult = await perfStreamSse<IPasteSelectionStreamEvent>({
    context,
    perfCase,
    stepId: config.threshold.metric,
    url: axios.getUri({
      baseURL: axios.defaults.baseURL || "/api",
      url: `/table/${prepared.tableId}/selection/paste-stream`,
    }),
    method: "PATCH",
    headers: getStreamHeaders(context),
    // Per pasteRoSchema (packages/openapi selection/paste): `projection` lists the
    // field ids already visible at the paste anchor (here the seeded fields only),
    // while `header` carries the full clipboard column schema the backend uses to
    // create the missing fields. So a 2-id projection with a 20-field header is the
    // intended row+field expansion shape, not a mismatch.
    body: JSON.stringify({
      viewId: prepared.viewId,
      projection: prepared.projection,
      ranges: [
        [0, 0],
        [0, 0],
      ],
      header: prepared.header,
      content: prepared.content,
    }),
    errorPrefix: "Paste selection stream failed",
  });
  const progressEvents = sseResult.events.filter(
    (event): event is IPasteSelectionStreamProgressEvent =>
      event.id === "progress",
  );
  const errors = sseResult.events.filter(
    (event): event is IPasteSelectionStreamErrorEvent => event.id === "error",
  );
  const done = sseResult.events.find(
    (event): event is IPasteSelectionStreamDoneEvent => event.id === "done",
  );
  if (!done) {
    throw new Error(
      errors.at(-1)?.message ?? "Paste selection stream ended without result",
    );
  }
  expect(errors).toHaveLength(0);
  // totalCount/processedCount are required fields of the shared paste-stream done
  // schema, so both engines populate them; asserting the full rowCount is safe for
  // V1 and V2. The updated/created split is only reliable on V2 (legacy V1 reports
  // it differently), so it is asserted under the engine guard; the post-paste
  // assertPastedRows full scan carries data correctness for both engines.
  expect(done.totalCount).toBe(config.rowCount);
  expect(done.processedCount).toBe(config.rowCount);

  if (context.engine === "v2") {
    expect(done.data.updatedCount).toBe(
      Math.min(prepared.seedRowCount, config.rowCount),
    );
    expect(done.data.createdCount).toBe(
      Math.max(config.rowCount - prepared.seedRowCount, 0),
    );
  }

  assertPasteDoneRange(done, config, config.fields.length);

  const responseHeaders = pickRoutingResponseHeaders(sseResult.headers);
  return {
    status: sseResult.status,
    data: {
      ranges: done.data.ranges ?? [
        [0, 0],
        [0, 0],
      ],
    },
    headers: sseResult.headers,
    config: {},
    statusText: "OK",
    responseHeaders,
    routing: assertEngineRouting(context, responseHeaders, {
      feature: "paste",
      operation: "pasteRecordsStream",
    }),
    stream: {
      done,
      progressEventCount: progressEvents.length,
      errors,
    },
  } as PastePrimaryResult;
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
      ...(pasteMeasurement
        ? { [config.threshold.metric]: pasteMeasurement.durationMs }
        : {}),
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
            tableShape:
              prepared.seedRowCount > 0 ||
              prepared.seedFieldCount < config.fields.length
                ? `${prepared.seedRowCount}-row ${prepared.seedFieldCount}-field table expanded to ${config.rowCount} rows and ${config.fields.length} fields`
                : `empty ${prepared.pasteFields.length}-field table`,
            contentRows: config.rowCount,
            contentCells: config.rowCount * config.fields.length,
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
            stream: pasteMeasurement.result.stream,
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

// The single measured window: trace-wrapped paste -> routing assertion (inside
// executePaste) -> post-paste full-scan verification, bundled into one primary
// measurement whose duration is the primary metric. The driver does not wrap
// this in a record window (paste has none) or re-measure it.
const runRecordPasteMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: RecordPasteCaseConfig,
  fixture: PasteFixture,
): Promise<Measurement<RecordPastePrimaryResult>> => {
  const pasteMeasurement = await withPerfTraceStep(
    context,
    perfCase,
    config.threshold.metric,
    () =>
      measureAsync(config.threshold.metric, () =>
        executePaste(fixture, config, context, perfCase),
      ),
  );
  const finalFields = await resolveFinalPasteFields(fixture.tableId, config);
  const verifiedRows = await assertPastedRows(
    fixture.tableId,
    fixture.viewId,
    finalFields.pasteFields,
    finalFields.projection,
    config,
  );
  return {
    ...pasteMeasurement,
    result: { ...pasteMeasurement.result, verifiedRows },
  };
};

// The pasted table is single-use scratch (no reusable seed cache), so cleanup
// just drops it on a shared DB; isolated CI execute DBs are discarded wholesale.
const cleanupRecordPasteFixture = async ({
  baseId,
  fixture,
}: {
  baseId: string;
  fixture: PasteFixture | undefined;
}) => {
  if (fixture?.tableId && !isExecuteDbIsolated()) {
    try {
      await permanentDeleteTable(baseId, fixture.tableId);
    } catch (error) {
      console.warn(`Failed to cleanup perf table ${fixture.tableId}`, error);
    }
  }
};

const recordPasteLifecycleSpec: RecordMutationLifecycleSpec<
  RecordPasteCaseConfig,
  PasteFixture,
  never,
  RecordPastePrimaryResult
> = {
  // record-paste builds a fresh single-use table per run and verifies after the
  // paste, so it omits useRecordWindow and assertSeedReady; the driver emits no
  // seedReady phase, matching the legacy runner's prepare -> paste phases.
  prepareFixture: ({ baseId, tableName, config }) =>
    preparePasteFixture(baseId, tableName, config),
  runMeasuredOperation: ({ perfCase, context, config, fixture }) =>
    runRecordPasteMeasuredOperation(perfCase, context, config, fixture),
  buildResult: ({ config, prepareMeasurement, primaryMeasurement, error }) =>
    buildRecordPasteCaseResult({
      config,
      prepareMeasurement,
      pasteMeasurement: primaryMeasurement,
      verifiedRows: primaryMeasurement?.result.verifiedRows,
      error,
    }),
  cleanup: cleanupRecordPasteFixture,
};

export const runRecordPasteCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, recordPasteLifecycleSpec);
