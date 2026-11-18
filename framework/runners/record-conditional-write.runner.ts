import { monitorEventLoopDelay } from "node:perf_hooks";
import { FieldKeyType, FieldType, Relationship, Role } from "@teable/core";
import { axios, emailBaseInvitation } from "@teable/openapi";
import { createNewUserAxios } from "../../../utils/axios-instance/new-user";
import {
  createField,
  createRecords,
  createTable,
  getRecords,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { chunk } from "../chunk";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, percentile, roundMetric } from "../metrics";
import { pollUntilReady, sleep } from "../readiness";
import { forEachRecordPage } from "../record-page-scan";
import { withPerfTraceStep } from "../trace-collector";
import { PerfRunDiagnosticError } from "../types";
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
// Rows can carry a long JSON payload. Wide rows are what make these writes
// dangerous: the server reads whole rows, so memory grows with row width as well
// as row count. Heap peak and event-loop delay are reported next to the timings.
//
// While that request runs, a second person in the base keeps updating and
// deleting single rows at the front of the same table, away from the rows being
// written. Each of their requests must answer successfully within the response
// limit: a bulk write that leaves collaborators waiting is a failure even when
// the bulk write itself is fast.
//
// Both write paths exist only on the V2 endpoints, so V1 returns a skip.

const TITLE = "Title";
const SEQ = "Seq";
const SEQ_INDEXED = "Seq Indexed";
const NOTE = "Note";
const PAYLOAD = "Payload";
const AMOUNT = "Amount";
const DOUBLED = "Doubled";
const GROUP = "Group";
const GROUP_TOTAL = "Group Total";
const GROUP_AMOUNTS = "Group Amounts";
const UPDATED_NOTE = "updated";
const COLLABORATOR_NOTE = "collaborator";
const UPDATED_AMOUNT = 1;
const PAGE_SIZE = 1_000;
const SKIPPED_REASON =
  "Selector-based record writes exist only on the V2 record endpoints.";

type Field = { id: string; name: string; options?: unknown };
type CollaboratorClient = Awaited<ReturnType<typeof createNewUserAxios>>;
type CollaboratorActivity = {
  updateMs: number[];
  deleteMs: number[];
  updatedRows: Set<number>;
  deletedRows: Set<number>;
  failures: string[];
};
type Fixture = {
  tableId: string;
  groupTableId?: string;
  fieldIds: Record<string, string>;
  groupTotalFieldId?: string;
  recordIds: string[];
};

// Stays incompressible, so Postgres stores about the configured size per row.
const PAYLOAD_POOL = (() => {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let state = 2_166_136_261;
  let pool = "";
  for (let index = 0; index < 262_144; index += 1) {
    state = (Math.imul(state, 16_807) + 11) >>> 0;
    pool += alphabet[(state >>> 16) % alphabet.length];
  }
  return pool;
})();

const payloadForRow = (rowNumber: number, bytes: number) => {
  const offset = (rowNumber * 7_919) % (PAYLOAD_POOL.length - bytes);
  return JSON.stringify({
    event: `row-${rowNumber}`,
    body: PAYLOAD_POOL.slice(offset, offset + bytes),
  });
};

const startPressureMonitor = (caseId: string) => {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let heapPeak = 0;
  let rssPeak = 0;
  let lastLog = 0;
  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    heapPeak = Math.max(heapPeak, memory.heapUsed);
    rssPeak = Math.max(rssPeak, memory.rss);
    if (Date.now() - lastLog >= 2_000) {
      lastLog = Date.now();
      console.log(
        `[perf-lab] write-pressure case=${caseId} heapMb=${Math.round(memory.heapUsed / 1_048_576)} rssMb=${Math.round(memory.rss / 1_048_576)} loopMaxMs=${Math.round(loop.max / 1e6)}`,
      );
    }
  }, 100);
  return () => {
    clearInterval(timer);
    loop.disable();
    return {
      heapPeakMb: Math.round(heapPeak / 1_048_576),
      rssPeakMb: Math.round(rssPeak / 1_048_576),
      eventLoopP99Ms: roundMetric(loop.percentile(99) / 1e6),
      eventLoopMaxMs: roundMetric(loop.max / 1e6),
    };
  };
};

const fieldIdsOf = (fields: Field[]) =>
  Object.fromEntries(fields.map((field) => [field.name, field.id]));

const groupIndexOf = (rowNumber: number, groupCount: number) =>
  (rowNumber - 1) % groupCount;

const firstMatchedRow = (c: RecordConditionalWriteCaseConfig) =>
  c.rowCount - c.matchedRows + 1;

const expectedGroupTotals = (
  c: RecordConditionalWriteCaseConfig,
  deletedRows: ReadonlySet<number>,
) => {
  const totals = new Array<number>(c.computed?.groupCount ?? 0).fill(0);
  const firstMatched = firstMatchedRow(c);
  for (let rowNumber = 1; rowNumber <= c.rowCount; rowNumber += 1) {
    if (deletedRows.has(rowNumber)) continue;
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
      ...(c.payloadBytes ? [{ name: PAYLOAD, type: FieldType.LongText }] : []),
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

  const buildRow = (rowNumber: number) => ({
    fields: {
      [TITLE]: `Row-${String(rowNumber).padStart(6, "0")}`,
      [SEQ]: rowNumber,
      [SEQ_INDEXED]: rowNumber,
      [NOTE]: "seed",
      [AMOUNT]: rowNumber,
      ...(c.payloadBytes
        ? { [PAYLOAD]: payloadForRow(rowNumber, c.payloadBytes) }
        : {}),
      ...(groups
        ? {
            [GROUP]: {
              id: groups.records[groupIndexOf(rowNumber, groups.records.length)]
                .id,
            },
          }
        : {}),
    },
  });
  const recordIds: string[] = [];
  const rowNumbers = Array.from(
    { length: c.rowCount },
    (_, index) => index + 1,
  );
  // Rows are built per batch so wide payloads never sit in memory together.
  for (const batch of chunk(rowNumbers, c.batchSize)) {
    const response = await withPerfTraceStep(
      context,
      perfCase,
      "seedBatch",
      () =>
        createRecords(table.id, {
          fieldKeyType: FieldKeyType.Name,
          records: batch.map(buildRow),
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

const createCollaborator = async (context: PerfRunContext) => {
  const email =
    `perf-collaborator-${context.engine}-${context.runId}-${Date.now()}@example.com`.toLowerCase();
  const client = await createNewUserAxios({ email, password: "12345678a" });
  await emailBaseInvitation({
    baseId: globalThis.testConfig.baseId,
    emailBaseInvitationRo: { emails: [email], role: Role.Editor },
  });
  return client;
};

// Runs at least one update and one delete, however quickly the bulk write ends.
const runCollaborator = async (
  c: RecordConditionalWriteCaseConfig,
  fixture: Fixture,
  client: CollaboratorClient,
  isWriteDone: () => boolean,
): Promise<CollaboratorActivity> => {
  const { updateRows, deleteRows, responseTimeoutMs, paceMs } = c.collaborator;
  const activity: CollaboratorActivity = {
    updateMs: [],
    deleteMs: [],
    updatedRows: new Set(),
    deletedRows: new Set(),
    failures: [],
  };
  const options = { timeout: responseTimeoutMs, validateStatus: () => true };
  const attempt = async (
    label: "update" | "delete",
    rowNumber: number,
    send: () => Promise<{ status: number }>,
  ) => {
    const startedAt = performance.now();
    try {
      const { status } = await send();
      if (status >= 200 && status < 300) {
        const elapsedMs = performance.now() - startedAt;
        (label === "update" ? activity.updateMs : activity.deleteMs).push(
          elapsedMs,
        );
        (label === "update" ? activity.updatedRows : activity.deletedRows).add(
          rowNumber,
        );
        return;
      }
      activity.failures.push(`${label} row ${rowNumber}: HTTP ${status}`);
    } catch (error) {
      activity.failures.push(
        `${label} row ${rowNumber}: no response within ${responseTimeoutMs}ms (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  };

  let round = 0;
  do {
    const updateRow = (round % updateRows) + 1;
    await attempt("update", updateRow, () =>
      client.patch(
        `/table/${fixture.tableId}/record/${fixture.recordIds[updateRow - 1]}`,
        {
          fieldKeyType: FieldKeyType.Id,
          record: { fields: { [fixture.fieldIds[NOTE]]: COLLABORATOR_NOTE } },
        },
        options,
      ),
    );
    if (round < deleteRows) {
      const deleteRow = updateRows + round + 1;
      await attempt("delete", deleteRow, () =>
        client.delete(
          `/table/${fixture.tableId}/record/${fixture.recordIds[deleteRow - 1]}`,
          options,
        ),
      );
    }
    round += 1;
    if (!isWriteDone()) await sleep(paceMs);
  } while (!isWriteDone());
  return activity;
};

const latencyMetrics = (prefix: string, values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    [`${prefix}Count`]: sorted.length,
    [`${prefix}P50Ms`]: roundMetric(percentile(sorted, 0.5)),
    [`${prefix}P95Ms`]: roundMetric(percentile(sorted, 0.95)),
    [`${prefix}MaxMs`]: roundMetric(sorted.at(-1) ?? 0),
  };
};

const verifyRows = async (
  c: RecordConditionalWriteCaseConfig,
  fixture: Fixture,
  collaborator: CollaboratorActivity,
) => {
  const firstMatched = firstMatchedRow(c);
  const totalRows =
    (c.operation === "delete" ? c.rowCount - c.matchedRows : c.rowCount) -
    collaborator.deletedRows.size;
  const seqId = fixture.fieldIds[SEQ];
  const noteId = fixture.fieldIds[NOTE];
  const amountId = fixture.fieldIds[AMOUNT];
  const doubledId = fixture.fieldIds[DOUBLED];
  let lastRow = 0;
  const scan = await forEachRecordPage(
    {
      totalRows,
      pageSize: PAGE_SIZE,
      fetchPage: (skip, take) =>
        getRecords(fixture.tableId, {
          fieldKeyType: FieldKeyType.Id,
          skip,
          take,
          projection: [
            seqId,
            noteId,
            amountId,
            ...(doubledId ? [doubledId] : []),
          ],
        }),
    },
    (record) => {
      const rowNumber = Number(record.fields[seqId]);
      const matched = rowNumber >= firstMatched;
      const amount = matched && c.computed ? UPDATED_AMOUNT : rowNumber;
      const unchangedNote = collaborator.updatedRows.has(rowNumber)
        ? COLLABORATOR_NOTE
        : "seed";
      const note = matched && !c.computed ? UPDATED_NOTE : unchangedNote;
      const previousRow = lastRow;
      lastRow = rowNumber;
      const wrong =
        rowNumber <= previousRow ||
        collaborator.deletedRows.has(rowNumber) ||
        (c.operation === "delete" && matched) ||
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
    projection: [seqId],
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
  const reservedRows = c.collaborator.updateRows + c.collaborator.deleteRows;
  if (c.rowCount - c.matchedRows < reservedRows) {
    throw new Error(
      `The collaborator needs ${reservedRows} rows outside the bulk write`,
    );
  }
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

    const collaboratorClient = await createCollaborator(context);
    const stopPressureMonitor = startPressureMonitor(perfCase.id);
    let writeDone = false;
    const collaboratorRun = runCollaborator(
      c,
      ready,
      collaboratorClient,
      () => writeDone,
    );
    let request;
    try {
      request = await measureAsync("writeRequest", () =>
        sendWrite(perfCase, context, ready),
      );
    } catch (error) {
      writeDone = true;
      await collaboratorRun.catch(() => undefined);
      throw new PerfRunDiagnosticError(error, {
        metrics: stopPressureMonitor(),
        thresholds: [],
        details: { tableId: ready.tableId, operation: c.operation },
      });
    }
    writeDone = true;
    const collaborator = await collaboratorRun;
    const pressure = stopPressureMonitor();
    const collaboratorMetrics = {
      ...latencyMetrics("collaboratorUpdate", collaborator.updateMs),
      ...latencyMetrics("collaboratorDelete", collaborator.deleteMs),
      collaboratorFailedRequests: collaborator.failures.length,
      ...pressure,
    };
    if (collaborator.failures.length > 0) {
      throw new PerfRunDiagnosticError(
        `A collaborator got no successful response during the ${c.operation}: ${collaborator.failures
          .slice(0, 5)
          .join("; ")}`,
        {
          metrics: {
            writeRequestMs: request.durationMs,
            ...collaboratorMetrics,
          },
          thresholds: [],
          details: {
            tableId: ready.tableId,
            failures: collaborator.failures.slice(0, 20),
          },
        },
      );
    }
    const readyAfterRequest = await measureAsync("computedReady", async () => {
      if (!c.computed) return;
      const expectedTotals = expectedGroupTotals(c, collaborator.deletedRows);
      await pollUntilReady(
        { ...readiness, description: "group totals after the write" },
        () => assertGroupTotals(ready, expectedTotals, "after write"),
      );
    });
    const writeReadyMs = roundMetric(
      request.durationMs + (c.computed ? readyAfterRequest.durationMs : 0),
    );
    const verified = await measureAsync("verifyRows", () =>
      verifyRows(c, ready, collaborator),
    );

    return {
      result: "pass",
      metrics: {
        prepareFixtureMs: prepared.durationMs,
        writeRequestMs: request.durationMs,
        [c.threshold.metric]: writeReadyMs,
        verifyRowsMs: verified.durationMs,
        ...collaboratorMetrics,
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
        collaborator: {
          role: "editor",
          responseTimeoutMs: c.collaborator.responseTimeoutMs,
          updatedRows: collaborator.updatedRows.size,
          deletedRows: collaborator.deletedRows.size,
        },
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
