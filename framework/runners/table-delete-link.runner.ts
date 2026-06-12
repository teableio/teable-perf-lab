import { FieldType } from "@teable/core";
import { isExecuteDbIsolated } from "../env";
import { measureAsync } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import type { PerfCase, PerfRunContext, PerfRunResult } from "../types";
import { PerfRunDiagnosticError } from "../types";
import { waitForRowsRestored } from "./record-undo-redo.shared";
import {
  archiveTable,
  assertTableNotListed,
  buildTableLifecycleSampleResult,
  buildTableLifecycleSamplesResult,
  findTableTrashId,
  formatTableLifecycleSample,
  restoreTableTrash,
  type TableLifecycleRequestSample,
  type TableLifecycleVerifySample,
  type TableTrashLookup,
} from "./table-lifecycle.shared";
import {
  assertLinkCellSamples,
  buildLinkFixtureSeedDetails,
  getLinkFieldState,
  permanentDeleteLinkFixture,
  prepareTableLinkFixtures,
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

export const runTableDeleteLinkCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as TableLinkLifecycleCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  let fixtureSamples: TableLinkFixtureSample[] = [];
  const requestSamples: TableLifecycleRequestSample[] = [];
  const verifySamples: TableLifecycleVerifySample[] = [];
  const cleanupSamples: DeleteLinkCleanupSample[] = [];

  // Restore the archived foreign table, then decide whether the pair is still
  // a valid seed: v2 soft delete leaves the surviving link field intact, while
  // v1 detachLink has already converted it to text (fixture must be rebuilt).
  const cleanupSample = async (
    sample: TableLinkFixtureSample,
    trashLookup: TableTrashLookup,
  ): Promise<DeleteLinkCleanupSample> => {
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

  const buildDetails = (): Record<string, unknown> => ({
    runner: "table-delete-link",
    deleteTarget: "foreign-table",
    mainRowCount: config.rowCount,
    foreignRowCount: config.link.foreignTable.rowCount,
    ...buildLinkFixtureSeedDetails(fixtureSamples),
    cleanup: { samples: cleanupSamples },
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
  });

  try {
    fixtureSamples = await prepareTableLinkFixtures(
      baseId,
      config,
      perfCase,
      "table-delete-link",
    );

    try {
      for (const sample of fixtureSamples) {
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
              const trashLookup = await findTableTrashId(
                baseId,
                sample.fixture.link.foreignTableId,
              );
              // The main table must survive untouched row-wise on both
              // engines; only the link field's type is engine-dependent.
              const mainScan = await waitForRowsRestored(
                sample.fixture,
                config,
                { timeoutMs: 60_000, pollIntervalMs: 1_000 },
              );
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
        requestSamples.push(
          buildTableLifecycleSampleResult(
            sample.iteration,
            sample.fixture,
            requestMeasurement,
            "deleteTable",
            trashLookup,
          ),
        );
        verifySamples.push({
          iteration: sample.iteration,
          measurement: verifyMeasurement,
        });

        if (!isExecuteDbIsolated()) {
          await cleanupSample(sample, trashLookup);
        }
      }
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildTableLifecycleSamplesResult({
          config,
          runner: "table-delete",
          fixtureSamples,
          requestSamples,
          verifySamples,
          error,
          details: buildDetails(),
        }),
      );
    }

    return buildTableLifecycleSamplesResult({
      config,
      runner: "table-delete",
      fixtureSamples,
      requestSamples,
      verifySamples,
      details: buildDetails(),
    });
  } finally {
    if (!isExecuteDbIsolated()) {
      for (const sample of fixtureSamples) {
        let cleanup = cleanupSamples.find(
          (item) => item.iteration === sample.iteration,
        );

        if (!cleanup) {
          const requestSample = requestSamples.find(
            (item) => item.iteration === sample.iteration,
          );
          if (requestSample?.trashLookup) {
            try {
              cleanup = await cleanupSample(sample, requestSample.trashLookup);
            } catch (error) {
              console.warn(
                `Failed to restore archived foreign table for sample ${sample.iteration}; deleting fixture`,
                error,
              );
            }
          } else {
            // The foreign table was never archived; the untouched pair is
            // still a valid seed when caching is enabled.
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
    }
  }
};

export const seedTableDeleteLinkCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedTableLinkLifecycleCase(perfCase, context, "table-delete-link");
