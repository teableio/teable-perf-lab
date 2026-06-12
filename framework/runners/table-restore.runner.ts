import { permanentDeleteTable } from "../../../utils/init-app";
import { isExecuteDbIsolated } from "../env";
import { measureAsync } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import type {
  PerfCase,
  PerfRunContext,
  PerfRunResult,
  TableRestoreCaseConfig,
} from "../types";
import { PerfRunDiagnosticError } from "../types";
import {
  waitForRowsRestored,
  type RecordReplayVerification,
} from "./record-undo-redo.shared";
import {
  archiveTable,
  assertSampleTextValues,
  assertTableNotListed,
  buildTableLifecycleSampleResult,
  buildTableLifecycleSamplesResult,
  findTableTrashId,
  formatTableLifecycleSample,
  prepareTableLifecycleFixtures,
  restoreTableTrash,
  seedTableLifecycleCase,
  type TableLifecycleFixtureSample,
  type TableLifecycleRequestSample,
  type TableLifecycleVerifySample,
  type TableTrashLookup,
} from "./table-lifecycle.shared";

type RestoreSetupSample = TableLifecycleVerifySample & {
  trashLookup: TableTrashLookup;
};

type RestoreVerifySample = TableLifecycleVerifySample & {
  result: {
    fullScan: RecordReplayVerification;
    samples: Awaited<ReturnType<typeof assertSampleTextValues>>;
  };
};

export const runTableRestoreCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as TableRestoreCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  let fixtureSamples: TableLifecycleFixtureSample[] = [];
  const setupSamples: RestoreSetupSample[] = [];
  const requestSamples: TableLifecycleRequestSample[] = [];
  const verifySamples: RestoreVerifySample[] = [];

  const restoreArchivedSample = async (
    sample: TableLifecycleFixtureSample,
    trashLookup: TableTrashLookup,
  ) => {
    const sampleLabel = formatTableLifecycleSample(sample.iteration);
    await withPerfTraceStep(
      context,
      perfCase,
      `cleanupRestoreTable-${sampleLabel}`,
      () => restoreTableTrash(trashLookup.trashId),
    );
    await waitForRowsRestored(sample.fixture, config);
  };

  try {
    fixtureSamples = await prepareTableLifecycleFixtures(
      baseId,
      config,
      perfCase,
      "table-restore",
    );

    try {
      for (const sample of fixtureSamples) {
        const sampleLabel = formatTableLifecycleSample(sample.iteration);
        const setupMeasurement = await withPerfTraceStep(
          context,
          perfCase,
          `deleteSetup-${sampleLabel}`,
          () =>
            measureAsync(`deleteSetup-${sampleLabel}`, async () => {
              const archive = await archiveTable(
                baseId,
                sample.fixture.tableId,
              );
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
        setupSamples.push({
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
        requestSamples.push(
          buildTableLifecycleSampleResult(
            sample.iteration,
            sample.fixture,
            requestMeasurement,
            "restoreTable",
            trashLookup,
          ),
        );

        const verifyMeasurement = await withPerfTraceStep(
          context,
          perfCase,
          `restoreTableVerify-${sampleLabel}`,
          () =>
            measureAsync(`restoreTableVerify-${sampleLabel}`, async () => {
              const fullScan = await waitForRowsRestored(
                sample.fixture,
                config,
                {
                  timeoutMs: 60_000,
                  pollIntervalMs: 1_000,
                },
              );
              const samples = await assertSampleTextValues(
                sample.fixture,
                config,
              );
              return { fullScan, samples };
            }),
        );
        verifySamples.push({
          iteration: sample.iteration,
          measurement: verifyMeasurement,
          result: verifyMeasurement.result as RestoreVerifySample["result"],
        });
      }
    } catch (error) {
      throw new PerfRunDiagnosticError(
        error instanceof Error ? error.message : String(error),
        buildTableLifecycleSamplesResult({
          config,
          runner: "table-restore",
          fixtureSamples,
          setupSamples,
          requestSamples,
          verifySamples,
          error,
        }),
      );
    }

    return buildTableLifecycleSamplesResult({
      config,
      runner: "table-restore",
      fixtureSamples,
      setupSamples,
      requestSamples,
      verifySamples,
      details: {
        fullScans: verifySamples.map((sample) => ({
          iteration: sample.iteration,
          fullScan: sample.result.fullScan,
        })),
        verifiedSamples: verifySamples.map((sample) => ({
          iteration: sample.iteration,
          samples: sample.result.samples.verifiedSamples,
        })),
        verification: {
          metric: "verifyMs",
          checks: ["fullRowCountScan", "sampleTextValues(Title,External ID)"],
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
        const setupSample = setupSamples.find(
          (item) => item.iteration === sample.iteration,
        );
        const verifiedAfterRestore = Boolean(
          verifySamples.find((item) => item.iteration === sample.iteration),
        );
        let tableIsSeedReady = !setupSample || verifiedAfterRestore;

        if (!tableIsSeedReady && setupSample && !requestSample) {
          try {
            await restoreArchivedSample(sample, setupSample.trashLookup);
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
    }
  }
};

export const seedTableRestoreCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedTableLifecycleCase(perfCase, context, "table-restore");
