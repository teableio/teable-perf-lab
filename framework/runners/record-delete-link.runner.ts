import { FieldKeyType } from "@teable/core";
import { getRecords } from "../../../utils/init-app";
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordDeleteLinkCaseConfig,
} from "../types";
import { PerfRunDiagnosticError } from "../types";
import {
  assertDeleted,
  buildRecordReplayResult,
  buildRecordWindowId,
  cleanupRecordUndoRedoFixture,
  deleteAllRowsViaSelectionDelete,
  waitForRowsRestored,
  withRecordWindowId,
  type Measurement,
  type RecordReplayVerification,
} from "./record-undo-redo.shared";
import {
  assertLinkCellSamples,
  buildLinkFixtureSeedDetails,
  permanentDeleteLinkFixture,
  prepareTableLinkFixture,
  seedTableLinkLifecycleCase,
  type TableLinkFixture,
} from "./table-lifecycle-link.shared";

type LinkDeleteVerification = RecordReplayVerification & {
  foreignTableStillReadable: {
    checkedRecords: number;
    expectedRecords: number;
  };
};

const verifyLinkedDelete = async (
  fixture: TableLinkFixture,
  config: RecordDeleteLinkCaseConfig,
): Promise<LinkDeleteVerification> => {
  const deleted = await assertDeleted(fixture);
  // getRecords caps `take` at 1000, so scan the foreign table in pages rather
  // than a single capped read; otherwise foreign tables larger than 1000 rows
  // would always trip the count assertion below.
  const expectedForeignRows = config.link.foreignTable.rowCount;
  const pageSize = Math.min(config.verify.fullScanPageSize ?? 1_000, 1_000);
  let checkedRecords = 0;
  for (let skip = 0; skip < expectedForeignRows; skip += pageSize) {
    const expectedTake = Math.min(pageSize, expectedForeignRows - skip);
    const foreignRecords = await getRecords(fixture.link.foreignTableId, {
      fieldKeyType: FieldKeyType.Id,
      projection: [fixture.link.foreignKeyFieldId],
      skip,
      take: expectedTake,
    });
    if (foreignRecords.records.length !== expectedTake) {
      throw new Error(
        `Expected ${expectedTake} foreign records readable at skip ${skip}, got ${foreignRecords.records.length}`,
      );
    }
    checkedRecords += foreignRecords.records.length;
  }
  if (checkedRecords !== expectedForeignRows) {
    throw new Error(
      `Expected ${expectedForeignRows} foreign records to remain readable, got ${checkedRecords}`,
    );
  }

  return {
    ...deleted,
    foreignTableStillReadable: {
      checkedRecords,
      expectedRecords: expectedForeignRows,
    },
  };
};

const buildDeleteLinkResult = ({
  config,
  fixture,
  prepareMeasurement,
  seedReadyMeasurement,
  linkReadyMeasurement,
  operationMeasurement,
  verifyMeasurement,
  error,
}: {
  config: RecordDeleteLinkCaseConfig;
  fixture?: TableLinkFixture;
  prepareMeasurement?: Measurement<TableLinkFixture>;
  seedReadyMeasurement?: Measurement<RecordReplayVerification>;
  linkReadyMeasurement?: Measurement<
    Awaited<ReturnType<typeof assertLinkCellSamples>>
  >;
  operationMeasurement?: Measurement<
    Awaited<ReturnType<typeof deleteAllRowsViaSelectionDelete>>
  >;
  verifyMeasurement?: Measurement<LinkDeleteVerification>;
  error?: unknown;
}): PerfRunResult => {
  const replayResult = buildRecordReplayResult({
    config,
    operation: "delete",
    windowId: "",
    fixture,
    prepareMeasurement,
    seedReadyMeasurement,
    operationMeasurement,
    verifyMeasurement,
    error,
  });

  return {
    ...replayResult,
    metrics: {
      ...replayResult.metrics,
      ...(operationMeasurement
        ? { [config.threshold.metric]: operationMeasurement.durationMs }
        : {}),
    },
    thresholds: operationMeasurement
      ? [
          {
            metric: config.threshold.metric,
            max: getPrimaryThresholdMs(config.threshold.maxMs),
            unit: "ms",
          },
        ]
      : [],
    phases: [
      ...(replayResult.phases ?? []),
      ...(linkReadyMeasurement
        ? [
            {
              name: linkReadyMeasurement.name,
              durationMs: linkReadyMeasurement.durationMs,
            },
          ]
        : []),
    ],
    details: {
      ...replayResult.details,
      runner: "record-delete-link",
      source: fixture
        ? {
            tableId: fixture.tableId,
            tableName: fixture.tableName,
            rowCount: config.rowCount,
            link: {
              fieldId: fixture.link.fieldId,
              fieldName: fixture.link.fieldName,
              foreignTableId: fixture.link.foreignTableId,
              foreignRowCount: fixture.link.foreignRowCount,
              permutation: config.link.permutation,
            },
          }
        : undefined,
      linkReady: linkReadyMeasurement?.result,
      deleteTarget: "linked-main-records",
      verification: {
        metric: "verifyDeleted",
        checks: [
          "mainTableNoVisibleRecords",
          "foreignTableStillReadable",
          "preDeleteLinkSamples",
        ],
        participatesInThreshold: false,
      },
      linkFixtures: fixture
        ? buildLinkFixtureSeedDetails([
            {
              iteration: 1,
              fixture,
              prepareMeasurement,
              seedReadyMeasurement,
            },
          ]).linkFixtures
        : undefined,
    },
  };
};

export const runRecordDeleteLinkCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as RecordDeleteLinkCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  const tableName = `${config.tableNamePrefix}-${Date.now()}`;
  const windowId = buildRecordWindowId(context, perfCase);
  let prepareMeasurement: Measurement<TableLinkFixture> | undefined;
  let seedReadyMeasurement: Measurement<RecordReplayVerification> | undefined;
  let linkReadyMeasurement:
    | Measurement<Awaited<ReturnType<typeof assertLinkCellSamples>>>
    | undefined;

  try {
    prepareMeasurement = await measureAsync("prepare", () =>
      prepareTableLinkFixture(
        baseId,
        tableName,
        config,
        perfCase,
        "record-delete-link",
      ),
    );
    const fixture = prepareMeasurement.result;
    let operationMeasurement:
      | Measurement<Awaited<ReturnType<typeof deleteAllRowsViaSelectionDelete>>>
      | undefined;
    let verifyMeasurement: Measurement<LinkDeleteVerification> | undefined;

    try {
      seedReadyMeasurement = await measureAsync("seedReady", () =>
        waitForRowsRestored(fixture, config),
      );
      linkReadyMeasurement = await measureAsync("linkReady", () =>
        assertLinkCellSamples(fixture, config),
      );

      await withRecordWindowId(windowId, async () => {
        operationMeasurement = await withPerfTraceStep(
          context,
          perfCase,
          config.threshold.metric,
          () =>
            measureAsync(config.threshold.metric, () =>
              deleteAllRowsViaSelectionDelete(fixture, context),
            ),
        );
      });

      verifyMeasurement = await measureAsync("verifyDeletedLinkedRows", () =>
        verifyLinkedDelete(fixture, config),
      );
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildDeleteLinkResult({
          config,
          fixture,
          prepareMeasurement,
          seedReadyMeasurement,
          linkReadyMeasurement,
          operationMeasurement,
          verifyMeasurement,
          error,
        }),
      );
    }

    return buildDeleteLinkResult({
      config,
      fixture,
      prepareMeasurement,
      seedReadyMeasurement,
      linkReadyMeasurement,
      operationMeasurement,
      verifyMeasurement,
    });
  } finally {
    if (
      !isExecuteDbIsolated() &&
      prepareMeasurement?.result &&
      !prepareMeasurement.result.reusableSeed
    ) {
      await permanentDeleteLinkFixture(baseId, prepareMeasurement.result);
    } else {
      await cleanupRecordUndoRedoFixture(baseId, prepareMeasurement, {
        config,
        context,
        perfCase,
        windowId,
      });
    }
    if (
      !isExecuteDbIsolated() &&
      prepareMeasurement?.result &&
      prepareMeasurement.result.reusableSeed
    ) {
      try {
        await waitForRowsRestored(prepareMeasurement.result, config);
        await assertLinkCellSamples(prepareMeasurement.result, config);
      } catch (error) {
        console.warn(
          `Deleting unrecoverable linked record-delete fixture ${prepareMeasurement.result.tableId}`,
          error,
        );
        await permanentDeleteLinkFixture(baseId, prepareMeasurement.result);
      }
    }
  }
};

export const seedRecordDeleteLinkCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedTableLinkLifecycleCase(perfCase, context, "record-delete-link");
