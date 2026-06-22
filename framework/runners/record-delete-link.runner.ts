import { FieldKeyType } from "@teable/core";
import { getRecords } from "../../../utils/init-app";
import { getPrimaryThresholdMs } from "../env";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  RecordDeleteLinkCaseConfig,
} from "../types";
import { type Measurement } from "../metrics";
import {
  assertDeleted,
  buildRecordReplayResult,
  deleteAllRowsByEngine,
  type RecordReplayVerification,
} from "./record-replay.shared";
import { runRecordDeleteLinkLifecycle } from "./table-link-lifecycle";
import {
  assertLinkCellSamples,
  buildLinkFixtureSeedDetails,
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
    Awaited<ReturnType<typeof deleteAllRowsByEngine>>
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
): Promise<PerfRunResult> =>
  runRecordDeleteLinkLifecycle(perfCase, context, {
    runner: "record-delete-link",
    measuredOperation: ({ fixture, context }) =>
      deleteAllRowsByEngine(fixture, context),
    verifyPhaseName: "verifyDeletedLinkedRows",
    verify: ({ fixture, config }) => verifyLinkedDelete(fixture, config),
    buildResult: buildDeleteLinkResult,
  });

export const seedRecordDeleteLinkCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedTableLinkLifecycleCase(perfCase, context, "record-delete-link");
