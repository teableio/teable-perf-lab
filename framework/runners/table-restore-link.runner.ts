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
  assertSampleTextValues,
  assertTableNotListed,
  buildTableLifecycleSampleResult,
  formatTableLifecycleSample,
  restoreTableTrash,
  type TableLifecycleVerifySample,
  type TableTrashLookup,
  waitForTableTrashId,
} from "./table-lifecycle.shared";
import { runTableLinkSamplesLifecycle } from "./table-link-lifecycle";
import {
  assertLinkCellSamples,
  buildLinkFixtureSeedDetails,
  permanentDeleteLinkFixture,
  seedTableLinkLifecycleCase,
  type TableLinkFixture,
  type TableLinkFixtureSample,
  type TableLinkLifecycleCaseConfig,
} from "./table-lifecycle-link.shared";

type RestoreSetupSample = TableLifecycleVerifySample & {
  trashLookup: TableTrashLookup;
};

type RestoreLinkLifecycleState = {
  setupSamples: RestoreSetupSample[];
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
  config: TableLinkLifecycleCaseConfig;
  sample: TableLinkFixtureSample;
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

export const runTableRestoreLinkCase = async (
  perfCase: PerfCaseFor<"table-restore-link">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runTableLinkSamplesLifecycle<RestoreLinkLifecycleState>(perfCase, context, {
    runner: "table-restore-link",
    resultRunner: "table-restore",
    reuseFixtureAcrossSamples: true,
    includeSetupSamples: true,
    createState: () => ({ setupSamples: [] }),
    buildDetails: ({ state, error }): Record<string, unknown> => ({
      runner: "table-restore-link",
      ...buildLinkFixtureSeedDetails(state.fixtureSamples),
      ...(error
        ? {}
        : {
            verification: {
              metric: "verifyMs",
              checks: [
                "fullRowCountScan",
                "sampleTextValues(Title,External ID)",
                "linkCellSamples(permuted foreign Key titles)",
              ],
              participatesInThreshold: false,
              samples: state.verifySamples.map((sample) => {
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
          }),
    }),
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
            const trashLookup = await waitForTableTrashId(
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
            const textSamples = await assertSampleTextValues(
              sample.fixture,
              config,
            );
            // The data-scaling evidence: every sampled link cell still resolves
            // to its permuted foreign row after the restore.
            const linkSamples = await assertLinkCellSamples(
              sample.fixture,
              config,
            );
            return { fullScan, textSamples, linkSamples };
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

      const deletedTableIds = new Set<string>();
      for (const sample of state.executionSamples) {
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

        if (
          !(tableIsSeedReady && sample.fixture.reusableSeed) &&
          !deletedTableIds.has(sample.fixture.tableId)
        ) {
          await permanentDeleteLinkFixture(
            baseId,
            sample.fixture as TableLinkFixture,
          );
          deletedTableIds.add(sample.fixture.tableId);
        }
      }
    },
  });

export const seedTableRestoreLinkCase = async (
  perfCase: PerfCaseFor<"table-restore-link">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedTableLinkLifecycleCase(perfCase, context, "table-restore-link");
