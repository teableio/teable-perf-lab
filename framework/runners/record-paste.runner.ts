import { FieldKeyType } from "@teable/core";
import { paste } from "@teable/openapi";
import {
  createTable,
  getFields,
  getRecords,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { getPrimaryThresholdMs } from "../env";
import { measureAsync } from "../metrics";
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

type PasteFixture = {
  tableId: string;
  tableName: string;
  viewId: string;
  pasteFields: NamedField[];
  requiredFields: RequiredFields;
  projection: string[];
  content: string;
};

const requiredFieldNames = ["Name", "Index", "Group", "Payload"] as const;
type RequiredFieldName = (typeof requiredFieldNames)[number];

type RequiredFields = Record<RequiredFieldName, NamedField>;

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

const getGroupValue = (rowNumber: number, config: RecordPasteCaseConfig) => {
  const group =
    config.generator.groups[(rowNumber - 1) % config.generator.groups.length];
  if (!group) {
    throw new Error("Record paste generator must define at least one group");
  }
  return group;
};

const getExpectedRow = (rowNumber: number, config: RecordPasteCaseConfig) => {
  const padded = padRowNumber(rowNumber);
  const group = getGroupValue(rowNumber, config);
  return {
    Name: `${config.generator.titlePrefix} ${padded}`,
    Index: rowNumber,
    Group: group,
    Payload: `${config.generator.payloadPrefix}-${padded}-${group}`,
  };
};

const buildPasteContent = (config: RecordPasteCaseConfig) =>
  Array.from({ length: config.rowCount }, (_, index) => {
    const row = getExpectedRow(index + 1, config);
    return [row.Name, row.Index, row.Group, row.Payload].join("\t");
  }).join("\n");

const resolvePasteFields = (
  fields: NamedField[],
  config: RecordPasteCaseConfig,
) => {
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
    return resolvedField;
  });
};

const resolveRequiredFields = (fields: NamedField[]): RequiredFields => {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  const missingFields = requiredFieldNames.filter(
    (fieldName) => !fieldByName.has(fieldName),
  );

  if (missingFields.length > 0) {
    throw new Error(
      `Missing required record paste fields: ${missingFields.join(", ")}`,
    );
  }

  return Object.fromEntries(
    requiredFieldNames.map((fieldName) => [
      fieldName,
      fieldByName.get(fieldName)!,
    ]),
  ) as RequiredFields;
};

const assertRow = (
  rowNumber: number,
  fields: RequiredFields,
  recordFields: Record<string, unknown>,
  config: RecordPasteCaseConfig,
) => {
  const expected = getExpectedRow(rowNumber, config);
  const actual = {
    Name: recordFields[fields.Name.id],
    Index: recordFields[fields.Index.id],
    Group: recordFields[fields.Group.id],
    Payload: recordFields[fields.Payload.id],
  };

  if (actual.Name !== expected.Name) {
    throw new Error(
      `Row ${rowNumber} Name mismatch: expected ${expected.Name}, actual ${String(
        actual.Name,
      )}`,
    );
  }

  if (Number(actual.Index) !== expected.Index) {
    throw new Error(
      `Row ${rowNumber} Index mismatch: expected ${expected.Index}, actual ${String(
        actual.Index,
      )}`,
    );
  }

  if (actual.Group !== expected.Group) {
    throw new Error(
      `Row ${rowNumber} Group mismatch: expected ${expected.Group}, actual ${String(
        actual.Group,
      )}`,
    );
  }

  if (actual.Payload !== expected.Payload) {
    throw new Error(
      `Row ${rowNumber} Payload mismatch: expected ${expected.Payload}, actual ${String(
        actual.Payload,
      )}`,
    );
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
  fields: RequiredFields,
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
  const requiredFields = resolveRequiredFields(pasteFields);
  const projection = pasteFields.map((field) => field.id);

  return {
    tableId: table.id,
    tableName,
    viewId,
    pasteFields,
    requiredFields,
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
  pasteMeasurement?: Measurement<Awaited<ReturnType<typeof paste>>>;
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
      })),
      prepare: prepared
        ? {
            durationMs: prepareMeasurement.durationMs,
            tableShape: "empty 4-field table",
            contentRows: config.rowCount,
            preparedBeforeMetric: true,
          }
        : undefined,
      paste: pasteMeasurement
        ? {
            status: pasteMeasurement.result.status,
            ranges: pasteMeasurement.result.data.ranges,
          }
        : undefined,
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
    let pasteMeasurement:
      | Measurement<Awaited<ReturnType<typeof paste>>>
      | undefined;
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
            return response;
          }),
      );

      verifiedRows = await assertPastedRows(
        prepared.tableId,
        prepared.viewId,
        prepared.requiredFields,
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
    if (prepareMeasurement?.result.tableId) {
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
