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
import {
  waitForRowsRestored,
  type RecordReplayVerification,
} from "./record-replay.shared";
import { runTableSamplesLifecycle } from "./table-lifecycle";
import {
  archiveTable,
  assertSampleTextValues,
  assertTableNotListed,
  buildTableLifecycleSampleResult,
  findTableTrashId,
  formatTableLifecycleSample,
  restoreTableTrash,
  seedTableLifecycleCase,
  type TableLifecycleCaseConfig,
  type TableLifecycleFixtureSample,
  type TableLifecycleSampleVerification,
  type TableLifecycleVerifySample,
  type TableTrashLookup,
} from "./table-lifecycle.shared";

type RestoreSetupSample = TableLifecycleVerifySample & {
  trashLookup: TableTrashLookup;
};

type RestoreLifecycleState = {
  setupSamples: RestoreSetupSample[];
};

type RestoreVerifyResult = {
  fullScan: RecordReplayVerification;
  samples: TableLifecycleSampleVerification;
};

const restoreArchivedSample = async ({
  context,
  perfCase,
  config,
  sample,
  trashLookup,
}: {
  context: PerfRunContext;
  perfCase: PerfCase;
  config: TableLifecycleCaseConfig;
  sample: TableLifecycleFixtureSample;
  trashLookup: TableTrashLookup;
}) => {
  const sampleLabel = formatTableLifecycleSample(sample.iteration);
  await withPerfTraceStep(
    context,
    perfCase,
    `cleanupRestoreTable-${sampleLabel}`,
    () => restoreTableTrash(trashLookup.trashId),
  );
  await waitForRowsRestored(sample.fixture, config);
};

export const runTableRestoreCase = async (
  perfCase: PerfCaseFor<"table-restore">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runTableSamplesLifecycle<RestoreLifecycleState>(perfCase, context, {
    runner: "table-restore",
    includeSetupSamples: true,
    createState: () => ({ setupSamples: [] }),
    buildDetails: ({ state, error }): Record<string, unknown> =>
      error
        ? {}
        : {
            fullScans: state.verifySamples.map((sample) => {
              const result = sample.measurement.result as RestoreVerifyResult;
              return { iteration: sample.iteration, fullScan: result.fullScan };
            }),
            verifiedSamples: state.verifySamples.map((sample) => {
              const result = sample.measurement.result as RestoreVerifyResult;
              return {
                iteration: sample.iteration,
                samples: result.samples.verifiedSamples,
              };
            }),
            verification: {
              metric: "verifyMs",
              checks: [
                "fullRowCountScan",
                "sampleTextValues(Title,External ID)",
              ],
              participatesInThreshold: false,
            },
          },
    runSample: async ({ perfCase, context, config, baseId, sample, state }) => {
      const sampleLabel = formatTableLifecycleSample(sample.iteration);
      const setupMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        `deleteSetup-${sampleLabel}`,
        () =>
          measureAsync(`deleteSetup-${sampleLabel}`, async () => {
            const archive = await archiveTable(baseId, sample.fixture.tableId);
            const listing = await assertTableNotListed(
              baseId,
              sample.fixture.tableId,
            );
            const trashLookup = await findTableTrashId(
              baseId,
              sample.fixture.tableId,
            );
            return {
              archiveStatus: archive.status,
              ...listing,
              trashLookup,
            };
          }),
      );
      const { trashLookup } = setupMeasurement.result as {
        trashLookup: TableTrashLookup;
      };
      state.setupSamples.push({
        iteration: sample.iteration,
        measurement: setupMeasurement,
        trashLookup,
      });

      const requestMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        `restoreTable-${sampleLabel}`,
        () =>
          measureAsync(`restoreTable-${sampleLabel}`, () =>
            restoreTableTrash(trashLookup.trashId),
          ),
      );
      state.requestSamples.push(
        buildTableLifecycleSampleResult(
          sample.iteration,
          sample.fixture,
          requestMeasurement,
          "restoreTable",
          context,
          trashLookup,
        ),
      );

      const verifyMeasurement = await withPerfTraceStep(
        context,
        perfCase,
        `restoreTableVerify-${sampleLabel}`,
        () =>
          measureAsync(`restoreTableVerify-${sampleLabel}`, async () => {
            const fullScan = await waitForRowsRestored(sample.fixture, config, {
              timeoutMs: 60_000,
              pollIntervalMs: 1_000,
            });
            const samples = await assertSampleTextValues(
              sample.fixture,
              config,
            );
            return { fullScan, samples };
          }),
      );
      state.verifySamples.push({
        iteration: sample.iteration,
        measurement: verifyMeasurement,
      });
    },
    cleanup: async ({ perfCase, context, config, baseId, state }) => {
      if (isExecuteDbIsolated()) {
        return;
      }

      for (const sample of state.fixtureSamples) {
        const requestSample = state.requestSamples.find(
          (item) => item.iteration === sample.iteration,
        );
        const setupSample = state.setupSamples.find(
          (item) => item.iteration === sample.iteration,
        ) as RestoreSetupSample | undefined;
        const verifiedAfterRestore = state.verifySamples.some(
          (item) => item.iteration === sample.iteration,
        );
        let tableIsSeedReady = !setupSample || verifiedAfterRestore;

        if (!tableIsSeedReady && setupSample && !requestSample) {
          try {
            await restoreArchivedSample({
              context,
              perfCase,
              config,
              sample,
              trashLookup: setupSample.trashLookup,
            });
            tableIsSeedReady = true;
          } catch (error) {
            console.warn(
              `Failed to restore archived table ${sample.fixture.tableId}; deleting it`,
              error,
            );
          }
        }

        if (!(tableIsSeedReady && sample.fixture.reusableSeed)) {
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

export const seedTableRestoreCase = async (
  perfCase: PerfCaseFor<"table-restore">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedTableLifecycleCase(perfCase, context, "table-restore");
