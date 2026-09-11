import { FieldKeyType, FieldType } from "@teable/core";
import {
  createField,
  createRecords,
  createTable,
  getFields,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { chunk } from "../chunk";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, roundMetric } from "../metrics";
import { runPollStorm, summarizePollStorm } from "../poll-storm";
import { buildPerfTraceHeaders, withPerfTraceStep } from "../trace-collector";
import type {
  ComputeActivityPollCaseConfig,
  PerfCase,
  PerfCaseFor,
  PerfRunContext,
  PerfRunResult,
} from "../types";

const TITLE_FIELD = "Title";
const AMOUNT_FIELD = "Amount";

type Fixture = {
  tableId: string;
  tableName: string;
  formulaFieldIds: string[];
  seedBuildMs: number;
};

const prepareFixture = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  c: ComputeActivityPollCaseConfig,
  tableName: string,
): Promise<Fixture> => {
  const startedAt = performance.now();
  const baseId = globalThis.testConfig.baseId;
  const table = await createTable(baseId, {
    name: tableName,
    fields: [
      { name: TITLE_FIELD, type: FieldType.SingleLineText },
      { name: AMOUNT_FIELD, type: FieldType.Number },
    ],
    records: [],
  });
  const rows = Array.from({ length: c.recordCount }, (_, index) => ({
    fields: {
      [TITLE_FIELD]: `Row-${String(index + 1).padStart(6, "0")}`,
      [AMOUNT_FIELD]: index + 1,
    },
  }));
  for (const batch of chunk(rows, c.batchSize)) {
    await withPerfTraceStep(context, perfCase, "seedBatch", () =>
      createRecords(table.id, {
        fieldKeyType: FieldKeyType.Name,
        records: batch,
      }),
    );
  }
  // Computed fields give the activity projection something to report. A table
  // with none still answers the endpoint, but it answers about nothing, and a
  // poll that reads an empty projection is not the poll production is paying
  // for.
  const seedFields = (await getFields(table.id)) as Array<{
    id: string;
    name: string;
  }>;
  const amountFieldId = seedFields.find(
    (field) => field.name === AMOUNT_FIELD,
  )?.id;
  if (!amountFieldId) {
    throw new Error(`Compute activity fixture is missing ${AMOUNT_FIELD}`);
  }
  const formulaFieldIds: string[] = [];
  for (let index = 0; index < c.formulaFieldCount; index += 1) {
    const response = await createField(table.id, {
      name: `Derived ${index + 1}`,
      type: FieldType.Formula,
      // Formulas are rejected unless they reference field ids.
      options: { expression: `{${amountFieldId}} * ${index + 2}` },
    });
    formulaFieldIds.push(response.id);
  }
  return {
    tableId: table.id,
    tableName,
    formulaFieldIds,
    seedBuildMs: performance.now() - startedAt,
  };
};

export const runComputeActivityPollCase = async (
  perfCase: PerfCaseFor<"compute-activity-poll">,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const c = perfCase.config;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${c.tableNamePrefix}-${Date.now()}`;
  const thresholds = [
    {
      metric: c.threshold.metric,
      max: getPrimaryThresholdMs(c.threshold.maxMs),
      unit: "ms",
    },
  ];
  let fixture: Fixture | undefined;
  try {
    fixture = await prepareFixture(perfCase, context, c, tableName);
    const url = `${context.appUrl}/api/v2/tables/getComputeActivity?baseId=${encodeURIComponent(
      baseId,
    )}&tableId=${encodeURIComponent(fixture.tableId)}`;
    const headers = {
      accept: "application/json, text/plain, */*",
      ...(context.cookie ? { cookie: context.cookie } : {}),
      ...buildPerfTraceHeaders(context, perfCase, "computeActivityPoll"),
    };

    // One viewer first. Without it a slow storm cannot be told from a slow
    // endpoint, and the whole claim of this case is about what happens when
    // many viewers want the same projection at once.
    const solo = await measureAsync("soloPoll", () =>
      runPollStorm({
        url,
        headers,
        viewers: 1,
        rounds: c.warmupRounds,
        thinkTimeMs: 0,
        budgetMs: performance.now() + c.budgetMs,
      }),
    );
    const soloSummary = summarizePollStorm(solo.result);
    if (soloSummary.okCount === 0) {
      throw new Error(
        `Compute activity endpoint answered no polls; statuses: ${JSON.stringify(
          solo.result.samples.slice(0, 3),
        )}`,
      );
    }

    const storm = await measureAsync("pollStorm", () =>
      runPollStorm({
        url,
        headers,
        viewers: c.viewers,
        rounds: c.rounds,
        thinkTimeMs: c.thinkTimeMs,
        budgetMs: performance.now() + c.budgetMs,
      }),
    );
    const summary = summarizePollStorm(storm.result);
    if (summary.errorCount > 0) {
      throw new Error(
        `${summary.errorCount} of ${summary.pollCount} polls failed; first: ${JSON.stringify(
          storm.result.samples.find((sample) => sample.status !== 200),
        )}`,
      );
    }

    return {
      result: "pass",
      metrics: {
        seedBuildMs: roundMetric(fixture.seedBuildMs),
        soloPollP50Ms: soloSummary.pollP50Ms,
        soloPollP95Ms: soloSummary.pollP95Ms,
        soloPollThroughputPerSec: soloSummary.pollThroughputPerSec,
        ...summary,
        // What the storm costs a viewer over what one viewer alone pays. A
        // coalescer that removes per-poll server work should flatten this;
        // reading p95 alone would mostly report the hardware.
        pollContentionRatio:
          soloSummary.pollP95Ms > 0
            ? roundMetric(summary.pollP95Ms / soloSummary.pollP95Ms)
            : 0,
      },
      thresholds,
      phases: [
        { name: solo.name, durationMs: solo.durationMs },
        { name: storm.name, durationMs: storm.durationMs },
      ],
      details: {
        tableId: fixture.tableId,
        recordCount: c.recordCount,
        formulaFieldCount: c.formulaFieldCount,
        formulaFieldIds: fixture.formulaFieldIds,
        request: { method: "GET", path: "/api/v2/tables/getComputeActivity" },
        storm: {
          viewers: c.viewers,
          rounds: c.rounds,
          thinkTimeMs: c.thinkTimeMs,
        },
        solo: soloSummary,
        // The coalescer this case exists to observe is configured by
        // environment, not by the case, so the run has to say what it saw.
        readCacheMs: process.env.COMPUTED_ACTIVITY_READ_CACHE_MS ?? "(default)",
      },
    };
  } finally {
    if (!isExecuteDbIsolated() && fixture) {
      try {
        await permanentDeleteTable(baseId, fixture.tableId);
      } catch (error) {
        console.warn(`Failed to discard compute activity table`, error);
      }
    }
  }
};
