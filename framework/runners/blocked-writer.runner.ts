import { FieldKeyType, FieldType } from "@teable/core";
import {
  createRecords,
  createTable,
  getFields,
  getRecord,
  getTable,
  getViews,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { chunk } from "../chunk";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { buildPerfTraceHeaders, withPerfTraceStep } from "../trace-collector";
import { runIsolatedJsonRequest } from "../isolated-json-request";
import {
  rowOrderColumnName,
  splitQualifiedTableName,
  waitForHeldLock,
  type LockWatchOutcome,
} from "../lock-observation";
import { measureAsync, roundMetric, type Measurement } from "../metrics";
import { queryPerfDb } from "../sql";
import type {
  BlockedWriterCaseConfig,
  PerfCase,
  PerfCaseFor,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  runRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

const TITLE_FIELD = "Title";
const NOTE_FIELD = "Note";

type NamedField = { id: string; name: string };

type Fixture = {
  tableId: string;
  tableName: string;
  dbTableName: string;
  schemaName: string;
  plainTableName: string;
  viewId: string;
  titleFieldId: string;
  noteFieldId: string;
  anchorRecordId: string;
  bystanderRecordId: string;
  seedBuildMs: number;
  triggerRecordIds: string[];
};

const rowTitle = (rowNumber: number) =>
  `Row-${String(rowNumber).padStart(7, "0")}`;

const resolveNamed = (fields: NamedField[], name: string) => {
  const field = fields.find((candidate) => candidate.name === name);
  if (!field) throw new Error(`Blocked-writer fixture is missing ${name}`);
  return field;
};

// The fixture is never cached. Execute removes a physical column and lets the
// product recreate it, so a run leaves the table in a state that depends on
// where it stopped; handing that to a later run as a warm seed would hand it a
// trap that may or may not still be armed.
const prepareFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  c: BlockedWriterCaseConfig,
  tableName: string,
): Promise<Fixture> => {
  const startedAt = performance.now();
  const baseId = globalThis.testConfig.baseId;
  const table = await createTable(baseId, {
    name: tableName,
    fields: [
      { name: TITLE_FIELD, type: FieldType.SingleLineText },
      { name: NOTE_FIELD, type: FieldType.SingleLineText },
    ],
    records: [],
  });
  const fields = (await getFields(table.id)) as NamedField[];
  const titleFieldId = resolveNamed(fields, TITLE_FIELD).id;
  const noteFieldId = resolveNamed(fields, NOTE_FIELD).id;

  const recordIds: string[] = [];
  const rows = Array.from({ length: c.recordCount }, (_, index) => ({
    fields: {
      [TITLE_FIELD]: rowTitle(index + 1),
      [NOTE_FIELD]: "seed",
    },
  }));
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
  if (recordIds.length !== c.recordCount) {
    throw new Error(
      `Blocked-writer seed created ${recordIds.length} rows, expected ${c.recordCount}`,
    );
  }

  const views = await getViews(table.id);
  const viewId = views[0]?.id;
  if (!viewId) {
    throw new Error(`Blocked-writer fixture table ${table.id} has no view`);
  }
  const meta = await getTable(baseId, table.id);
  const { schemaName, plainTableName } = splitQualifiedTableName(
    meta.dbTableName,
  );

  return {
    tableId: table.id,
    tableName,
    dbTableName: meta.dbTableName,
    schemaName,
    plainTableName,
    viewId,
    titleFieldId,
    noteFieldId,
    // The trigger inserts next to the first row; the bystander edits the last
    // one. Different rows, same table: the only thing they can contend on is
    // the table-level lock, which is what the case claims to measure.
    anchorRecordId: recordIds[0]!,
    bystanderRecordId: recordIds[recordIds.length - 1]!,
    seedBuildMs: performance.now() - startedAt,
    triggerRecordIds: [],
  };
};

const rowOrderColumnExists = async (fixture: Fixture) => {
  const rows = await queryPerfDb<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [
      fixture.schemaName,
      fixture.plainTableName,
      rowOrderColumnName(fixture.viewId),
    ],
  );
  return rows.length > 0;
};

const bystanderWrite = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: Fixture,
  stepId: string,
  note: string,
) => {
  const url = `${context.appUrl}/api/table/${fixture.tableId}/record/${fixture.bystanderRecordId}`;
  const response = await runIsolatedJsonRequest({
    url,
    method: "PATCH",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      ...(context.cookie ? { cookie: context.cookie } : {}),
      ...buildPerfTraceHeaders(context, perfCase, stepId),
    },
    body: {
      fieldKeyType: FieldKeyType.Id,
      typecast: false,
      record: { fields: { [fixture.noteFieldId]: note } },
    },
    responseMode: "recordIds",
  });
  return { durationMs: response.durationMs, status: response.status };
};

const triggerRequest = (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: Fixture,
  c: BlockedWriterCaseConfig,
) => {
  const url = `${context.appUrl}/api/table/${fixture.tableId}/record`;
  const startedAt = performance.now();
  return runIsolatedJsonRequest({
    url,
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      ...(context.cookie ? { cookie: context.cookie } : {}),
      ...buildPerfTraceHeaders(context, perfCase, "triggerLazyRowOrderColumn"),
    },
    body: {
      fieldKeyType: FieldKeyType.Name,
      typecast: false,
      order: {
        viewId: fixture.viewId,
        anchorId: fixture.anchorRecordId,
        position: "after",
      },
      records: [
        { fields: { [TITLE_FIELD]: "trigger", [NOTE_FIELD]: "trigger" } },
      ],
    },
    responseMode: "recordIds",
  }).then((response) => ({
    durationMs: response.durationMs,
    status: response.status,
    recordIds: response.recordIds,
    startedAt,
    triggerKind: c.trigger.kind,
  }));
};

type Primary = {
  baselineMs: number;
  blockedMs: number;
  triggerMs: number;
  lockWatch: LockWatchOutcome;
  bystanderStatus: number;
  triggerStatus: number;
};

type Run = {
  fixture: Fixture;
  // Retained as each phase completes, so a run that fails partway still writes
  // an artifact carrying what it did measure. A blocked-writer case fails for
  // reasons that are themselves the finding — the trigger being too quick to
  // overlap, the lock never appearing — and those runs are worth reading.
  baselineMs?: number;
  lockWatch?: LockWatchOutcome;
  primary?: Primary;
};

const errorDetails = (error: unknown) =>
  error instanceof Error
    ? { error: { name: error.name, message: error.message } }
    : {};

const buildResult = (
  c: BlockedWriterCaseConfig,
  run: Run | undefined,
  error?: unknown,
): PerfRunResult => {
  const thresholds = [
    {
      metric: c.threshold.metric,
      max: getPrimaryThresholdMs(c.threshold.maxMs),
      unit: "ms",
    },
  ];
  if (!run) return { metrics: {}, thresholds, details: errorDetails(error) };
  const { fixture, primary } = run;
  const baselineMs = primary?.baselineMs ?? run.baselineMs;
  const lockWatch = primary?.lockWatch ?? run.lockWatch;
  const ratio =
    primary && primary.baselineMs > 0
      ? roundMetric(primary.blockedMs / primary.baselineMs)
      : undefined;
  return {
    ...(!error && primary ? { result: "pass" as const } : {}),
    metrics: {
      seedBuildMs: roundMetric(fixture.seedBuildMs),
      ...(baselineMs != null
        ? { blockedWriterBaselineMs: roundMetric(baselineMs) }
        : {}),
      ...(lockWatch
        ? {
            lockWaitMs: roundMetric(lockWatch.waitedMs),
            lockObserved: lockWatch.observed ? 1 : 0,
          }
        : {}),
      ...(primary
        ? {
            blockedWriterMs: roundMetric(primary.blockedMs),
            // Diagnostic, never the gate. The whole point of the case is that
            // this number can look healthy while the bystander is stalled.
            triggerMs: roundMetric(primary.triggerMs),
          }
        : {}),
      ...(ratio != null ? { blockedWriterRatio: ratio } : {}),
    },
    thresholds,
    phases: primary
      ? [
          {
            name: "bystanderBaseline",
            durationMs: roundMetric(primary.baselineMs),
          },
          { name: "blockedWriter", durationMs: roundMetric(primary.blockedMs) },
          { name: "trigger", durationMs: roundMetric(primary.triggerMs) },
        ]
      : [],
    details: {
      tableId: fixture.tableId,
      dbTableName: fixture.dbTableName,
      viewId: fixture.viewId,
      rowOrderColumn: rowOrderColumnName(fixture.viewId),
      recordCount: c.recordCount,
      trigger: {
        ...c.trigger,
        anchorRecordId: fixture.anchorRecordId,
        createdRecordIds: fixture.triggerRecordIds,
        status: primary?.triggerStatus,
      },
      bystander: {
        ...c.bystander,
        recordId: fixture.bystanderRecordId,
        status: primary?.bystanderStatus,
      },
      // Which kind of number the reader is holding: a bystander released while
      // the trigger held the lock, or one released while it did not.
      lockWatch,
      blockedWriterRatio: ratio,
      ...errorDetails(error),
    },
  };
};

const spec: RecordMutationLifecycleSpec<
  BlockedWriterCaseConfig,
  Run,
  never,
  Primary
> = {
  resolveTableNamePrefix: (config) => config.tableNamePrefix,
  prepareFixture: async ({ perfCase, context, config, tableName }) => ({
    fixture: await prepareFixture(perfCase, context, config, tableName),
  }),
  runMeasuredOperation: async ({ perfCase, context, config, fixture: run }) => {
    const fixture = run.fixture;

    // 1. The control, first and alone: the same write, the same fixture, the
    //    same process, with nothing contending. A baseline from another run
    //    would be another machine-minute.
    const baseline = await measureAsync("bystanderBaseline", () =>
      bystanderWrite(
        perfCase,
        context,
        fixture,
        "bystanderBaseline",
        "baseline",
      ),
    );

    // 2. Confirm the trap is armed. It is armed by construction rather than by
    //    the harness: a view only gets `__row_<viewId>` storage when something
    //    needs manual-sort order, so a seeded table whose rows were never
    //    reordered has no such column — the same state the production table
    //    was in. This asserts it rather than assuming it, because a run
    //    against a fixture that already has the column would time an ordinary
    //    insert and call it a blocked writer.
    if (await rowOrderColumnExists(fixture)) {
      throw new Error(
        `Row-order column for view ${fixture.viewId} already exists, so the lazy-creation path will not run and there is nothing to block on`,
      );
    }

    // 3. Release the trigger, then wait until its lock is actually held.
    //    Starting the bystander alongside the trigger would measure a race.
    //    Nothing needs to be excluded from the lock watch by pid: the harness's
    //    own queries are reads, which take AccessShareLock and can never be
    //    mistaken for the mode the case waits on.
    //
    //    Not seeing the lock is a result, not an error. An engine that creates
    //    the column online takes this lock for a few metadata-only
    //    milliseconds instead of holding it across the backfill, so a watch
    //    that times out is describing the thing the case was built to detect.
    //    The bystander is released either way; what must hold is that the
    //    trigger is still running when it goes, or nothing concurrent was
    //    measured at all.
    let triggerSettled = false;
    const triggerPromise = triggerRequest(
      perfCase,
      context,
      fixture,
      config,
    ).finally(() => {
      triggerSettled = true;
    });
    const lockWatch = await waitForHeldLock({
      schemaName: fixture.schemaName,
      plainTableName: fixture.plainTableName,
      modes: config.trigger.lockModes,
      timeoutMs: config.trigger.lockWaitTimeoutMs,
    });
    run.lockWatch = lockWatch;
    if (triggerSettled) {
      await triggerPromise.catch(() => undefined);
      throw new Error(
        `The trigger finished before the bystander was released, so nothing concurrent was measured. Either the fixture is too small for the lazy creation to overlap a second request, or the trigger failed early; locks seen: ${JSON.stringify(lockWatch.sample)}`,
      );
    }

    // 4. The measurement.
    const blocked = await measureAsync("blockedWriter", () =>
      bystanderWrite(perfCase, context, fixture, "blockedWriter", "blocked"),
    );
    const trigger = await triggerPromise;
    fixture.triggerRecordIds = trigger.recordIds;

    // 5. Final state through the real read path: the product recreated the
    //    column, and the bystander's write landed rather than being lost to
    //    the contention.
    if (!(await rowOrderColumnExists(fixture))) {
      throw new Error(
        `The trigger completed without recreating the row-order column for view ${fixture.viewId}`,
      );
    }
    const readBack = await getRecord(
      fixture.tableId,
      fixture.bystanderRecordId,
    );
    expect(readBack.fields[fixture.noteFieldId]).toBe("blocked");

    const primary: Primary = {
      baselineMs: baseline.durationMs,
      blockedMs: blocked.durationMs,
      triggerMs: trigger.durationMs,
      lockWatch,
      bystanderStatus: blocked.result.status,
      triggerStatus: trigger.status,
    };
    run.primary = primary;
    return {
      name: config.threshold.metric,
      durationMs: roundMetric(blocked.durationMs),
      result: primary,
    };
  },
  buildResult: ({ config, fixture, error }) =>
    buildResult(config, fixture, error),
  cleanup: async ({ baseId, fixture: run }) => {
    if (isExecuteDbIsolated()) {
      // CI execute jobs run on a disposable restored DB copy; skip cleanup.
      return;
    }
    if (!run) return;
    // Class D. Execute removes a physical column and lets the product rebuild
    // it, and where a failed run stopped decides what is left behind. Restoring
    // that to something a later run can trust costs more than reseeding, so the
    // table goes.
    try {
      await permanentDeleteTable(baseId, run.fixture.tableId);
    } catch (error) {
      console.warn(
        `Failed to discard blocked-writer table ${run.fixture.tableId}`,
        error,
      );
    }
  },
};

export const runBlockedWriterCase = (
  perfCase: PerfCaseFor<"blocked-writer">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, spec);
