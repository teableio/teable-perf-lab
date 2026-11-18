import { FieldKeyType, FieldType, Relationship } from "@teable/core";
import { axios } from "@teable/openapi";
import {
  createField,
  createRecords,
  createTable,
  getRecords,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { chunk } from "../chunk";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, roundMetric } from "../metrics";
import { pollUntilReady } from "../readiness";
import { forEachRecordPage } from "../record-page-scan";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  PerfRunContext,
  PerfRunResult,
  RecordConditionalWriteCaseConfig,
} from "../types";

// One update or delete request against the last rows of a table, selected
// either by a filter or by explicit record ids. The matching rows sit at the
// end on purpose: a plan that walks the table from the front pays for every row
// before it finds any of them. Setting matchedRows near rowCount is the worst
// case, and 0 measures what it costs to find nothing.
//
// Both write paths exist only on the V2 endpoints, so V1 returns a skip.

const TITLE = "Title";
const SEQ = "Seq";
const SEQ_INDEXED = "Seq Indexed";
const NOTE = "Note";
const AMOUNT = "Amount";
const DOUBLED = "Doubled";
const GROUP = "Group";
const GROUP_TOTAL = "Group Total";
const GROUP_AMOUNTS = "Group Amounts";
const UPDATED_NOTE = "updated";
const UPDATED_AMOUNT = 1;
const PAGE_SIZE = 1_000;
const SKIPPED_REASON =
  "Selector-based record writes exist only on the V2 record endpoints.";

type Field = { id: string; name: string; options?: unknown };
type Fixture = {
  tableId: string;
  groupTableId?: string;
  fieldIds: Record<string, string>;
  groupTotalFieldId?: string;
  recordIds: string[];
};

const fieldIdsOf = (fields: Field[]) =>
  Object.fromEntries(fields.map((field) => [field.name, field.id]));

const groupIndexOf = (rowNumber: number, groupCount: number) =>
  (rowNumber - 1) % groupCount;

const firstMatchedRow = (c: RecordConditionalWriteCaseConfig) =>
  c.rowCount - c.matchedRows + 1;

const expectedGroupTotals = (c: RecordConditionalWriteCaseConfig) => {
  const totals = new Array<number>(c.computed?.groupCount ?? 0).fill(0);
  const firstMatched = firstMatchedRow(c);
  for (let rowNumber = 1; rowNumber <= c.rowCount; rowNumber += 1) {
    const matched = rowNumber >= firstMatched;
    if (matched && c.operation === "delete") continue;
    totals[groupIndexOf(rowNumber, totals.length)] += matched
      ? UPDATED_AMOUNT
      : rowNumber;
  }
  return totals;
};

const prepareFixture = async (
  perfCase: PerfCaseFor<"record-conditional-write">,
  context: PerfRunContext,
): Promise<Fixture> => {
  const c = perfCase.config;
  const baseId = globalThis.testConfig.baseId;
  const suffix = `${context.engine}-${Date.now()}`;
  const groups = c.computed
    ? await createTable(baseId, {
        name: `${c.tableNamePrefix}-groups-${suffix}`,
        fields: [{ name: TITLE, type: FieldType.SingleLineText }],
        records: Array.from({ length: c.computed.groupCount }, (_, index) => ({
          fields: { [TITLE]: `Group-${index + 1}` },
        })),
      })
    : undefined;
  const table = await createTable(baseId, {
    name: `${c.tableNamePrefix}-${suffix}`,
    fields: [
      { name: TITLE, type: FieldType.SingleLineText },
      { name: SEQ, type: FieldType.Number },
      // A unique field is the one column a user can give a database index.
      { name: SEQ_INDEXED, type: FieldType.Number, unique: true },
      { name: NOTE, type: FieldType.SingleLineText },
      { name: AMOUNT, type: FieldType.Number },
    ],
    records: [],
  });
  const fieldIds = fieldIdsOf(table.fields as Field[]);
  let symmetricFieldId: string | undefined;
  if (groups) {
    const link = await createField(table.id, {
      name: GROUP,
      type: FieldType.Link,
      options: {
        relationship: Relationship.ManyOne,
        foreignTableId: groups.id,
      },
    });
    fieldIds[GROUP] = link.id;
    symmetricFieldId = (link.options as { symmetricFieldId: string })
      .symmetricFieldId;
  }

  const rows = Array.from({ length: c.rowCount }, (_, index) => {
    const rowNumber = index + 1;
    return {
      fields: {
        [TITLE]: `Row-${String(rowNumber).padStart(6, "0")}`,
        [SEQ]: rowNumber,
        [SEQ_INDEXED]: rowNumber,
        [NOTE]: "seed",
        [AMOUNT]: rowNumber,
        ...(groups
          ? {
              [GROUP]: {
                id: groups.records[
                  groupIndexOf(rowNumber, groups.records.length)
                ].id,
              },
            }
          : {}),
      },
    };
  });
  const recordIds: string[] = [];
  for (const batch of chunk(rows, c.batchSize)) {
    const response = await withPerfTraceStep(
      context,
      perfCase,
      "seedBatch",
      () =>
        createRecords(table.id, {
          fieldKeyType: FieldKeyType.Name,
          records: batch,
        }),
    );
    for (const record of response.records) recordIds.push(record.id);
  }

  let groupTotalFieldId: string | undefined;
  if (groups && symmetricFieldId) {
    const doubled = await createField(table.id, {
      name: DOUBLED,
      type: FieldType.Formula,
      options: { expression: `{${fieldIds[AMOUNT]}} * 2` },
    });
    fieldIds[DOUBLED] = doubled.id;
    const lookupOptions = {
      foreignTableId: table.id,
      linkFieldId: symmetricFieldId,
      lookupFieldId: fieldIds[AMOUNT],
    };
    await createField(groups.id, {
      name: GROUP_AMOUNTS,
      type: FieldType.Number,
      isLookup: true,
      lookupOptions,
    });
    groupTotalFieldId = (
      await createField(groups.id, {
        name: GROUP_TOTAL,
        type: FieldType.Rollup,
        options: { expression: "sum({values})" },
        lookupOptions,
      })
    ).id;
  }
  return {
    tableId: table.id,
    groupTableId: groups?.id,
    fieldIds,
    groupTotalFieldId,
    recordIds,
  };
};

const readGroupTotals = async (fixture: Fixture, groupCount: number) => {
  const totals: number[] = [];
  await forEachRecordPage(
    {
      totalRows: groupCount,
      pageSize: PAGE_SIZE,
      fetchPage: (skip, take) =>
        getRecords(fixture.groupTableId!, {
          fieldKeyType: FieldKeyType.Id,
          skip,
          take,
        }),
    },
    (record) => {
      totals.push(Number(record.fields[fixture.groupTotalFieldId!] ?? 0));
    },
  );
  return totals;
};

const assertGroupTotals = async (
  fixture: Fixture,
  expected: number[],
  label: string,
) => {
  const actual = await readGroupTotals(fixture, expected.length);
  const wrong = expected.findIndex((total, index) => actual[index] !== total);
  if (wrong >= 0) {
    throw new Error(
      `${label}: group ${wrong + 1} totals ${actual[wrong]}, expected ${expected[wrong]}`,
    );
  }
};

const seedGroupTotals = (c: RecordConditionalWriteCaseConfig) => {
  const totals = new Array<number>(c.computed?.groupCount ?? 0).fill(0);
  for (let rowNumber = 1; rowNumber <= c.rowCount; rowNumber += 1) {
    totals[groupIndexOf(rowNumber, totals.length)] += rowNumber;
  }
  return totals;
};

const sendWrite = async (
  perfCase: PerfCaseFor<"record-conditional-write">,
  context: PerfRunContext,
  fixture: Fixture,
) => {
  const c = perfCase.config;
  const selector =
    c.selector === "filter"
      ? {
          filter: {
            fieldId:
              fixture.fieldIds[c.filterField === "indexed" ? SEQ_INDEXED : SEQ],
            operator: "isGreater",
            value: c.rowCount - c.matchedRows,
          },
        }
      : { recordIds: fixture.recordIds.slice(c.rowCount - c.matchedRows) };
  const fields = c.computed
    ? { [fixture.fieldIds[AMOUNT]]: UPDATED_AMOUNT }
    : { [fixture.fieldIds[NOTE]]: UPDATED_NOTE };
  const response = await withPerfTraceStep(
    context,
    perfCase,
    "conditionalWrite",
    () =>
      c.operation === "update"
        ? axios.post("/v2/tables/updateRecords", {
            tableId: fixture.tableId,
            ...selector,
            fields,
            fieldKeyType: FieldKeyType.Id,
          })
        : axios.delete("/v2/tables/deleteRecords", {
            data: { tableId: fixture.tableId, ...selector },
          }),
  );
  const data = response.data?.data as
    | { updatedCount?: number; deletedCount?: number }
    | undefined;
  const affected =
    c.operation === "update" ? data?.updatedCount : data?.deletedCount;
  if (affected !== c.matchedRows) {
    throw new Error(
      `The ${c.operation} reported ${affected} affected rows, expected ${c.matchedRows}`,
    );
  }
  return affected;
};

const verifyRows = async (
  c: RecordConditionalWriteCaseConfig,
  fixture: Fixture,
) => {
  const firstMatched = firstMatchedRow(c);
  const totalRows =
    c.operation === "delete" ? c.rowCount - c.matchedRows : c.rowCount;
  const seqId = fixture.fieldIds[SEQ];
  const noteId = fixture.fieldIds[NOTE];
  const amountId = fixture.fieldIds[AMOUNT];
  const doubledId = fixture.fieldIds[DOUBLED];
  const scan = await forEachRecordPage(
    {
      totalRows,
      pageSize: PAGE_SIZE,
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          fieldKeyType: FieldKeyType.Id,
          skip,
          take,
        }),
    },
    (record, rowNumber) => {
      const matched = rowNumber >= firstMatched;
      const amount = matched && c.computed ? UPDATED_AMOUNT : rowNumber;
      const note = matched && !c.computed ? UPDATED_NOTE : "seed";
      const wrong =
        record.fields[seqId] !== rowNumber ||
        record.fields[noteId] !== note ||
        record.fields[amountId] !== amount ||
        (doubledId !== undefined && record.fields[doubledId] !== amount * 2);
      if (wrong) {
        throw new Error(
          `Row ${rowNumber} is wrong after the ${c.operation}: ${JSON.stringify(record.fields)}`,
        );
      }
    },
  );
  const extra = await getRecords(fixture.tableId, {
    fieldKeyType: FieldKeyType.Id,
    skip: totalRows,
    take: 1,
  });
  if (extra.records.length > 0) {
    throw new Error(`The table holds more than ${totalRows} rows`);
  }
  return scan.scannedRecords;
};

export const runRecordConditionalWriteCase = async (
  perfCase: PerfCaseFor<"record-conditional-write">,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const c = perfCase.config;
  if (context.engine !== "v2") {
    return {
      result: "skipped",
      metrics: {},
      thresholds: [],
      details: {
        operation: "record-conditional-write",
        skipped: true,
        skippedReason: SKIPPED_REASON,
        requestedEngine: context.engine,
      },
    };
  }

  const baseId = globalThis.testConfig.baseId;
  let fixture: Fixture | undefined;
  try {
    const prepared = await measureAsync("prepareFixture", () =>
      prepareFixture(perfCase, context),
    );
    const ready = prepared.result;
    fixture = ready;
    const readiness = {
      timeoutMs: c.computed?.readyTimeoutMs ?? 0,
      pollIntervalMs: 100,
    };
    if (c.computed) {
      const seedTotals = seedGroupTotals(c);
      await pollUntilReady(
        { ...readiness, description: "seeded group totals" },
        () => assertGroupTotals(ready, seedTotals, "seed"),
      );
    }

    const expectedTotals = expectedGroupTotals(c);
    const startedAt = performance.now();
    const request = await measureAsync("writeRequest", () =>
      sendWrite(perfCase, context, ready),
    );
    if (c.computed) {
      await pollUntilReady(
        { ...readiness, description: "group totals after the write" },
        () => assertGroupTotals(ready, expectedTotals, "after write"),
      );
    }
    const writeReadyMs = roundMetric(performance.now() - startedAt);
    const verified = await measureAsync("verifyRows", () =>
      verifyRows(c, ready),
    );

    return {
      result: "pass",
      metrics: {
        prepareFixtureMs: prepared.durationMs,
        writeRequestMs: request.durationMs,
        [c.threshold.metric]: writeReadyMs,
        verifyRowsMs: verified.durationMs,
        matchedRows: c.matchedRows,
        scannedRows: verified.result,
      },
      thresholds: [
        {
          metric: c.threshold.metric,
          max: getPrimaryThresholdMs(c.threshold.maxMs),
          unit: "ms",
        },
      ],
      phases: [prepared, request, verified].map(({ name, durationMs }) => ({
        name,
        durationMs,
      })),
      details: {
        tableId: ready.tableId,
        groupTableId: ready.groupTableId,
        operation: c.operation,
        selector: c.selector,
        filterField: c.selector === "filter" ? c.filterField : undefined,
        rowCount: c.rowCount,
        matchedRows: c.matchedRows,
        request: {
          method: c.operation === "update" ? "POST" : "DELETE",
          path:
            c.operation === "update"
              ? "/api/v2/tables/updateRecords"
              : "/api/v2/tables/deleteRecords",
        },
      },
    };
  } finally {
    if (!isExecuteDbIsolated() && fixture) {
      for (const tableId of [fixture.tableId, fixture.groupTableId]) {
        if (!tableId) continue;
        try {
          await permanentDeleteTable(baseId, tableId);
        } catch (error) {
          console.warn(`Failed to discard table ${tableId}`, error);
        }
      }
    }
  }
};
