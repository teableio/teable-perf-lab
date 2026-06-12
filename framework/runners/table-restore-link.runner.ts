import { isExecuteDbIsolated } from "../env";
import { measureAsync } from "../metrics";
import { withPerfTraceStep } from "../trace-collector";
import type { PerfCase, PerfRunContext, PerfRunResult } from "../types";
import { PerfRunDiagnosticError } from "../types";
import { waitForRowsRestored } from "./record-undo-redo.shared";
import {
  archiveTable,
  assertSampleTextValues,
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
  permanentDeleteLinkFixture,
  prepareTableLinkFixtures,
  seedTableLinkLifecycleCase,
  type TableLinkFixture,
  type TableLinkFixtureSample,
  type TableLinkLifecycleCaseConfig,
} from "./table-lifecycle-link.shared";

type RestoreSetupSample = TableLifecycleVerifySample & {
  trashLookup: TableTrashLookup;
};

export const runTableRestoreLinkCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> => {
  const config = perfCase.config as TableLinkLifecycleCaseConfig;
  const baseId = globalThis.testConfig.baseId;
  let fixtureSamples: TableLinkFixtureSample[] = [];
  const setupSamples: RestoreSetupSample[] = [];
  const requestSamples: TableLifecycleRequestSample[] = [];
  const verifySamples: TableLifecycleVerifySample[] = [];

  const restoreArchivedSample = async (
    sample: TableLinkFixtureSample,
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
    fixtureSamples = await prepareTableLinkFixtures(
      baseId,
      config,
      perfCase,
      "table-restore-link",
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
              const fullScan = await waitForRowsRestored(
                sample.fixture,
                config,
                {
                  timeoutMs: 60_000,
                  pollIntervalMs: 1_000,
                },
              );
              const textSamples = await assertSampleTextValues(
                sample.fixture,
                config,
              );
              // The data-scaling evidence: every sampled link cell still
              // resolves to its permuted foreign row after the restore.
              const linkSamples = await assertLinkCellSamples(
                sample.fixture,
                config,
              );
              return { fullScan, textSamples, linkSamples };
            }),
        );
        verifySamples.push({
          iteration: sample.iteration,
          measurement: verifyMeasurement,
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
          details: {
            runner: "table-restore-link",
            ...buildLinkFixtureSeedDetails(fixtureSamples),
          },
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
        runner: "table-restore-link",
        ...buildLinkFixtureSeedDetails(fixtureSamples),
        verification: {
          metric: "verifyMs",
          checks: [
            "fullRowCountScan",
            "sampleTextValues(Title,External ID)",
            "linkCellSamples(permuted foreign Key titles)",
          ],
          participatesInThreshold: false,
          samples: verifySamples.map((sample) => {
            const result = sample.measurement.result as {
              fullScan?: unknown;
              textSamples?: unknown;
              linkSamples?: unknown;
            };
            return {
              iteration: sample.iteration,
              verifyMs: sample.measurement.durationMs,
              fullScan: result.fullScan,
              textSamples: result.textSamples,
              linkSamples: result.linkSamples,
            };
          }),
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
        const verifiedAfterRestore = verifySamples.some(
          (item) => item.iteration === sample.iteration,
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
          await permanentDeleteLinkFixture(
            baseId,
            sample.fixture as TableLinkFixture,
          );
        }
      }
    }
  }
};

export const seedTableRestoreLinkCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedTableLinkLifecycleCase(perfCase, context, "table-restore-link");
