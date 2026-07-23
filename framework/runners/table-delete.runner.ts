import { permanentDeleteTable } from "../../../utils/init-app";
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
import { runTableSamplesLifecycle } from "./table-lifecycle";
import {
  archiveTable,
  assertTableNotListed,
  buildTableLifecycleSampleResult,
  formatTableLifecycleSample,
  getTableLifecycleSampleCount,
  restoreTableTrash,
  seedTableLifecycleCase,
  type TableLifecycleCaseConfig,
  type TableLifecycleCleanupSample,
  type TableLifecycleFixtureSample,
  type TableTrashLookup,
  waitForTableTrashId,
} from "./table-lifecycle.shared";

// Restore the archived table and confirm its full row count, so a reusable seed
// stays intact for the next run; the restore is recorded as a cleanup sample.
const restoreDeletedSample = async ({
  context,
  perfCase,
  config,
  sample,
  trashId,
  cleanupSamples,
}: {
  context: PerfRunContext;
  perfCase: PerfCase;
  config: TableLifecycleCaseConfig;
  sample: TableLifecycleFixtureSample;
  trashId: string;
  cleanupSamples: TableLifecycleCleanupSample[];
}) => {
  const sampleLabel = formatTableLifecycleSample(sample.iteration);
  const restoreMeasurement = await measureAsync(
    `cleanupRestoreTable-${sampleLabel}`,
    () => restoreTableTrash(trashId),
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
};

export const runTableDeleteCase = async (
  perfCase: PerfCaseFor<"table-delete">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runTableSamplesLifecycle(perfCase, context, {
    runner: "table-delete",
    reuseFixtureAcrossSamples: true,
    includeCleanupSamples: true,
    buildDetails: ({ config, state, error }): Record<string, unknown> =>
      error
        ? {}
        : {
            cleanup: {
              restoredSamples: state.cleanupSamples.filter(
                (sample) =>
                  sample.verifyMeasurement?.result.scannedRecords ===
                  config.rowCount,
              ).length,
              fullScans: state.cleanupSamples.map((sample) => ({
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
    runSample: async ({ perfCase, context, config, baseId, sample, state }) => {
      const sampleLabel = formatTableLifecycleSample(sample.iteration);
      const requestMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        `deleteTable-${sampleLabel}`,
        () =>
          measureAsync(`deleteTable-${sampleLabel}`, () =>
            archiveTable(baseId, sample.fixture.tableId),
          ),
        {
          checkpoint: {
            index: sample.iteration - 1,
            total: getTableLifecycleSampleCount(config),
          },
        },
      );

      const verifyMeasurement = await measureAsync(
        `deleteTableVerify-${sampleLabel}`,
        async () => {
          const listing = await assertTableNotListed(
            baseId,
            sample.fixture.tableId,
          );
          const trashLookup = await waitForTableTrashId(
            baseId,
            sample.fixture.tableId,
          );
          return { ...listing, trashLookup };
        },
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

      const hasNextSample =
        sample.iteration < getTableLifecycleSampleCount(config);
      if (hasNextSample || !isExecuteDbIsolated()) {
        await restoreDeletedSample({
          context,
          perfCase,
          config,
          sample,
          trashId: trashLookup.trashId,
          cleanupSamples: state.cleanupSamples,
        });
      }
    },
    cleanup: async ({ perfCase, context, config, baseId, state }) => {
      if (isExecuteDbIsolated()) {
        return;
      }

      for (const sample of state.executionSamples) {
        const requestSample = state.requestSamples.find(
          (item) => item.iteration === sample.iteration,
        );
        const cleanupSample = state.cleanupSamples.find(
          (item) => item.iteration === sample.iteration,
        );
        let restored = Boolean(cleanupSample?.verifyMeasurement);

        if (!restored && requestSample?.trashLookup) {
          try {
            await restoreDeletedSample({
              context,
              perfCase,
              config,
              sample,
              trashId: requestSample.trashLookup.trashId,
              cleanupSamples: state.cleanupSamples,
            });
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
    },
  });

export const seedTableDeleteCase = async (
  perfCase: PerfCaseFor<"table-delete">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedTableLifecycleCase(perfCase, context, "table-delete");
