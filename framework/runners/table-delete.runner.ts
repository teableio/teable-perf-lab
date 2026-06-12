import { permanentDeleteTable } from "../../../utils/init-app";
import { isExecuteDbIsolated } from "../env";
import { measureAsync } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  TableDeleteCaseConfig,
} from "../types";
import { PerfRunDiagnosticError } from "../types";
import {
  waitForRowsRestored,
  type Measurement,
  type RecordReplayVerification,
} from "./record-undo-redo.shared";
import {
  archiveTable,
  assertTableNotListed,
  buildTableLifecycleSampleResult,
  buildTableLifecycleSamplesResult,
  findTableTrashId,
  formatTableLifecycleSample,
  prepareTableLifecycleFixtures,
  restoreTableTrash,
  seedTableLifecycleCase,
  type TableLifecycleCleanupSample,
  type TableLifecycleFixtureSample,
  type TableLifecycleRequestSample,
  type TableLifecycleVerifySample,
} from "./table-lifecycle.shared";

export const runTableDeleteCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as TableDeleteCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  let fixtureSamples: TableLifecycleFixtureSample[] = [];
  const requestSamples: TableLifecycleRequestSample[] = [];
  const verifySamples: TableLifecycleVerifySample[] = [];
  const cleanupSamples: TableLifecycleCleanupSample[] = [];

  const restoreDeletedSample = async (
    sample: TableLifecycleFixtureSample,
    trashId: string,
  ) => {
    const sampleLabel = formatTableLifecycleSample(sample.iteration);
    const restoreMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      `cleanupRestoreTable-${sampleLabel}`,
      () =>
        measureAsync(`cleanupRestoreTable-${sampleLabel}`, () =>
          restoreTableTrash(trashId),
        ),
    );
    const verifyMeasurement = await measureAsync(
      `cleanupFullScan-${sampleLabel}`,
      () => waitForRowsRestored(sample.fixture, config),
    );
    cleanupSamples.push({
      iteration: sample.iteration,
      restoreMeasurement,
      verifyMeasurement,
    });
    return verifyMeasurement;
  };

  try {
    fixtureSamples = await prepareTableLifecycleFixtures(
      baseId,
      config,
      perfCase,
      "table-delete",
    );

    try {
      for (const sample of fixtureSamples) {
        const sampleLabel = formatTableLifecycleSample(sample.iteration);
        const requestMeasurement = await withPerfTraceStep(
          context,
          perfCase,
          `deleteTable-${sampleLabel}`,
          () =>
            measureAsync(`deleteTable-${sampleLabel}`, () =>
              archiveTable(baseId, sample.fixture.tableId),
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
                sample.fixture.tableId,
              );
              const trashLookup = await findTableTrashId(
                baseId,
                sample.fixture.tableId,
              );
              return { ...listing, trashLookup };
            }),
        );
        const { trashLookup } = verifyMeasurement.result as {
          trashLookup: Awaited<ReturnType<typeof findTableTrashId>>;
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
          await restoreDeletedSample(sample, trashLookup.trashId);
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
          cleanupSamples,
          error,
        }),
      );
    }

    return buildTableLifecycleSamplesResult({
      config,
      runner: "table-delete",
      fixtureSamples,
      requestSamples,
      verifySamples,
      cleanupSamples,
      details: {
        cleanup: {
          restoredSamples: cleanupSamples.filter(
            (sample) =>
              sample.verifyMeasurement?.result.scannedRecords === 10000,
          ).length,
          fullScans: cleanupSamples.map((sample) => ({
            iteration: sample.iteration,
            restoreStatus: sample.restoreMeasurement?.result.status,
            restoreRequestMs: sample.restoreMeasurement?.durationMs,
            fullScan: sample.verifyMeasurement?.result,
          })),
        },
        verification: {
          metric: "verifyMs",
          checks: [
            "tableAbsentFromBaseTableList",
            "trashItemPresent",
            "cleanupRestoreFullRowCountScan",
          ],
          participatesInThreshold: false,
        },
      },
    });
  } finally {
    if (!isExecuteDbIsolated()) {
      for (const sample of fixtureSamples) {
        const requestSample = requestSamples.find(
          (item) => item.iteration === sample.iteration,
        );
        const cleanupSample = cleanupSamples.find(
          (item) => item.iteration === sample.iteration,
        );
        let restored = Boolean(cleanupSample?.verifyMeasurement);

        if (!restored && requestSample?.trashLookup) {
          try {
            await restoreDeletedSample(
              sample,
              requestSample.trashLookup.trashId,
            );
            restored = true;
          } catch (error) {
            console.warn(
              `Failed to restore archived table ${sample.fixture.tableId}; deleting it`,
              error,
            );
          }
        }

        if (!(restored && sample.fixture.reusableSeed)) {
          try {
            await permanentDeleteTable(baseId, sample.fixture.tableId);
          } catch (error) {
            console.warn(
              `Failed to cleanup perf table ${sample.fixture.tableId}`,
              error,
            );
          }
        }
      }
    }
  }
};

export const seedTableDeleteCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedTableLifecycleCase(perfCase, context, "table-delete");
