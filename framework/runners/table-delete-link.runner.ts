import { FieldType } from "@teable/core";
import { isExecuteDbIsolated } from "../env";
import { measureAsync } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCaseFor,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import { waitForRowsRestored } from "./record-replay.shared";
import {
  archiveTable,
  assertTableNotListed,
  buildTableLifecycleSampleResult,
  formatTableLifecycleSample,
  restoreTableTrash,
  type TableTrashLookup,
  waitForTableTrashId,
} from "./table-lifecycle.shared";
import { runTableLinkSamplesLifecycle } from "./table-link-lifecycle";
import {
  assertLinkCellSamples,
  buildLinkFixtureSeedDetails,
  getLinkFieldState,
  permanentDeleteLinkFixture,
  seedTableLinkLifecycleCase,
  type LinkFieldState,
  type TableLinkFixtureSample,
  type TableLinkLifecycleCaseConfig,
} from "./table-lifecycle-link.shared";

type DeleteLinkCleanupSample = {
  iteration: number;
  restoreStatus?: number;
  linkStateAfterRestore?: LinkFieldState;
  fixtureIntact: boolean;
};

type DeleteLinkLifecycleState = {
  cleanupSamples: DeleteLinkCleanupSample[];
};

// Restore the archived foreign table, then decide whether the pair is still a
// valid seed: v2 soft delete leaves the surviving link field intact, while v1
// detachLink has already converted it to text (fixture must be rebuilt).
const cleanupSample = async ({
  context,
  perfCase,
  config,
  sample,
  trashLookup,
  cleanupSamples,
}: {
  context: PerfRunContext;
  perfCase: PerfCase;
  config: TableLinkLifecycleCaseConfig;
  sample: TableLinkFixtureSample;
  trashLookup: TableTrashLookup;
  cleanupSamples: DeleteLinkCleanupSample[];
}): Promise<DeleteLinkCleanupSample> => {
  const sampleLabel = formatTableLifecycleSample(sample.iteration);
  const restore = await withPerfTraceStep(
    context,
    perfCase,
    `cleanupRestoreForeign-${sampleLabel}`,
    () => restoreTableTrash(trashLookup.trashId),
  );
  const linkState = await getLinkFieldState(sample.fixture);
  let fixtureIntact = false;
  if (
    linkState.exists &&
    linkState.type === FieldType.Link &&
    linkState.foreignTableId === sample.fixture.link.foreignTableId
  ) {
    try {
      await assertLinkCellSamples(sample.fixture, config);
      fixtureIntact = true;
    } catch {
      fixtureIntact = false;
    }
  }
  const result: DeleteLinkCleanupSample = {
    iteration: sample.iteration,
    restoreStatus: restore.status,
    linkStateAfterRestore: linkState,
    fixtureIntact,
  };
  cleanupSamples.push(result);
  return result;
};

export const runTableDeleteLinkCase = async (
  perfCase: PerfCaseFor<"table-delete-link">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runTableLinkSamplesLifecycle<DeleteLinkLifecycleState>(perfCase, context, {
    runner: "table-delete-link",
    resultRunner: "table-delete",
    createState: () => ({ cleanupSamples: [] }),
    buildDetails: ({ config, state }): Record<string, unknown> => ({
      runner: "table-delete-link",
      deleteTarget: "foreign-table",
      mainRowCount: config.rowCount,
      foreignRowCount: config.link.foreignTable.rowCount,
      ...buildLinkFixtureSeedDetails(state.fixtureSamples),
      cleanup: { samples: state.cleanupSamples },
      verification: {
        metric: "verifyMs",
        checks: [
          "foreignTableAbsentFromBaseTableList",
          "trashItemPresent",
          "mainTableFullRowCountScan",
          "survivingLinkFieldStateRecorded(engine-dependent)",
        ],
        participatesInThreshold: false,
      },
    }),
    runSample: async ({ perfCase, context, config, baseId, sample, state }) => {
      const sampleLabel = formatTableLifecycleSample(sample.iteration);
      const requestMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        `deleteTableDetachLink-${sampleLabel}`,
        () =>
          measureAsync(`deleteTableDetachLink-${sampleLabel}`, () =>
            archiveTable(baseId, sample.fixture.link.foreignTableId),
          ),
      );

      const verifyMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        `deleteTableVerify-${sampleLabel}`,
        () =>
          measureAsync(`deleteTableVerify-${sampleLabel}`, async () => {
            const listing = await assertTableNotListed(
              baseId,
              sample.fixture.link.foreignTableId,
            );
            const trashLookup = await waitForTableTrashId(
              baseId,
              sample.fixture.link.foreignTableId,
            );
            // The main table must survive untouched row-wise on both engines;
            // only the link field's type is engine-dependent.
            const mainScan = await waitForRowsRestored(sample.fixture, config, {
              timeoutMs: 60_000,
              pollIntervalMs: 1_000,
            });
            const linkFieldState = await getLinkFieldState(sample.fixture);
            if (!linkFieldState.exists) {
              throw new Error(
                `Surviving link field ${sample.fixture.link.fieldName} disappeared from main table ${sample.fixture.tableId}`,
              );
            }
            return { ...listing, trashLookup, mainScan, linkFieldState };
          }),
      );
      const { trashLookup } = verifyMeasurement.result as {
        trashLookup: TableTrashLookup;
      };
      state.requestSamples.push(
        buildTableLifecycleSampleResult(
          sample.iteration,
          sample.fixture,
          requestMeasurement,
          "deleteTable",
          context,
          trashLookup,
        ),
      );
      state.verifySamples.push({
        iteration: sample.iteration,
        measurement: verifyMeasurement,
      });

      if (!isExecuteDbIsolated()) {
        await cleanupSample({
          context,
          perfCase,
          config,
          sample,
          trashLookup,
          cleanupSamples: state.cleanupSamples,
        });
      }
    },
    cleanup: async ({ perfCase, context, config, baseId, state }) => {
      if (isExecuteDbIsolated()) {
        return;
      }

      for (const sample of state.executionSamples) {
        let cleanup = state.cleanupSamples.find(
          (item) => item.iteration === sample.iteration,
        );

        if (!cleanup) {
          const requestSample = state.requestSamples.find(
            (item) => item.iteration === sample.iteration,
          );
          if (requestSample?.trashLookup) {
            try {
              cleanup = await cleanupSample({
                context,
                perfCase,
                config,
                sample,
                trashLookup: requestSample.trashLookup,
                cleanupSamples: state.cleanupSamples,
              });
            } catch (error) {
              console.warn(
                `Failed to restore archived foreign table for sample ${sample.iteration}; deleting fixture`,
                error,
              );
            }
          } else {
            // The foreign table was never archived; the untouched pair is still
            // a valid seed when caching is enabled.
            cleanup = {
              iteration: sample.iteration,
              fixtureIntact: true,
            };
          }
        }

        if (!(cleanup?.fixtureIntact && sample.fixture.reusableSeed)) {
          await permanentDeleteLinkFixture(baseId, sample.fixture);
        }
      }
    },
  });

export const seedTableDeleteLinkCase = async (
  perfCase: PerfCaseFor<"table-delete-link">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedTableLinkLifecycleCase(perfCase, context, "table-delete-link");
